import type {
  ActionResult,
  BuddySettings,
  Confirmation,
  HostEvent,
  HostEventMap,
  HostEventType,
  HostIdentity,
  LiveCredentials,
  Memory,
  Mood,
  OverlayEvent,
  OverlayEventMap,
  OverlayEventType,
  PairedDevice,
  PairingChallenge,
  PairingResult,
  RealtimeSessionConfig,
  ToolName
} from '@buddy/protocol';
import { DEFAULT_SETTINGS, realtimeToolPayload } from '@buddy/protocol';
import {
  FaceEngine,
  MemoryStore,
  TOOL_NAMES,
  availableTools,
  buildConfirmationCopy,
  buildRealtimeInstructions
} from '@buddy/core';
import type { ComputerHandle } from './computer/index.js';
import { effectiveCapabilities } from './computer/index.js';
import type { ProviderRegistry } from './providers/index.js';
import { ProviderError } from './providers/types.js';
import { ActionRunner, type ActionContext } from './actions.js';
import { Vision } from './vision.js';
import type { Logger } from './util/logger.js';
import * as store from './config.js';
import { randomCode, randomToken, safeEqual } from './util/tokens.js';

/**
 * The host, as one object.
 *
 * This is the thing the phone talks to. It holds the settings, the memories,
 * the paired devices and the face; it mints short-lived voice credentials; and
 * it owns the single action pipeline. The HTTP and WebSocket layers are thin
 * wrappers around what's in here, and so is the desktop shell.
 */

export interface BuddyHostOptions {
  registry: ProviderRegistry;
  computer: ComputerHandle;
  logger: Logger;
  config: store.RuntimeConfig;
  identity?: HostIdentity;
}

export class BuddyHost {
  readonly identity: HostIdentity;
  readonly memories: MemoryStore;
  readonly face: FaceEngine;
  readonly runner: ActionRunner;
  readonly vision: Vision;
  readonly registry: ProviderRegistry;
  readonly computerHandle: ComputerHandle;
  readonly logger: Logger;
  readonly config: store.RuntimeConfig;

  settings: BuddySettings;
  devices: PairedDevice[] = [];
  pairingEnabled = true;
  pendingPairing: PairingChallenge | null = null;

  private readonly listeners = new Map<HostEventType, Set<(event: HostEvent) => void>>();
  private readonly overlayListeners = new Set<(event: OverlayEvent) => void>();
  private readonly confirmations = new Map<
    string,
    { confirmation: Confirmation; resolve: (approved: boolean) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly buffer: HostEvent[] = [];
  private sequence = 0;
  private faceTimer: ReturnType<typeof setInterval> | null = null;
  private lastActivityAt = Date.now();
  private lastCursorPoint = { x: 0, y: 0 };
  private stats: store.StoredState['stats'];

  constructor(options: BuddyHostOptions) {
    this.registry = options.registry;
    this.computerHandle = options.computer;
    this.logger = options.logger;
    this.config = options.config;

    store.ensureStateDir();
    this.identity = options.identity ?? store.loadIdentity();
    this.settings = store.loadSettings(options.config);
    this.devices = store.readJson<PairedDevice[]>(store.devicesFile, []);
    this.stats = store.readJson<store.StoredState['stats']>(store.statsFile, {
      sessions: 0,
      actions: 0,
      lastSeenAt: null
    });
    // The first phone can pair freely; after that you need a code from the Mac.
    this.pairingEnabled = this.devices.length === 0;

    this.memories = new MemoryStore({
      storage: {
        load: () => store.readJson<Memory[]>(store.memoryFile, []),
        save: (memories) => store.writeJson(store.memoryFile, memories)
      },
      onChange: (memories) => this.emit('memory.changed', memories)
    });

    this.face = new FaceEngine({ asleep: true });
    this.vision = new Vision({ registry: this.registry, computer: this.computerHandle.computer });
    this.runner = new ActionRunner(this.buildActionContext());

    this.startFaceLoop();
    this.refreshCapabilities();
  }

  async init(): Promise<void> {
    const health = await this.registry.health();
    for (const entry of health) {
      this.logger[entry.ok ? 'info' : 'warn'](`provider ${entry.id}: ${entry.ok ? 'ready' : entry.detail}`);
    }
    this.logger.info(`buddy host ready — ${this.computerHandle.note}`);
    this.face.setMood('idle', { holdMs: 0 });
  }

  stop(): void {
    if (this.faceTimer) clearInterval(this.faceTimer);
    this.faceTimer = null;
    for (const [, pending] of this.confirmations) {
      clearTimeout(pending.timer);
      pending.resolve(false);
    }
    this.confirmations.clear();
    store.writeJson(store.statsFile, this.stats);
  }

  // ── Events ───────────────────────────────────────────────────────────────

  onEvent<T extends HostEventType>(type: T, handler: (event: HostEvent<T>) => void): () => void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(handler as (event: HostEvent) => void);
    this.listeners.set(type, set);
    return () => {
      set.delete(handler as (event: HostEvent) => void);
    };
  }

  emit<T extends HostEventType>(type: T, payload: HostEventMap[T]): void {
    const event: HostEvent<T> = { type, payload, seq: ++this.sequence, at: Date.now() };
    this.buffer.push(event as HostEvent);
    if (this.buffer.length > 120) this.buffer.shift();

    const set = this.listeners.get(type);
    if (!set) return;
    for (const handler of set) {
      try {
        handler(event);
      } catch (error) {
        this.logger.warn(`event handler for ${String(type)} threw`, error);
      }
    }
  }

  /** Everything since `seq`, so a reconnecting phone misses nothing. */
  eventsSince(seq: number): HostEvent[] {
    return this.buffer.filter((event) => (event.seq ?? 0) > seq);
  }

  onOverlay(handler: (event: OverlayEvent) => void): () => void {
    this.overlayListeners.add(handler);
    return () => {
      this.overlayListeners.delete(handler);
    };
  }

  emitOverlay<T extends OverlayEventType>(type: T, payload: OverlayEventMap[T]): void {
    const event = { type, payload, at: Date.now() } as OverlayEvent;
    for (const handler of this.overlayListeners) {
      try {
        handler(event);
      } catch (error) {
        this.logger.warn(`overlay handler for ${String(type)} threw`, error);
      }
    }
  }

  // ── Settings ─────────────────────────────────────────────────────────────

  updateSettings(patch: Partial<BuddySettings>): BuddySettings {
    this.settings = {
      ...this.settings,
      ...patch,
      overlay: { ...this.settings.overlay, ...(patch.overlay ?? {}) }
    };
    store.saveSettings(this.settings);
    this.refreshCapabilities();
    this.emit('settings.changed', this.settings);
    this.emitOverlay('overlay.settings', {
      overlay: this.settings.overlay,
      cursorSpeed: this.settings.cursorSpeed
    });
    return this.settings;
  }

  private refreshCapabilities(): void {
    const capabilities = effectiveCapabilities(this.computerHandle.computer, this.settings);
    if (JSON.stringify(capabilities) !== JSON.stringify(this.identity.capabilities)) {
      this.identity.capabilities = capabilities;
      store.writeJson(store.identityFile, this.identity);
      this.emit('host.info', this.identity);
    }
  }

  private activeTools(): ToolName[] {
    return availableTools(this.settings, TOOL_NAMES);
  }

  // ── Pairing and voice credentials ────────────────────────────────────────

  startPairing(deviceName = 'a phone'): PairingChallenge {
    const challenge: PairingChallenge = {
      code: randomCode(6),
      deviceId: `dev_${randomToken(6)}`,
      deviceName,
      createdAt: Date.now()
    };
    this.pendingPairing = challenge;
    this.logger.info(`pairing code for ${deviceName}: ${challenge.code}`);
    return challenge;
  }

  async completePairing(options: { deviceId: string; deviceName: string; code?: string }): Promise<
    PairingResult | { error: string }
  > {
    const known = this.devices.find((device) => device.id === options.deviceId);
    if (!known) {
      if (!this.pairingEnabled) return { error: 'Pairing is switched off on this computer.' };
      if (!this.pendingPairing) return { error: 'No pairing code is active. Ask the computer to start one.' };
      if (!options.code || !safeEqual(options.code.replace(/\D/g, ''), this.pendingPairing.code)) {
        return { error: 'That code did not match. Check the digits on the computer.' };
      }
    }

    const token = known?.token ?? randomToken(32);
    const device: PairedDevice = known
      ? { ...known, name: options.deviceName || known.name, lastSeenAt: Date.now() }
      : {
          id: options.deviceId,
          name: options.deviceName || 'Phone',
          token,
          pairedAt: Date.now(),
          lastSeenAt: Date.now()
        };

    this.devices = [...this.devices.filter((entry) => entry.id !== device.id), device];
    store.writeJson(store.devicesFile, this.devices);
    this.pendingPairing = null;
    this.pairingEnabled = false;
    this.stats.sessions += 1;
    this.stats.lastSeenAt = Date.now();
    this.logger.info(`paired with ${device.name}`);

    let live: LiveCredentials | null = null;
    try {
      live = await this.mintLiveCredentials();
    } catch (error) {
      this.logger.warn(
        `no realtime voice available: ${error instanceof Error ? error.message : String(error)} — the phone can use local voice mode`
      );
    }

    return {
      token: device.token,
      host: this.identity,
      live,
      settings: this.settings,
      memories: this.settings.memoryEnabled ? this.memories.digest(20) : []
    };
  }

  findDevice(token: string | null | undefined): PairedDevice | null {
    if (!token) return null;
    return this.devices.find((device) => safeEqual(device.token, token)) ?? null;
  }

  deviceFromId(id: string | null | undefined): PairedDevice | null {
    if (!id) return null;
    return this.devices.find((device) => device.id === id) ?? null;
  }

  forgetDevice(id: string): boolean {
    const before = this.devices.length;
    this.devices = this.devices.filter((device) => device.id !== id);
    if (this.devices.length !== before) {
      store.writeJson(store.devicesFile, this.devices);
      return true;
    }
    return false;
  }

  /**
   * A fresh, one-shot credential for the phone's voice session. This is the
   * only thing the phone ever receives: the real API key never leaves here.
   */
  async mintLiveCredentials(overrides: Partial<RealtimeSessionConfig> = {}): Promise<LiveCredentials> {
    const liveProvider = this.registry.liveProvider();
    if (!liveProvider) {
      throw new ProviderError(
        'gemini',
        'unsupported',
        'No speech-to-speech provider is configured. Add a free Gemini key, or use local voice mode on the phone.'
      );
    }

    const session = this.buildSessionConfig(overrides);

    if (liveProvider.id === 'gemini') {
      const gemini = liveProvider as unknown as {
        mintLiveToken(options: { minutes?: number }): Promise<{
          token: string;
          expiresAt: number;
          model: string;
          wsUrl: string;
        }>;
      };
      const minted = await gemini.mintLiveToken({ minutes: 30 });
      return {
        provider: 'gemini',
        token: minted.token,
        expiresAt: minted.expiresAt,
        model: session.model,
        wsUrl: minted.wsUrl,
        session,
        maxSessionSeconds: 15 * 60
      };
    }

    const apiKey = this.config.apiKey;
    if (!apiKey) throw new ProviderError('openai', 'auth', 'OPENAI_API_KEY is not set on this computer.');

    const response = await fetch(`${this.config.apiBase}/realtime/client_secrets`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        session: {
          type: 'realtime',
          model: session.model,
          instructions: session.instructions,
          output_modalities: session.outputModalities,
          audio: {
            output: { voice: session.voice },
            input: { transcription: { model: session.inputAudioTranscriptionModel } }
          },
          tools: session.tools.map(({ meta: _meta, ...rest }) => rest),
          tool_choice: session.toolChoice
        }
      })
    });
    if (!response.ok) {
      throw new ProviderError('openai', 'auth', `Minting a voice token failed: ${response.status}`);
    }
    const json = (await response.json()) as { value?: string; expires_at?: number };
    if (!json.value) throw new ProviderError('openai', 'unknown', 'No client secret returned.');

    return {
      provider: 'openai',
      token: json.value,
      expiresAt: (json.expires_at ?? Math.floor(Date.now() / 1000) + 60) * 1000,
      model: session.model,
      wsUrl: '',
      callsUrl: 'https://api.openai.com/v1/realtime/calls',
      session,
      maxSessionSeconds: 60 * 60
    };
  }

  /** The session the phone should run: persona, tools, turn handling. */
  buildSessionConfig(overrides: Partial<RealtimeSessionConfig> = {}): RealtimeSessionConfig {
    const tools = this.activeTools();
    const instructions = buildRealtimeInstructions({
      settings: this.settings,
      host: this.identity,
      memories: this.settings.memoryEnabled ? this.memories.digest(14) : [],
      computerUse: this.settings.computerUse,
      surface: 'phone',
      phone: { localTime: new Date().toLocaleString('en-US'), online: true }
    });

    const live = this.registry.liveProvider();
    const model = overrides.model ?? live?.models.live[0] ?? this.settings.realtimeModel;

    return {
      type: 'realtime',
      model,
      instructions,
      outputModalities: ['audio'],
      voice: this.settings.voice,
      temperature: 0.85,
      inputAudioTranscriptionModel: 'whisper-1',
      turnDetection: this.settings.wakeWord
        ? { type: 'server_vad', threshold: 0.55, prefixPaddingMs: 250, silenceDurationMs: 700 }
        : null,
      tools: realtimeToolPayload().filter((tool) => tools.includes(tool.name as ToolName)),
      toolChoice: 'auto',
      ...overrides
    };
  }

  // ── Confirmations ────────────────────────────────────────────────────────

  private confirmWithUser(confirmation: Confirmation, timeoutMs = 90_000): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.confirmations.delete(confirmation.id);
        this.emit('confirmation.resolved', { id: confirmation.id, approved: false });
        resolve(false);
      }, timeoutMs);
      this.confirmations.set(confirmation.id, { confirmation, resolve, timer });
      this.emit('confirmation.request', confirmation);
    });
  }

  resolveConfirmation(response: { id: string; token: string; approved: boolean }): boolean {
    const pending = this.confirmations.get(response.id);
    if (!pending) return false;
    if (!safeEqual(pending.confirmation.token, response.token)) {
      this.logger.warn('confirmation token mismatch — ignored');
      return false;
    }
    clearTimeout(pending.timer);
    this.confirmations.delete(response.id);
    this.emit('confirmation.resolved', { id: response.id, approved: response.approved });
    pending.resolve(response.approved);
    return true;
  }

  get pendingConfirmations(): Confirmation[] {
    return [...this.confirmations.values()].map((entry) => entry.confirmation);
  }

  // ── Wiring for the action pipeline ───────────────────────────────────────

  private buildActionContext(): ActionContext {
    return {
      computer: this.computerHandle.computer,
      vision: this.vision,
      settings: () => this.settings,
      updateSettings: (patch) => this.updateSettings(patch),
      pointCursor: (target) => {
        this.face.setPointing({ x: target.nx, y: target.ny });
        this.emitOverlay('overlay.cursor', {
          from: this.lastCursorPoint,
          to: { x: target.x, y: target.y },
          durationMs: this.settings.cursorSpeed,
          trail: this.settings.cursorTrail,
          label: target.label
        });
        this.lastCursorPoint = { x: target.x, y: target.y };
      },
      clearCursor: () => {
        this.face.setPointing(null);
        this.emitOverlay('overlay.cursor.hide', {});
      },
      highlight: (target) => {
        this.emitOverlay('overlay.highlight', {
          x: target.x,
          y: target.y,
          width: target.width,
          height: target.height,
          ms: 2400,
          label: target.label
        });
      },
      confirm: (confirmation) => this.confirmWithUser(confirmation),
      remember: (input) => {
        if (!this.settings.memoryEnabled) {
          return {
            id: 'memory-off',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            kind: input.kind ?? 'fact',
            text: input.text,
            tags: [],
            importance: 0,
            source: 'voice'
          } satisfies Memory;
        }
        return this.memories.add({
          text: input.text,
          kind: input.kind,
          tags: input.tags,
          importance: input.importance,
          source: 'voice'
        });
      },
      recall: (query, limit) => (this.settings.memoryEnabled ? this.memories.search(query, { limit }) : []),
      forget: ({ id, text }) => {
        if (id) {
          const memory = this.memories.get(id);
          return memory && this.memories.remove(id) ? [memory] : [];
        }
        return text ? this.memories.removeByText(text) : [];
      },
      setMood: (mood, say) => {
        this.face.setMood(mood as Mood);
        if (say) this.face.setStatus(say);
        this.emit('face.state', this.face.snapshot());
        if (say) this.emit('face.status', { status: say, mood: mood as Mood });
      },
      goToSleep: (say) => {
        this.face.gesture('sleep');
        this.emit('face.state', this.face.snapshot());
        if (say) this.emit('face.status', { status: say, mood: 'sleeping' });
      },
      setStatus: (status) => {
        this.face.setStatus(status);
        this.emit('face.status', { status });
      },
      onCancel: () => {
        this.runner.cancel();
        this.emit('toast', { text: 'Stopped.', kind: 'warn' });
      },
      log: (entry) => {
        this.logger[entry.level](entry.message, entry.data);
      }
    };
  }

  private startFaceLoop(): void {
    if (this.faceTimer) return;
    let last = Date.now();
    this.faceTimer = setInterval(() => {
      const now = Date.now();
      const state = this.face.update(now - last);
      last = now;

      if (
        this.settings.sleepAfterMs > 0 &&
        this.face.getMood() !== 'sleeping' &&
        now - this.lastActivityAt > this.settings.sleepAfterMs
      ) {
        this.face.gesture('sleep');
      }

      // The desktop shell wants every frame; the phone only needs the changes.
      this.emitOverlay('overlay.face', { state, pointer: null });
      const calm = state.mood === 'sleeping' || state.mood === 'idle' || state.mood === 'drowsy';
      const changed = JSON.stringify(state) !== this.lastSentFace;
      if (changed && (!calm || now - this.lastSentAt > 4000)) {
        this.lastSentFace = JSON.stringify(state);
        this.lastSentAt = now;
        this.emit('face.state', state);
      }
    }, 120);
  }

  private lastSentFace = '';
  private lastSentAt = 0;

  /** The phone (or the user) touching him. */
  noteActivity(mood?: Mood): void {
    this.lastActivityAt = Date.now();
    if (mood && this.face.getMood() === 'sleeping') this.face.gesture('wake');
    if (mood) this.face.setMood(mood, { holdMs: mood === 'listening' ? 0 : 2400 });
  }

  async runTool(tool: ToolName, args: Record<string, unknown>, deviceId = 'local'): Promise<ActionResult> {
    this.noteActivity();
    this.stats.actions += 1;
    const result = await this.runner.run({ tool, args, deviceId });
    this.emit('action.finished', result);
    return result;
  }

  recordSession(deviceId: string): void {
    this.stats.sessions += 1;
    this.stats.lastSeenAt = Date.now();
    const device = this.devices.find((entry) => entry.id === deviceId);
    if (device) {
      device.lastSeenAt = Date.now();
      store.writeJson(store.devicesFile, this.devices);
    }
    this.noteActivity('listening');
  }

  status(): Record<string, unknown> {
    return {
      host: this.identity,
      simulated: this.computerHandle.simulated,
      note: this.computerHandle.note,
      providers: this.registry.all.map((provider) => ({
        id: provider.id,
        label: provider.label,
        capabilities: provider.capabilities
      })),
      liveVoice: this.registry.liveProvider()?.id ?? null,
      devices: this.devices.map((device) => ({
        id: device.id,
        name: device.name,
        pairedAt: device.pairedAt,
        lastSeenAt: device.lastSeenAt
      })),
      memories: this.memories.stats(),
      settings: this.settings,
      stats: this.stats,
      face: this.face.snapshot(),
      pendingConfirmations: this.pendingConfirmations.length
    };
  }
}

export { buildConfirmationCopy, DEFAULT_SETTINGS };
