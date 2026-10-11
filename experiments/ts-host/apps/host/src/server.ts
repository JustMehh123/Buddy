import { createServer, type IncomingMessage, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express, type Request, type Response } from 'express';
import QRCode from 'qrcode';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  DEFAULT_SETTINGS,
  PROTOCOL_VERSION,
  isPhoneAction,
  type HostEvent,
  type HostEventMap,
  type HostEventType,
  type OverlayEvent,
  type OverlayEventMap,
  type OverlayEventType,
  type PhoneAction
} from '@buddy/protocol';
import type { BuddyHost } from './host.js';
import type { Logger } from './util/logger.js';
import { formatCode, PAIRING_WINDOW_MS } from './util/tokens.js';
import { BUDDY_VERSION } from './config.js';

/**
 * The two sockets and the HTTP API.
 *
 *   /ws        the phone's live link  (events down, actions up)
 *   /overlay   the desktop shell      (draw my cursor, show my face)
 *   /api/*     everything that isn't a stream: pairing, voice credentials,
 *              the local voice pipeline, settings, memory, diagnostics
 *
 * The phone app is served from here too, so there is nothing to install on the
 * phone: open the address, add it to the home screen, done.
 */

export interface ServerOptions {
  host: BuddyHost;
  logger: Logger;
  port: number;
  /** Directory holding the built phone apps, if they were built. */
  webDir?: string;
  mobileDir?: string;
  /** Open http instead of https (only used when TLS is deliberately off). */
  openBrowser?: boolean;
}

interface SocketInfo {
  socket: WebSocket;
  deviceId: string;
  deviceName: string;
  isAlive: boolean;
  lastSeq: number;
}

export class BuddyServer {
  readonly app: Express;
  private readonly server: Server;
  private readonly phoneSockets = new WebSocketServer({ noServer: true });
  private readonly overlaySockets = new WebSocketServer({ noServer: true });
  private readonly sockets = new Map<WebSocket, SocketInfo>();
  private readonly overlays = new Set<WebSocket>();
  private readonly host: BuddyHost;
  private readonly logger: Logger;
  private readonly port: number;
  private readonly webDir?: string;
  private readonly mobileDir?: string;

  constructor(options: ServerOptions) {
    this.host = options.host;
    this.logger = options.logger;
    this.port = options.port;
    this.webDir = options.webDir;
    this.mobileDir = options.mobileDir;
    this.app = express();
    this.server = createServer(this.app);

    this.setupHttp();
    this.setupUpgrade();
    this.bridgeHostEvents();
  }

  async listen(): Promise<number> {
    await new Promise<void>((resolve) => this.server.listen(this.port, '0.0.0.0', resolve));
    const address = this.server.address();
    const actual = typeof address === 'object' && address ? address.port : this.port;
    return actual;
  }

  async close(): Promise<void> {
    for (const socket of this.sockets.keys()) socket.close();
    for (const socket of this.overlays) socket.close();
    this.sockets.clear();
    this.overlays.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Push an event to every connected phone. */
  broadcast(event: HostEvent, exceptDevice?: string): void {
    const payload = JSON.stringify(event);
    for (const [socket, info] of this.sockets) {
      if (exceptDevice && info.deviceId === exceptDevice) continue;
      if (socket.readyState !== socket.OPEN) continue;
      try {
        socket.send(payload);
      } catch (error) {
        this.logger.warn('failed to write to a phone socket', error);
      }
    }
  }

  get connectedPhones(): number {
    return [...this.sockets.values()].filter((info) => info.socket.readyState === info.socket.OPEN).length;
  }

  get connectedOverlays(): number {
    return this.overlays.size;
  }

  // ── HTTP ─────────────────────────────────────────────────────────────────

  private setupHttp(): void {
    const app = this.app;
    app.disable('x-powered-by');
    app.use(express.json({ limit: '25mb' }));
    // Raw bodies for audio uploads from the phone.
    app.use('/api/stt', express.raw({ type: ['audio/*', 'application/octet-stream'], limit: '30mb' }));

    app.use((request, response, next) => {
      response.setHeader('access-control-allow-origin', '*');
      response.setHeader('access-control-allow-headers', 'authorization,content-type');
      response.setHeader('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS');
      if (request.method === 'OPTIONS') return response.sendStatus(204);
      next();
    });

    app.get('/api/health', (_request, response) => {
      response.json({
        ok: true,
        name: 'Buddy',
        version: BUDDY_VERSION,
        protocol: PROTOCOL_VERSION,
        host: this.host.identity,
        simulated: this.host.computerHandle.simulated,
        note: this.host.computerHandle.note,
        phones: this.connectedPhones,
        overlays: this.connectedOverlays,
        providers: this.host.registry.all.map((provider) => ({
          id: provider.id,
          label: provider.label,
          capabilities: provider.capabilities
        }))
      });
    });

    // ── Pairing ────────────────────────────────────────────────────────────
    app.post('/api/pair/start', (request, response) => {
      const deviceName = typeof request.body?.deviceName === 'string' ? request.body.deviceName : 'a phone';
      const challenge = this.host.startPairing(deviceName);
      this.logger.info(`pairing window open — code ${formatCode(challenge.code)}`);
      response.json({
        code: challenge.code,
        expiresAt: challenge.createdAt + PAIRING_WINDOW_MS,
        host: this.host.identity
      });
    });

    app.post('/api/pair', async (request, response) => {
      const deviceId = String(request.body?.deviceId ?? '');
      const deviceName = String(request.body?.deviceName ?? 'Phone');
      const code = typeof request.body?.code === 'string' ? request.body.code : undefined;
      if (!deviceId) return response.status(400).json({ error: 'A deviceId is required.' });

      const result = await this.host.completePairing({ deviceId, deviceName, code });
      if ('error' in result) return response.status(403).json(result);
      this.logger.info(`phone paired: ${deviceName}`);
      return response.json(result);
    });

    app.get('/api/pair/qr', async (_request, response) => {
      const url = `http://${this.host.identity.hostname}.local:${this.port}/`;
      try {
        const png = await QRCode.toBuffer(url, {
          margin: 1,
          width: 512,
          color: { dark: '#101322', light: '#ffffff' }
        });
        response.type('png').send(png);
      } catch (error) {
        response.status(500).json({ error: 'could not draw the QR code' });
      }
    });

    // ── Session ────────────────────────────────────────────────────────────
    // A paired phone asks for fresh voice credentials. One-shot token, so this
    // can be called as often as the session needs restarting.
    app.post('/api/session', async (request, response) => {
      const device = this.authenticate(request);
      if (!device) return response.status(401).json({ error: 'not paired' });
      try {
        const live = await this.host.mintLiveCredentials(request.body?.session ?? {});
        this.host.recordSession(device.id);
        return response.json({
          live,
          settings: this.host.settings,
          host: this.host.identity,
          memories: this.host.settings.memoryEnabled ? this.host.memories.digest(20) : []
        });
      } catch (error) {
        return response.status(503).json({
          error: error instanceof Error ? error.message : 'no voice provider',
          fallback: 'local'
        });
      }
    });

    // The SDP relay, for browsers that can't post cross-origin to OpenAI.
    app.post('/api/live/sdp', async (request, response) => {
      const device = this.authenticate(request);
      if (!device) return response.status(401).json({ error: 'not paired' });
      const clientSecret = String(request.body?.clientSecret ?? '');
      const sdp = String(request.body?.sdp ?? '');
      const callsUrl = String(request.body?.callsUrl ?? 'https://api.openai.com/v1/realtime/calls');
      if (!clientSecret || !sdp) return response.status(400).json({ error: 'clientSecret and sdp are required' });
      try {
        const upstream = await fetch(callsUrl, {
          method: 'POST',
          headers: { authorization: `Bearer ${clientSecret}`, 'content-type': 'application/sdp' },
          body: sdp
        });
        const text = await upstream.text();
        if (!upstream.ok) return response.status(upstream.status).send(text);
        return response.type('text/plain').send(text);
      } catch (error) {
        return response.status(502).json({ error: error instanceof Error ? error.message : 'relay failed' });
      }
    });

    // ── Actions ────────────────────────────────────────────────────────────
    app.post('/api/action', async (request, response) => {
      const device = this.authenticate(request);
      if (!device) return response.status(401).json({ error: 'not paired' });
      const { tool, args } = request.body ?? {};
      if (typeof tool !== 'string') return response.status(400).json({ error: 'tool is required' });
      const result = await this.host.runTool(tool as never, args ?? {}, device.id);
      return response.json(result);
    });

    app.post('/api/confirm', (request, response) => {
      const device = this.authenticate(request);
      if (!device) return response.status(401).json({ error: 'not paired' });
      const resolved = this.host.resolveConfirmation({
        id: String(request.body?.id ?? ''),
        token: String(request.body?.token ?? ''),
        approved: request.body?.approved !== false
      });
      return response.json({ ok: resolved });
    });

    // ── The local voice pipeline ───────────────────────────────────────────
    // Used when there's no realtime provider, or when the user prefers it:
    // on-device speech in, chat here, on-device speech out.
    app.post('/api/chat', async (request, response) => {
      const device = this.authenticate(request);
      if (!device) return response.status(401).json({ error: 'not paired' });
      const messages = Array.isArray(request.body?.messages) ? request.body.messages : [];
      const stream = request.body?.stream !== false;
      const chatters = this.host.registry.chatters();
      if (!chatters.length) {
        return response.status(503).json({
          error:
            'No AI provider is configured. Add a free Gemini key (aistudio.google.com/apikey) or a free Groq key (console.groq.com/keys).'
        });
      }

      if (!stream) {
        try {
          const result = await this.host.registry.run(
            chatters,
            (provider) =>
              provider.chat({
                messages: toProviderMessages(messages),
                tools: this.host.buildSessionConfig().tools,
                purpose: 'chat'
              }),
            { label: 'Thinking' }
          );
          return response.json({ text: result.text, toolCalls: result.toolCalls, provider: result.provider });
        } catch (error) {
          return response.status(503).json({ error: error instanceof Error ? error.message : 'chat failed' });
        }
      }

      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      });
      const send = (event: string, data: unknown) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      send('open', { provider: chatters[0]!.id });

      try {
        const provider = chatters[0]!;
        if (provider.chatStream) {
          let full = '';
          for await (const chunk of provider.chatStream({
            messages: toProviderMessages(messages),
            tools: this.host.buildSessionConfig().tools,
            purpose: 'chat'
          })) {
            full += chunk;
            send('delta', { text: chunk });
          }
          send('done', { text: full });
        } else {
          const result = await provider.chat({
            messages: toProviderMessages(messages),
            tools: this.host.buildSessionConfig().tools
          });
          send('delta', { text: result.text });
          send('done', { text: result.text });
        }
      } catch (error) {
        send('error', { message: error instanceof Error ? error.message : 'chat failed' });
      } finally {
        response.end();
      }
    });

    // Speech in. The phone normally uses on-device recognition, but this is the
    // accurate fallback (and what makes longer dictation work well).
    app.post('/api/stt', async (request, response) => {
      const device = this.authenticate(request);
      if (!device) return response.status(401).json({ error: 'not paired' });
      const audio = Buffer.isBuffer(request.body) ? request.body : Buffer.from(request.body ?? '');
      if (!audio.length) return response.status(400).json({ error: 'no audio' });
      const mimeType = request.headers['content-type'] ?? 'audio/wav';
      const candidates = this.host.registry.transcribers();
      if (!candidates.length) return response.status(503).json({ error: 'no transcription provider configured' });
      try {
        const result = await this.host.registry.run(
          candidates,
          (provider) =>
            provider.transcribe!({
              audio,
              mimeType,
              prompt: 'Short spoken commands to a computer companion. Expect app names, file names and screen text.'
            }),
          { label: 'Transcribing' }
        );
        return response.json({ text: result.text, provider: result.provider });
      } catch (error) {
        return response.status(503).json({ error: error instanceof Error ? error.message : 'transcription failed' });
      }
    });

    // Speech out, for the nicer voices (and for browsers with nothing local).
    app.post('/api/tts', async (request, response) => {
      const device = this.authenticate(request);
      if (!device) return response.status(401).json({ error: 'not paired' });
      const text = String(request.body?.text ?? '').slice(0, 2000);
      if (!text) return response.status(400).json({ error: 'text is required' });
      const speakers = this.host.registry.speakers();
      if (!speakers.length) return response.status(503).json({ error: 'no speech provider configured' });
      try {
        const result = await this.host.registry.run(
          speakers,
          (provider) =>
            provider.speak!({
              text,
              voice: request.body?.voice ?? this.host.settings.voice,
              format: 'mp3'
            }),
          { label: 'Speaking' }
        );
        response.type(result.mimeType.split(';')[0]!);
        return response.send(result.audio);
      } catch (error) {
        return response.status(503).json({ error: error instanceof Error ? error.message : 'speech failed' });
      }
    });

    // ── State, settings, memory ────────────────────────────────────────────
    app.get('/api/state', (request, response) => {
      const device = this.authenticate(request);
      if (!device) return response.status(401).json({ error: 'not paired' });
      response.json({
        host: this.host.identity,
        settings: this.host.settings,
        face: this.host.face.snapshot(),
        memories: this.host.settings.memoryEnabled ? this.host.memories.all() : [],
        pending: this.host.pendingConfirmations,
        note: this.host.computerHandle.note,
        simulated: this.host.computerHandle.simulated,
        permissions: this.host.computerHandle.permissions?.() ?? null,
        providers: this.host.registry.all.map((provider) => ({
          id: provider.id,
          label: provider.label,
          capabilities: provider.capabilities
        }))
      });
    });

    app.patch('/api/settings', (request, response) => {
      const device = this.authenticate(request);
      if (!device) return response.status(401).json({ error: 'not paired' });
      const patch = request.body ?? {};
      const allowed = Object.keys(DEFAULT_SETTINGS) as (keyof typeof DEFAULT_SETTINGS)[];
      const clean: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(patch)) {
        if (allowed.includes(key as keyof typeof DEFAULT_SETTINGS)) clean[key] = value;
      }
      response.json(this.host.updateSettings(clean));
    });

    app.get('/api/memory', (request, response) => {
      const device = this.authenticate(request);
      if (!device) return response.status(401).json({ error: 'not paired' });
      const query = typeof request.query.q === 'string' ? request.query.q : '';
      response.json({
        memories: query ? this.host.memories.search(query, { limit: 25 }) : this.host.memories.all(),
        stats: this.host.memories.stats()
      });
    });

    app.post('/api/memory', (request, response) => {
      const device = this.authenticate(request);
      if (!device) return response.status(401).json({ error: 'not paired' });
      const text = String(request.body?.text ?? '').trim();
      if (!text) return response.status(400).json({ error: 'text is required' });
      const memory = this.host.memories.add({
        text,
        kind: request.body?.kind ?? 'fact',
        tags: Array.isArray(request.body?.tags) ? request.body.tags.map(String) : undefined,
        importance: typeof request.body?.importance === 'number' ? request.body.importance : undefined,
        source: 'manual'
      });
      response.json(memory);
    });

    app.delete('/api/memory/:id', (request, response) => {
      const device = this.authenticate(request);
      if (!device) return response.status(401).json({ error: 'not paired' });
      response.json({ ok: this.host.memories.remove(request.params.id) });
    });

    // A quick look for the phone: downscaled, and only when asked for.
    app.get('/api/screen', async (request, response) => {
      const device = this.authenticate(request);
      if (!device) return response.status(401).json({ error: 'not paired' });
      try {
        const read = await this.host.vision.read('A quick look for the phone screen peek.', {
          region: 'full',
          detail: 'quick',
          withScreenshot: true
        });
        response.json({
          screenshot: read.screenshots[0] ?? null,
          summary: read.summary,
          app: read.app,
          at: read.at
        });
      } catch (error) {
        response.status(503).json({ error: error instanceof Error ? error.message : 'screen grab failed' });
      }
    });

    app.get('/api/logs', (request, response) => {
      const device = this.authenticate(request);
      if (!device) return response.status(401).json({ error: 'not paired' });
      response.json({ entries: this.logger.tail(60) });
    });

    app.get('/api/diagnostics', async (request, response) => {
      const device = this.authenticate(request);
      if (!device) return response.status(401).json({ error: 'not paired' });
      const providers = await this.host.registry.health();
      response.json({
        version: BUDDY_VERSION,
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        simulated: this.host.computerHandle.simulated,
        note: this.host.computerHandle.note,
        permissions: this.host.computerHandle.permissions?.() ?? null,
        providers,
        settings: this.host.settings,
        stats: this.host.status().stats,
        logs: this.logger.tail(30)
      });
    });

    // ── The phone app itself ───────────────────────────────────────────────
    // Installed-to-home-screen is just a web page, so it lives here.
    app.get('/manifest.webmanifest', (request, response) => {
      const name = this.host.settings.name || 'Buddy';
      response.type('application/manifest+json').json({
        name: `${name} — computer companion`,
        short_name: name.slice(0, 12),
        description: 'Your little companion. Talks on your phone, sees and does on your computer.',
        start_url: `/?host=${encodeURIComponent(this.host.identity.id)}`,
        scope: '/',
        display: 'standalone',
        orientation: 'any',
        background_color: '#0b0d17',
        theme_color: '#0b0d17',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icon-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      });
    });

    // A tiny bit of "install me" guidance, because iOS hides it well.
    app.get('/pair', async (request, response) => {
      const challenge = this.host.pendingPairing ?? this.host.startPairing('a phone');
      const address = `http://${this.host.identity.hostname}.local:${this.port}/`;
      response.type('html').send(pairingPage({
        name: this.host.settings.name || 'Buddy',
        hostName: this.host.identity.name,
        code: formatCode(challenge.code),
        address,
        simulated: this.host.computerHandle.simulated,
        note: this.host.computerHandle.note
      }));
    });

    const staticTargets: [string, string | undefined][] = [
      ['/', this.webDir],
      ['/phone', this.mobileDir ?? this.webDir]
    ];
    for (const [route, dir] of staticTargets) {
      if (!dir || !existsSync(dir)) continue;
      this.app.use(route, express.static(dir, { index: 'index.html', maxAge: '1h' }));
    }

    // Any other path falls back to the phone app (it's a single page).
    this.app.get('*', (request, response, next) => {
      if (request.path.startsWith('/api/')) return next();
      const dir = this.webDir;
      if (dir && existsSync(join(dir, 'index.html'))) {
        return response.sendFile(join(dir, 'index.html'));
      }
      return response
        .type('html')
        .send(
          `<body style="font-family:system-ui;background:#0b0d17;color:#e6e8f5;padding:3rem;line-height:1.6">
            <h1 style="margin:0 0 .5rem">Buddy is running</h1>
            <p>The phone app hasn't been built yet. Run <code style="background:#1b2033;padding:.15rem .4rem;border-radius:.3rem">npm run build</code> at the repo root, then reload.</p>
            <p>Pairing: <a style="color:#8fa6ff" href="/pair">/pair</a></p>
          </body>`
        );
    });
  }

  // ── Sockets ──────────────────────────────────────────────────────────────

  private setupUpgrade(): void {
    this.server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

      if (url.pathname === '/overlay') {
        this.overlaySockets.handleUpgrade(request, socket as never, head, (websocket) => {
          this.overlaySockets.emit('connection', websocket, request);
          this.attachOverlay(websocket);
        });
        return;
      }

      if (url.pathname !== '/ws') {
        socket.destroy();
        return;
      }

      const token = url.searchParams.get('token') ?? request.headers.authorization?.replace(/^Bearer\s+/i, '');
      const device = this.host.findDevice(token);
      if (!device) {
        this.logger.warn('rejected a phone socket with an unknown token');
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }

      this.phoneSockets.handleUpgrade(request, socket as never, head, (websocket) => {
        this.phoneSockets.emit('connection', websocket, request);
        this.attachPhone(websocket, device.id, device.name);
      });
    });
  }

  private attachPhone(socket: WebSocket, deviceId: string, deviceName: string): void {
    const info: SocketInfo = { socket, deviceId, deviceName, isAlive: true, lastSeq: 0 };
    this.sockets.set(socket, info);
    this.logger.info(`${deviceName} connected (${this.connectedPhones} phone${this.connectedPhones === 1 ? '' : 's'})`);
    this.host.recordSession(deviceId);

    socket.on('message', (raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (!isPhoneAction(parsed)) return;
      void this.handlePhoneAction(socket, info, parsed);
    });

    socket.on('pong', () => {
      info.isAlive = true;
    });

    socket.on('close', () => {
      this.sockets.delete(socket);
      this.logger.info(`${deviceName} disconnected`);
    });

    // Say hello with everything the phone needs to draw itself.
    this.send(socket, {
      type: 'host.info',
      payload: this.host.identity,
      at: Date.now()
    });
    this.send(socket, { type: 'settings.changed', payload: this.host.settings, at: Date.now() });
    this.send(socket, {
      type: 'memory.changed',
      payload: this.host.settings.memoryEnabled ? this.host.memories.all() : [],
      at: Date.now()
    });
    this.send(socket, { type: 'face.state', payload: this.host.face.snapshot(), at: Date.now() });
    for (const confirmation of this.host.pendingConfirmations) {
      this.send(socket, { type: 'confirmation.request', payload: confirmation, at: Date.now() });
    }
  }

  private async handlePhoneAction(socket: WebSocket, info: SocketInfo, action: PhoneAction): Promise<void> {
    const send = (type: HostEventType, payload: unknown) =>
      this.send(socket, { type, payload, at: Date.now() } as HostEvent);

    try {
      switch (action.type) {
        case 'ping':
          send('pong', { at: Date.now(), echo: (action.payload as { at?: number })?.at });
          break;

        case 'get.state':
          this.send(socket, { type: 'host.info', payload: this.host.identity, at: Date.now() });
          this.send(socket, { type: 'settings.changed', payload: this.host.settings, at: Date.now() });
          this.send(socket, {
            type: 'memory.changed',
            payload: this.host.settings.memoryEnabled ? this.host.memories.all() : [],
            at: Date.now()
          });
          this.send(socket, { type: 'face.state', payload: this.host.face.snapshot(), at: Date.now() });
          break;

        case 'action.request': {
          const payload = action.payload as { tool: string; args?: Record<string, unknown>; id?: string };
          this.host.noteActivity();
          const result = await this.host.runner.run({
            tool: payload.tool as never,
            args: payload.args ?? {},
            deviceId: info.deviceId,
            id: payload.id
          });
          this.send(socket, { type: 'action.finished', payload: result, at: Date.now() });
          break;
        }

        case 'action.confirm': {
          const payload = action.payload as { id: string; token: string; approved: boolean };
          this.host.resolveConfirmation({ ...payload, id: payload.id });
          break;
        }

        case 'action.cancel':
          this.host.runner.cancel();
          this.send(socket, { type: 'toast', payload: { text: 'Stopped.', kind: 'warn' }, at: Date.now() });
          break;

        case 'face.update':
          this.host.face.applyRemote(action.payload as never);
          break;

        case 'face.gesture': {
          const gesture = (action.payload as { gesture: string }).gesture;
          this.host.face.gesture(gesture as never);
          this.host.noteActivity();
          break;
        }

        case 'settings.update':
          this.host.updateSettings(action.payload as never);
          break;

        case 'memory.add': {
          const payload = action.payload as { text: string; kind?: string; tags?: string[] };
          const memory = this.host.memories.add({
            text: payload.text,
            kind: payload.kind as never,
            tags: payload.tags,
            source: 'manual'
          });
          this.send(socket, { type: 'toast', payload: { text: 'Saved.', kind: 'success' }, at: Date.now() });
          void memory;
          break;
        }

        case 'memory.delete':
          this.host.memories.remove((action.payload as { id: string }).id);
          break;

        case 'memory.clear':
          this.host.memories.clear();
          break;

        case 'session.token': {
          try {
            const live = await this.host.mintLiveCredentials((action.payload as { session?: never }).session ?? {});
            this.host.recordSession(info.deviceId);
            this.send(socket, { type: 'toast', payload: { text: 'Voice session ready.', kind: 'info' }, at: Date.now() });
            // Tokens are secrets; they travel over the socket, never the buffer.
            socket.send(JSON.stringify({ type: 'session.credentials', payload: live, at: Date.now() }));
          } catch (error) {
            this.send(socket, {
              type: 'error',
              payload: {
                message: error instanceof Error ? error.message : 'No voice provider available.',
                code: 'no-live'
              },
              at: Date.now()
            });
          }
          break;
        }

        case 'session.log': {
          const payload = action.payload as Record<string, unknown>;
          this.logger.debug(`phone: ${JSON.stringify(payload).slice(0, 400)}`);
          break;
        }

        default:
          this.logger.debug(`unhandled phone action ${String(action.type)}`);
      }
    } catch (error) {
      this.logger.error(`phone action ${String(action.type)} failed`, error);
      send('error', { message: error instanceof Error ? error.message : 'that action failed' });
    }
  }

  private attachOverlay(socket: WebSocket): void {
    this.overlays.add(socket);
    this.logger.info(`desktop overlay connected (${this.overlays.size})`);

    socket.on('message', (raw) => {
      let parsed: OverlayEvent;
      try {
        parsed = JSON.parse(String(raw)) as OverlayEvent;
      } catch {
        return;
      }
      if (parsed?.type === 'overlay.hello') {
        const hello = parsed.payload as { platform?: string; displays?: unknown[]; version?: string };
        this.logger.info(
          `overlay says hello: ${hello.platform ?? 'unknown'}, ${hello.displays?.length ?? 0} display(s)`
        );
      }
    });

    socket.on('close', () => {
      this.overlays.delete(socket);
      this.logger.info('desktop overlay disconnected');
    });

    // Bring the shell up to date: screens, settings, then the current face.
    void this.sendOverlayHello(socket);
    this.sendOverlay(socket, 'overlay.settings', {
      overlay: this.host.settings.overlay,
      cursorSpeed: this.host.settings.cursorSpeed
    });
    this.sendOverlay(socket, 'overlay.face', { state: this.host.face.snapshot(), pointer: null });
  }

  private async sendOverlayHello(socket: WebSocket): Promise<void> {
    try {
      const displays = await this.host.computerHandle.computer.displays();
      this.sendOverlay(socket, 'overlay.displays', { displays });
    } catch {
      /* the shell can ask again */
    }
  }

  private sendOverlay<T extends OverlayEventType>(socket: WebSocket, type: T, payload: OverlayEventMap[T]): void {
    if (socket.readyState !== socket.OPEN) return;
    try {
      socket.send(JSON.stringify({ type, payload, at: Date.now() }));
    } catch {
      /* the close handler will tidy up */
    }
  }

  private bridgeHostEvents(): void {
    // Every host event goes to every phone. The buffer in the host already
    // handles reconnects; this just fans out live.
    const forward = <T extends HostEventType>(type: T) => {
      this.host.onEvent(type, (event) => {
        if (type === 'face.state') {
          // Face frames are high-rate; only send when something moved visibly.
          const state = event.payload as { mood: string; blink: number };
          if (state.mood === 'idle' && state.blink === 0 && Math.random() > 0.15) return;
        }
        this.broadcast(event as HostEvent);
      });
    };

    (
      [
        'face.state',
        'face.status',
        'host.info',
        'settings.changed',
        'memory.changed',
        'action.started',
        'action.finished',
        'confirmation.request',
        'confirmation.resolved',
        'caption',
        'toast',
        'error',
        'screen.frame'
      ] as const
    ).forEach(forward);

    this.host.onOverlay((event) => {
      const payload = JSON.stringify(event);
      for (const socket of this.overlays) {
        if (socket.readyState === socket.OPEN) {
          try {
            socket.send(payload);
          } catch {
            /* dropped connection; close will clean up */
          }
        }
      }
    });

    // Keepalive: phones sleep, and a half-open socket is worse than none.
    setInterval(() => {
      for (const [socket, info] of this.sockets) {
        if (!info.isAlive) {
          socket.terminate();
          this.sockets.delete(socket);
          continue;
        }
        info.isAlive = false;
        try {
          socket.ping();
        } catch {
          /* ignore */
        }
      }
    }, 25_000).unref?.();
  }

  private send(socket: WebSocket, event: HostEvent): void {
    if (socket.readyState !== socket.OPEN) return;
    try {
      socket.send(JSON.stringify(event));
    } catch (error) {
      this.logger.warn('socket write failed', error);
    }
  }

  private authenticate(request: Request): { id: string } | null {
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : (request.query.token as string | undefined);
    const device = this.host.findDevice(token ?? null);
    return device ? { id: device.id } : null;
  }
}

const toProviderMessages = (messages: unknown[]): import('./providers/types.js').ChatMessage[] =>
  messages
    .filter((message): message is { role: string; content: string } =>
      Boolean(message && typeof message === 'object' && 'role' in message && 'content' in message)
    )
    .map((message) => ({
      role: (['system', 'user', 'assistant', 'tool'].includes(message.role)
        ? message.role
        : 'user') as 'system' | 'user' | 'assistant' | 'tool',
      content: String(message.content ?? '')
    }));

/** The little page the QR code points at. */
const pairingPage = (options: {
  name: string;
  hostName: string;
  code: string;
  address: string;
  simulated: boolean;
  note: string;
}): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${options.name} — call me over</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:#0b0d17; color:#e8ebff;
         font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif; }
  .card { width:min(46rem,92vw); padding:2.5rem; border-radius:1.75rem; background:#141a2c;
          box-shadow:0 30px 80px rgba(0,0,0,.45); }
  h1 { margin:0 0 .25rem; font-size:1.9rem; }
  .sub { color:#98a2c6; margin:0 0 1.75rem; }
  .row { display:flex; gap:2rem; align-items:center; flex-wrap:wrap; }
  .code { font:700 3rem/1 ui-monospace,SFMono-Regular,Menlo,monospace; letter-spacing:.35rem; color:#9fe8ff; }
  .label { text-transform:uppercase; font-size:.7rem; letter-spacing:.14em; color:#7f8ab3; margin-bottom:.5rem; }
  ol { margin:1.5rem 0 0; padding-left:1.25rem; color:#c3cbe8; line-height:1.7; }
  code { background:#1d2438; padding:.15rem .45rem; border-radius:.4rem; }
  img { width:190px; height:190px; border-radius:1rem; background:#fff; padding:.6rem; }
  .note { margin-top:1.5rem; padding:.9rem 1.1rem; border-radius:.9rem; background:#1b2236; color:#a8b3d6; font-size:.92rem; }
</style>
</head>
<body>
  <div class="card">
    <h1>Hi, I'm ${options.name}</h1>
    <p class="sub">I live on ${options.hostName}. Point your phone at this and I'll hop over.</p>
    <div class="row">
      <div>
        <div class="label">Pairing code</div>
        <div class="code">${options.code}</div>
      </div>
      <img src="/api/pair/qr" alt="QR code with the address of this Buddy host">
    </div>
    <ol>
      <li>Make sure the phone is on the same Wi-Fi as this computer.</li>
      <li>Open <code>${options.address}</code> on the phone (or scan the code).</li>
      <li>Tap <b>Share</b> then <b>Add to Home Screen</b>. He works offline-ish after that — it's just a web page.</li>
      <li>Type the code above when he asks, or pair straight away if this is the first phone.</li>
    </ol>
    <div class="note">${options.simulated ? 'He is in simulate mode right now, so he can talk and point at a pretend screen, but not touch this machine. ' : ''}${options.note}</div>
  </div>
</body>
</html>`;

export const createServerForHost = (options: ServerOptions): { server: BuddyServer; port: number } => {
  const server = new BuddyServer(options);
  return { server, port: options.port };
};

export const webDirFromModule = (): string | undefined => {
  const candidates = [
    fileURLToPath(new URL('./web/', import.meta.url)),
    fileURLToPath(new URL('../dist/web/', import.meta.url))
  ];
  return candidates.find((path) => existsSync(path));
};

export const mobileDirFromModule = (): string | undefined => {
  const candidates = [
    fileURLToPath(new URL('./mobile/', import.meta.url)),
    fileURLToPath(new URL('../dist/mobile/', import.meta.url))
  ];
  return candidates.find((path) => existsSync(path));
};

export type { IncomingMessage, Response };
