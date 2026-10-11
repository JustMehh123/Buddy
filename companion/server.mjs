#!/usr/bin/env node
/**
 * Buddy for the phone — serves the little website that puts him on your home
 * screen, and connects it to the computer he actually lives on.
 *
 *   node companion/server.mjs                 # serve the phone app
 *   node companion/server.mjs --regen-certs   # remake the local certificate
 *   BUDDY_DEMO=1 node companion/server.mjs    # no Mac needed: watch his face
 *
 * Why this exists at all:
 *
 *   The Mac app advertises itself with Bonjour and speaks lines of JSON over a
 *   raw TCP connection — exactly what the original iPhone app did. Browsers
 *   can't open raw sockets or browse Bonjour, so this process sits in the
 *   middle: it finds the Mac on the Wi-Fi, holds one TCP link to it, and serves
 *   the phone page over HTTP with a matching event stream. The phone never sees
 *   your API key; this server only holds one if you deliberately give it
 *   GEMINI_API_KEY (the Mac's own key is preferred when there is one).
 *
 *   iPhone Safari refuses to open the microphone on a plain http:// page, so
 *   this generates a small local certificate (via openssl, once) and serves
 *   HTTPS. You install that certificate on the phone the same way you install
 *   any profile: Safari → the /install page → Settings → trust it. Then the
 *   microphone, the home-screen app and the whole experience work.
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import { connect } from 'node:net';
import { homedir, hostname, networkInterfaces } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const WEB_DIR = resolve(HERE, '..', 'Web');
const PORT = Number(process.env.BUDDY_PHONE_PORT ?? 8443);
const DEMO = process.env.BUDDY_DEMO === '1';
const GEMINI_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
const SERVICE_TYPE = 'buddy';
const FORCED_HOST = process.env.BUDDY_HOST || '';
const FORCED_PORT = process.env.BUDDY_PORT ? Number(process.env.BUDDY_PORT) : 0;
const CERT_DIR = process.env.BUDDY_CERT_DIR || join(HERE, '.certs');

// Gemini's free tier is what makes Buddy free to run; these are its realtime models.
const GEMINI_LIVE_WS =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_LIVE_MODEL = process.env.BUDDY_LIVE_MODEL || 'gemini-3.1-flash-live-preview';
const DEFAULT_CHAT_MODEL = process.env.BUDDY_CHAT_MODEL || 'gemini-3.5-flash';

const log = (...args) => console.log(`\u001b[35mbuddy\u001b[0m`, ...args);
const warn = (...args) => console.warn(`\u001b[33mbuddy\u001b[0m`, ...args);

/**
 * The key the Mac app saved, if it has one. It writes a small private file in
 * Application Support — the same one the menu bar uses — so pasting the free
 * key into Buddy once is enough for the phone app too.
 */
function macStoredKey(name) {
  try {
    const path = join(homedir(), 'Library', 'Application Support', 'Buddy', 'keys.json');
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    return typeof saved?.[name] === 'string' ? saved[name] : '';
  } catch {
    return '';
  }
}

/** One key is enough — the free Gemini one. Environment first, then the Mac's store. */
const geminiKey = () => GEMINI_KEY || macStoredKey('gemini');

// ────────────────────────────────────────────────────────────────────────────
// The link to the Mac
// ────────────────────────────────────────────────────────────────────────────

const mac = {
  socket: null,
  buffer: '',
  connected: false,
  host: null,
  port: null,
  name: 'your computer',
  pending: new Map(), // callID → {resolve, timer}
  lastFace: null
};

let sequence = 0;
const callID = () => `b${++sequence}${Date.now().toString(36)}`;

/** Every phone currently showing his face (one open event stream each). */
const streams = new Set();

/** Tell every open page the same thing at the same time. */
function broadcast(packet) {
  for (const response of streams) sse(response, packet);
}

function sse(response, packet) {
  try {
    response.write(`data: ${JSON.stringify(packet)}\n\n`);
  } catch {
    streams.delete(response);
  }
}

/** Ask the Mac something and wait for the reply packet with the same callID. */
function askMac(packet, timeoutMs = 8000) {
  return new Promise((resolve) => {
    if (!mac.connected) return resolve(null);
    const id = packet.callID || callID();
    const timer = setTimeout(() => {
      mac.pending.delete(id);
      resolve(null);
    }, timeoutMs);
    mac.pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        mac.pending.delete(id);
        resolve(value);
      }
    });
    sendToMac({ ...packet, callID: id });
  });
}

function sendToMac(packet) {
  if (mac.socket?.writable) {
    try {
      mac.socket.write(`${JSON.stringify(packet)}\n`);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

function connectToMac(host, port) {
  if (!host || !port) return;
  mac.host = host;
  mac.port = port;

  const socket = connect({ host, port }, () => {
    mac.connected = true;
    log(`connected to ${host}:${port} — he's awake on ${mac.name}`);
    sendToMac({ hello: hostname() });
    sendToMac({ command: 'webClient' });
    broadcast({ command: 'webConnected' });
  });
  mac.socket = socket;
  socket.setNoDelay(true);
  socket.setKeepAlive(true, 2000);

  socket.on('data', (chunk) => {
    mac.buffer += chunk.toString('utf8');
    let index;
    while ((index = mac.buffer.indexOf('\n')) >= 0) {
      const line = mac.buffer.slice(0, index).trim();
      mac.buffer = mac.buffer.slice(index + 1);
      if (!line) continue;
      try {
        handleMacPacket(JSON.parse(line));
      } catch {
        /* a partial or malformed line; keep going */
      }
    }
    if (mac.buffer.length > 4 * 1024 * 1024) mac.buffer = '';
  });

  const drop = (why) => {
    if (!mac.connected && !mac.socket) return;
    mac.connected = false;
    mac.socket = null;
    warn(`lost the Mac (${why}) — retrying`);
    for (const [, pending] of mac.pending) pending.resolve(null);
    mac.pending.clear();
    broadcast({ command: 'webDisconnected' });
    setTimeout(discoverMac, 2500);
  };
  socket.on('error', (error) => drop(error.code || 'error'));
  socket.on('close', () => drop('closed'));
}

function handleMacPacket(packet) {
  if (packet.hello) {
    mac.name = packet.hello;
    broadcast({ hello: packet.hello });
  }
  if (packet.face) {
    mac.lastFace = packet.face;
    broadcast({ face: packet.face });
  }
  if (packet.callID && mac.pending.has(packet.callID)) {
    mac.pending.get(packet.callID).resolve(packet);
    return;
  }
  // Anything else (captions, notes paths, research cards) is the Mac talking to
  // the phone, so pass it straight through.
  broadcast(packet);
}

/** Find the Mac advertised as _buddy._tcp (the renamed original service). */
async function discoverMac() {
  if (DEMO || FORCED_HOST) return;

  let Bonjour;
  try {
    ({ Bonjour } = await import('bonjour-service'));
  } catch {
    // Run straight from a fresh clone and the one dependency is missing. Fetch
    // it here rather than making the first run end in a stack trace.
    warn('installing the one small dependency (bonjour-service) — a few seconds, once');
    try {
      execFileSync('npm', ['install', '--no-audit', '--no-fund', '--silent'], { cwd: HERE, stdio: 'inherit' });
      ({ Bonjour } = await import('bonjour-service'));
    } catch (error) {
      warn(`could not install it (${error.message}); set BUDDY_HOST and BUDDY_PORT instead`);
      return;
    }
  }

  try {
    const bonjour = new Bonjour();
    const browser = bonjour.find({ type: SERVICE_TYPE });
    browser.on('up', (service) => {
      const address = (service.addresses || []).find((entry) => entry.includes('.')) || service.host;
      log(`found "${service.name}" at ${address}:${service.port}`);
      mac.name = (service.name || '').replace(/\s*\(Buddy\)\s*/, '') || mac.name;
      connectToMac(address || FORCED_HOST, service.port);
      // Keep browsing so restarting the Mac app reconnects on its own.
    });
    setTimeout(() => {
      if (!mac.connected) {
        warn('no Buddy on this network yet — is the Mac app running? (set BUDDY_HOST=name.local and BUDDY_PORT=8737 to point at it by hand)');
        setTimeout(discoverMac, 8000);
      }
    }, 4000);
  } catch (error) {
    warn(`could not browse for the Mac (${error.message}); set BUDDY_HOST and BUDDY_PORT instead`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// A local certificate, so iPhone Safari will open the microphone
// ────────────────────────────────────────────────────────────────────────────

const addresses = () =>
  Object.entries(networkInterfaces())
    .flatMap(([name, entries]) => (entries || []).map((entry) => ({ name, ...entry })))
    .filter((entry) => entry.family === 'IPv4' && !entry.internal);

/** Every name this certificate has to be valid for. */
function certificateNames() {
  const short = hostname().replace(/\.local$/i, '');
  const names = new Set(['buddy.local', 'localhost', `${short}.local`]);
  for (const entry of addresses()) names.add(entry.address);
  return [...names];
}

function opensslPath() {
  for (const candidate of ['openssl', '/usr/bin/openssl', '/opt/homebrew/bin/openssl']) {
    try {
      execFileSync(candidate, ['version'], { stdio: 'ignore' });
      return candidate;
    } catch {
      /* try the next one */
    }
  }
  return null;
}

function ensureCertificates({ force = false } = {}) {
  const keyPath = join(CERT_DIR, 'server.key');
  const certPath = join(CERT_DIR, 'server.crt');
  const caPath = join(CERT_DIR, 'buddy-ca.crt');
  const metaPath = join(CERT_DIR, 'names.json');
  const profilePath = join(CERT_DIR, 'buddy-ca.mobileconfig');
  const done = [keyPath, certPath, caPath, metaPath, profilePath].every((path) => existsSync(path));

  if (done && !force) {
    try {
      const saved = JSON.parse(readFileSync(metaPath, 'utf8'));
      const wanted = certificateNames();
      if (wanted.every((name) => saved.names?.includes(name))) {
        return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
      }
      log('the network has changed since the certificate was made — remaking it');
    } catch {
      /* remake it below */
    }
  }

  const openssl = opensslPath();
  if (!openssl) {
    warn('openssl was not found, so the phone page will be plain HTTP — the face works, but iPhone will refuse the microphone');
    return null;
  }

  try {
    mkdirSync(CERT_DIR, { recursive: true });
    const names = certificateNames();
    const conf = join(CERT_DIR, 'openssl.cnf');
    const altNames = names.map((name) => (/^[\d.]+$/.test(name) ? `IP:${name}` : `DNS:${name}`)).join(',');
    writeFileSync(
      conf,
      ['[req]', 'distinguished_name = dn', '[dn]', '[ext]', `subjectAltName = ${altNames}`,
        'basicConstraints = CA:FALSE', 'keyUsage = digitalSignature,keyEncipherment',
        'extendedKeyUsage = serverAuth', ''].join('\n')
    );

    const run = (args) => execFileSync(openssl, args, { stdio: 'ignore' });
    run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(CERT_DIR, 'ca.key'), '-out', caPath,
      '-days', '3650', '-subj', '/CN=Buddy Local CA',
      '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
    run(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', join(CERT_DIR, 'server.csr'),
      '-subj', `/CN=${names[0]}`, '-config', conf]);
    run(['x509', '-req', '-in', join(CERT_DIR, 'server.csr'), '-CA', caPath, '-CAkey', join(CERT_DIR, 'ca.key'),
      '-CAcreateserial', '-out', join(CERT_DIR, 'server.leaf.crt'), '-days', '825', '-extfile', conf, '-extensions', 'ext']);

    // The server sends its leaf plus the little CA, so a phone that trusts the
    // profile can build the whole chain.
    writeFileSync(certPath, readFileSync(join(CERT_DIR, 'server.leaf.crt')) + readFileSync(caPath));
    writeFileSync(profilePath, makeProfile(openssl, caPath));
    writeFileSync(metaPath, JSON.stringify({ names, createdAt: new Date().toISOString() }, null, 2));
    log(`made a local certificate for ${names.join(', ')} (once — it is reused after that)`);
    return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
  } catch (error) {
    warn(`could not make a local certificate (${error.message}); falling back to plain HTTP`);
    return null;
  }
}

/**
 * A configuration profile containing the certificate, the file iOS expects when
 * you tap "install this on my phone". Safari hands it to Settings for you.
 */
function makeProfile(openssl, caPath) {
  const der = execFileSync(openssl, ['x509', '-in', caPath, '-outform', 'DER']);
  const base64 = der.toString('base64').replace(/(.{76})/g, '$1\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadCertificateFileName</key><string>buddy-ca.crt</string>
      <key>PayloadContent</key>
      <data>${base64}</data>
      <key>PayloadDescription</key><string>Lets this phone trust Buddy running on this computer.</string>
      <key>PayloadDisplayName</key><string>Buddy Local CA</string>
      <key>PayloadIdentifier</key><string>ai.buddy.local.ca</string>
      <key>PayloadType</key><string>com.apple.security.root</string>
      <key>PayloadUUID</key><string>${randomUUID().toUpperCase()}</string>
      <key>PayloadVersion</key><integer>1</integer>
    </dict>
  </array>
  <key>PayloadDescription</key><string>Adds the certificate Buddy's phone app is signed with.</string>
  <key>PayloadDisplayName</key><string>Buddy</string>
  <key>PayloadIdentifier</key><string>ai.buddy.local.profile</string>
  <key>PayloadOrganization</key><string>Buddy</string>
  <key>PayloadRemovalDisallowed</key><false/>
  <key>PayloadType</key><string>Configuration</string>
  <key>PayloadUUID</key><string>${randomUUID().toUpperCase()}</string>
  <key>PayloadVersion</key><integer>1</integer>
</dict>
</plist>
`;
}

// ────────────────────────────────────────────────────────────────────────────
// Voice credentials: minted on the Mac when it can, here when it can't
// ────────────────────────────────────────────────────────────────────────────

/**
 * Ask the Mac for a session (his instructions, his tool list, his voice) and a
 * one-shot realtime token. A freshly renamed Mac build answers `liveToken`; if
 * it doesn't, we fall back to our own Gemini key so the phone still works.
 */
async function getSession() {
  const fromMac = await askMac({ command: 'liveToken' }, 3000);

  if (fromMac?.text) {
    try {
      const live = normalizeLive(JSON.parse(fromMac.text));
      if (live) {
        const session = await askMac({ command: 'webSession' }, 2500);
        if (session?.text) {
          try {
            Object.assign(live.session, JSON.parse(session.text));
          } catch {
            /* the Mac's session config is optional */
          }
        }
        return { live, host: { name: mac.name } };
      }
    } catch {
      /* fall through to our own key */
    }
  }

  const key = geminiKey();
  if (key) {
    const live = await mintGeminiFromEnv(key);
    const session = await askMac({ command: 'webSession' }, 2500);
    const extra = session?.text ? safeJson(session.text) : null;
    if (extra?.instructions) live.session.instructions = extra.instructions;
    if (Array.isArray(extra?.tools) && extra.tools.length) live.session.tools = extra.tools.map(stripMeta);
    return { live, host: { name: mac.name }, demo: DEMO || undefined };
  }

  if (DEMO) return demoSession();

  throw new Error(
    "No voice provider is available. Add a free Gemini key on the computer (or set GEMINI_API_KEY here) and he'll start talking — no card, no billing."
  );
}

const stripMeta = ({ meta, ...rest }) => rest;
const safeJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** Accept a fresh Gemini token from the Mac; report anything we cannot speak. */
function normalizeLive(parsed) {
  if (parsed.provider === 'openai' || parsed.clientSecret || parsed.value) return null;
  if (!parsed.token) return null;
  return {
    provider: 'gemini',
    token: parsed.token,
    wsUrl: parsed.wsUrl || GEMINI_LIVE_WS,
    model: parsed.model || DEFAULT_LIVE_MODEL,
    expiresAt: parsed.expiresAt || Date.now() + 30 * 60 * 1000,
    session: parsed.session || defaultSession(parsed.model || DEFAULT_LIVE_MODEL)
  };
}

async function mintGeminiFromEnv(key) {
  const expireTime = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  const response = await fetch('https://generativelanguage.googleapis.com/v1alpha/auth_tokens', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({ uses: 1, expireTime })
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Gemini rejected the key (${response.status}). ${detail.slice(0, 160)}`);
  }
  const json = await response.json();
  log('minted a one-shot Gemini voice token for the phone');
  return {
    provider: 'gemini',
    token: json.name,
    wsUrl: GEMINI_LIVE_WS,
    model: DEFAULT_LIVE_MODEL,
    expiresAt: Date.parse(expireTime),
    session: defaultSession(DEFAULT_LIVE_MODEL)
  };
}

const defaultSession = (model) => ({
  model,
  voice: 'Puck',
  temperature: 0.85,
  outputModalities: ['audio'],
  instructions:
    "You are Buddy: a small, warm, slightly cheeky companion who lives on the user's phone and in their computer. You can hear them whenever they hold the screen and talk. Keep replies to one or two short spoken sentences, never lists or markdown. Use your eye and cursor tools to look at their screen and point at things — point rather than click, and only touch the computer when asked.",
  tools: []
});

/**
 * Demo mode has no real voice provider, so we deliberately send no `live`
 * block: the page then falls back to the phone's own voice and to `/api/chat`,
 * which answers from the script below. Talking to him in demo mode works.
 */
function demoSession() {
  return { host: { name: 'the demo computer' }, demo: true };
}

const DEMO_REPLIES = [
  'I can hear you. In demo mode I answer from a script, but the face is real.',
  "That's the idea: hold the screen, talk, and I answer when you let go.",
  'Connect your computer and I can look at your screen and point at things.',
  'Double tap me when you want me to nap.',
  'I like this part — the buttons light up where you press.'
];

let demoReplyIndex = 0;
const nextDemoReply = () => DEMO_REPLIES[demoReplyIndex++ % DEMO_REPLIES.length];

// ────────────────────────────────────────────────────────────────────────────
// The chat fallback: text in, text out, using the free tier
// ────────────────────────────────────────────────────────────────────────────

async function chat(body) {
  const text = String(body.text || '').slice(0, 4000);
  if (!text) throw new Error('nothing to say');

  // Preferred: let the Mac run it, so it uses his real instructions and his
  // real tools (look, point, click…). A current Mac build answers `chat`.
  const fromMac = await askMac({ command: 'chat', text }, 6000);
  if (fromMac?.text) return { text: fromMac.text, via: 'mac' };

  if (DEMO) return { text: nextDemoReply(), via: 'demo' };

  const key = geminiKey();
  if (!key) {
    throw new Error('No free Gemini key yet. Open Buddy in the menu bar, choose "Voice Key (free Gemini)…" and paste one.');
  }

  const session = await askMac({ command: 'webSession' }, 2500);
  const instructions = safeJson(session?.text || '')?.instructions || defaultSession(DEFAULT_CHAT_MODEL).instructions;

  const response = await fetch(`${GEMINI_API}/${encodeURIComponent(DEFAULT_CHAT_MODEL)}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text }] }],
      systemInstruction: { parts: [{ text: `${instructions}\n\nAnswer in one or two short spoken sentences.` }] },
      generationConfig: { temperature: 0.9, maxOutputTokens: 400 }
    })
  });
  if (!response.ok) throw new Error(`Gemini could not answer (${response.status})`);
  const json = await response.json();
  const reply = (json.candidates?.[0]?.content?.parts || [])
    .map((part) => part.text || '')
    .join('')
    .trim();
  return { text: reply || "I'm not sure what to say to that.", via: 'bridge' };
}

// ────────────────────────────────────────────────────────────────────────────
// Demo mode: a pretend Mac, so you can see his face before anything is set up
// ────────────────────────────────────────────────────────────────────────────

const DEMO_SCRIPT = [
  { wait: 2500, mood: 'listening', say: "Hi! I'm Buddy. Hold the screen and talk to me." },
  { wait: 6000, mood: 'thinking', say: 'Let me look…' },
  { wait: 5000, mood: 'pointing', say: 'There it is — the chat that says "run Buddy on the MacBook".' },
  { wait: 6000, mood: 'happy', say: 'That went well. I like this part.' },
  { wait: 7000, mood: 'talking', say: 'When your computer is connected, I can click and type for you too.' },
  { wait: 8000, mood: 'sleepy', say: 'Double tap me when you want a nap.' }
];

function startDemo() {
  log('demo mode: pretending to be the Mac, so you can see the whole loop');
  let index = 0;
  let talkTimer = null;
  const step = () => {
    const entry = DEMO_SCRIPT[index++ % DEMO_SCRIPT.length];
    broadcast({ face: { mood: entry.mood, gazeX: Math.sin(index) * 0.5, gazeY: Math.cos(index * 1.3) * 0.3, talk: 0 } });
    broadcast({ command: 'caption', text: entry.say });
    broadcast({ command: 'captionDone', text: entry.say });
    let ticks = 0;
    clearInterval(talkTimer);
    talkTimer = setInterval(() => {
      ticks += 1;
      broadcast({
        face: { mood: 'talking', gazeX: Math.sin(index + ticks / 3) * 0.4, gazeY: 0.05, talk: 0.35 + Math.random() * 0.45 }
      });
      if (ticks > 18) clearInterval(talkTimer);
    }, 120);
    setTimeout(step, entry.wait);
  };
  setTimeout(step, 1200);
}

// ────────────────────────────────────────────────────────────────────────────
// The phone's packets
// ────────────────────────────────────────────────────────────────────────────

function handlePhonePacket(packet) {
  if (DEMO) return demoReply(packet);

  // Tools and session chatter go to the Mac, with replies routed back.
  if (packet.command === 'tool') {
    const forwarded = { ...packet, callID: packet.callID || callID() };
    askMac(forwarded, 45000).then((reply) => {
      broadcast({
        command: 'toolResult',
        callID: forwarded.callID,
        text: reply?.text ?? '',
        image: reply?.image ?? null,
        tool: packet.tool
      });
    });
    return;
  }

  if (packet.command === 'chat') {
    chat({ text: packet.text })
      .then((result) => broadcast({ command: 'chat', callID: packet.callID, text: result.text }))
      .catch((error) => broadcast({ command: 'chat', callID: packet.callID, text: '', error: error.message }));
    return;
  }

  sendToMac(packet);
}

/** Demo mode still answers tool calls, so the whole loop can be seen working. */
function demoReply(packet) {
  if (packet.command !== 'tool') return;
  const replies = {
    look_at_screen: 'The frontmost app is Mail, with three unread chats. On screen: "run Buddy on the MacBook", "Standup at 9:30".',
    point_at: 'Pointing at "run Buddy on the MacBook".',
    point_at_spot: 'Pointing where you said.',
    web_research: "The report card is on the screen now. Short version: it works.",
    go_to_sleep: 'Going to sleep.'
  };
  setTimeout(() => {
    broadcast({
      command: 'toolResult',
      callID: packet.callID,
      text: replies[packet.tool] || 'Done.',
      tool: packet.tool
    });
  }, 700);
}

// ────────────────────────────────────────────────────────────────────────────
// HTTP
// ────────────────────────────────────────────────────────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.mobileconfig': 'application/x-apple-aspen-config'
};

// --http (or BUDDY_NO_TLS=1) skips the certificate entirely: handy when a proxy
// is already terminating TLS, or when you only want his face on a second screen.
const plainHTTP = process.argv.includes('--http') || process.env.BUDDY_NO_TLS === '1';
const certificates = plainHTTP ? null : ensureCertificates({ force: process.argv.includes('--regen-certs') });

const handler = async (request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);

  // The phone asks for a session: instructions, tools and a one-shot token.
  if (url.pathname === '/api/session' && request.method === 'POST') {
    try {
      const session = await getSession();
      return json(response, 200, {
        ...session,
        settings: {
          name: 'Buddy',
          voice: session.live?.session?.voice || 'Puck',
          computerUse: true,
          chime: true
        }
      });
    } catch (error) {
      return json(response, 503, { error: error.message });
    }
  }

  // The on-device-voice fallback, and typed messages.
  if (url.pathname === '/api/chat' && request.method === 'POST') {
    try {
      const body = await readJson(request);
      return json(response, 200, await chat(body));
    } catch (error) {
      return json(response, 503, { error: error.message });
    }
  }

  // The packets the page sends up: hello, awake, caption, tool…
  if (url.pathname === '/api/send' && request.method === 'POST') {
    let packet;
    try {
      packet = await readJson(request);
    } catch {
      return json(response, 400, { error: 'that was not JSON' });
    }
    json(response, 200, { ok: true });
    handlePhonePacket(packet);
    return;
  }

  // The long-lived stream coming down: face, captions, tool results.
  if (url.pathname === '/api/events') return openStream(request, response);

  if (url.pathname === '/api/status') {
    return json(response, 200, {
      mac: { connected: mac.connected, host: mac.host, port: mac.port, name: mac.name },
      demo: DEMO,
      secure: Boolean(certificates),
      geminiKeyOnBridge: Boolean(geminiKey()),
      phones: streams.size
    });
  }

  // Installing the certificate on the phone, spelled out.
  if (url.pathname === '/install') return installPage(response);

  if (url.pathname === '/buddy-ca.mobileconfig' || url.pathname === '/buddy.mobileconfig') {
    if (!certificates) return json(response, 404, { error: 'no certificate — run with --regen-certs on a machine with openssl' });
    try {
      const body = readFileSync(join(CERT_DIR, 'buddy-ca.mobileconfig'));
      response.writeHead(200, { 'content-type': MIME['.mobileconfig'], 'content-length': body.length });
      return response.end(body);
    } catch (error) {
      return json(response, 500, { error: error.message });
    }
  }

  if (url.pathname === '/buddy-ca.crt') {
    if (!certificates) return json(response, 404, { error: 'no certificate' });
    const body = readFileSync(join(CERT_DIR, 'buddy-ca.crt'));
    response.writeHead(200, { 'content-type': 'application/x-x509-ca-cert', 'content-length': body.length });
    return response.end(body);
  }

  // Static files — the phone app itself.
  return serveStatic(url.pathname, response);
};

const server = certificates
  ? createSecureServer({ key: certificates.key, cert: certificates.cert }, handler)
  : createServer(handler);

/** The phone keeps one of these open for as long as the page is alive. */
function openStream(request, response) {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  });
  response.write(': buddy\n\n');
  streams.add(response);
  log(`a phone opened the page (${streams.size} now)`);

  if (mac.lastFace) sse(response, { face: mac.lastFace });
  sse(response, { hello: mac.name });
  sse(response, { command: mac.connected ? 'webConnected' : 'webDisconnected' });
  sse(response, {
    command: 'settings',
    text: JSON.stringify({
      secure: Boolean(certificates),
      host: mac.name,
      demo: DEMO,
      hasKey: Boolean(geminiKey())
    })
  });

  // A comment every 20 seconds keeps proxies and sleepy phones from dropping it.
  const keepAlive = setInterval(() => {
    try {
      response.write(': ping\n\n');
    } catch {
      clearInterval(keepAlive);
    }
  }, 20000);

  const done = () => {
    clearInterval(keepAlive);
    streams.delete(response);
    log(`a phone closed the page (${streams.size} left)`);
  };
  request.on('close', done);
  response.on('close', done);
}

function installPage(response, over = 'https', appUrl = '/') {
  const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Trust Buddy on this phone</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 1.5rem 1.25rem 3rem; background: #0b0d17; color: #eef1ff;
         font: 16px/1.55 -apple-system, system-ui, sans-serif; }
  h1 { font-size: 1.4rem; margin: 0 0 .75rem; }
  h2 { font-size: 1.05rem; margin: 1.5rem 0 .35rem; color: #a9bcff; }
  p, li { color: #cfd3ea; }
  a.install { display: block; margin: 1.25rem 0; padding: .95rem 1rem; border-radius: 1rem; text-align: center;
              background: linear-gradient(135deg, #6c86f5, #4254d6); color: white; font-weight: 600;
              text-decoration: none; }
  ol { padding-left: 1.2rem; }
  code { background: #1e2338; padding: .1rem .35rem; border-radius: .35rem; font-size: .9em; }
</style></head>
<body>
  <h1>One-time step: trust this computer</h1>
  <p>iOS only lets a web page use the microphone when the connection is trusted. Install this
     certificate profile once and the microphone, the home-screen app and everything else work.</p>
  <a class="install" href="/buddy-ca.mobileconfig">Install the Buddy certificate</a>
  <h2>Then, on this phone</h2>
  <ol>
    <li>Tap <strong>Allow</strong> when Safari says it downloaded a profile.</li>
    <li>Open <strong>Settings → General → VPN &amp; Device Management</strong> and tap <strong>Buddy</strong> → Install.</li>
    <li>Open <strong>Settings → General → About → Certificate Trust Settings</strong> and turn on full trust for <strong>Buddy Local CA</strong>.</li>
    <li>Come back here and tap <strong>Open Buddy</strong> below — then <strong>Share → Add to Home Screen</strong> so he stays.</li>
  </ol>
  <a class="install" id="open" href="${appUrl}">Open Buddy</a>
  <p>You can remove the profile any time in the same Settings screens. Nothing leaves your Wi-Fi.</p>
</body></html>`;
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  response.end(body);
}

function json(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(payload);
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8') || '{}';
  return JSON.parse(text);
}

function serveStatic(pathname, response) {
  let relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const target = normalize(join(WEB_DIR, relative));
  if (!target.startsWith(WEB_DIR)) {
    response.writeHead(403).end('no');
    return;
  }
  const file = existsSync(target) && statSync(target).isFile() ? target : join(WEB_DIR, 'index.html');
  try {
    const body = readFileSync(file);
    response.writeHead(200, {
      'content-type': MIME[extname(file)] || 'application/octet-stream',
      'cache-control': file.endsWith('index.html') ? 'no-store' : 'public, max-age=300'
    });
    response.end(body);
  } catch (error) {
    response.writeHead(500).end(`could not read ${relative}: ${error.message}`);
  }
}

// ────────────────────────────────────────────────────────────────────────────

/** A scannable way onto the phone, printed in the terminal. */
async function printQRCode(url) {
  try {
    const { default: QRCode } = await import('qrcode');
    const art = await QRCode.toString(url, { type: 'terminal', small: true, margin: 1 });
    console.log(`\u001b[35m${art.replace(/^/gm, '   ')}\u001b[0m`);
    console.log("\u001b[35m   Scan that with the phone's camera.\u001b[0m\n");
  } catch {
    /* without the qrcode package the address above is plenty */
  }
}

/**
 * Listen, and if the port is taken, take the next one. "Seamless" cannot mean
 * "crashes with EADDRINUSE the second time you run it".
 */
function listen(instance, port, attempts = 12) {
  return new Promise((resolve, reject) => {
    let candidate = port;
    let left = attempts;
    let listening = false;

    const onListening = () => {
      listening = true;
      // Trust the server itself, never our own bookkeeping: a leftover callback
      // from an earlier attempt would otherwise report the port that failed.
      resolve(instance.address().port);
    };
    // Stays attached on purpose: an unhandled 'error' event would take the
    // whole bridge down and, with it, the phone's connection.
    const onError = (error) => {
      if (listening) {
        warn(`server error: ${error.message}`);
        return;
      }
      if (error.code === 'EADDRINUSE' && left > 0) {
        left -= 1;
        candidate += 1;
        warn(`port ${candidate - 1} is busy — trying ${candidate}`);
        setImmediate(() => instance.listen(candidate, '0.0.0.0'));
        return;
      }
      instance.removeListener('listening', onListening);
      reject(error);
    };

    instance.on('error', onError);
    instance.once('listening', onListening);
    instance.listen(candidate, '0.0.0.0');
  });
}

/**
 * A small plain-HTTP server on the next port, always there.
 *
 * Two jobs: iOS refuses to fetch a certificate profile over a connection that
 * the certificate itself is supposed to protect (chicken and egg), so the phone
 * needs one insecure address to download it from; and if the HTTPS address is
 * awkward to reach, this one still shows his face.
 */
function startCompanionServer(httpsPort) {
  const companion = createServer((request, response) => {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    if (url.pathname === '/buddy-ca.mobileconfig' || url.pathname === '/buddy.mobileconfig') {
      if (!certificates) return json(response, 404, { error: 'no certificate' });
      const body = readFileSync(join(CERT_DIR, 'buddy-ca.mobileconfig'));
      response.writeHead(200, { 'content-type': MIME['.mobileconfig'], 'content-length': body.length });
      return response.end(body);
    }
    if (url.pathname === '/install') {
      const host = (request.headers.host || '').split(':')[0];
      return installPage(response, 'http', `https://${host}:${httpsPort}/`);
    }
    // Everything else belongs on the trusted address.
    const host = (request.headers.host || '').split(':')[0];
    response.writeHead(302, { location: `https://${host}:${httpsPort}${url.pathname}${url.search}` });
    response.end();
  });
  return listen(companion, httpsPort + 1, 4).catch(() => null);
}

const port = await listen(server, PORT);
const scheme = certificates ? 'https' : 'http';
const short = hostname().replace(/\.local$/i, '');
const link = `${scheme}://${short}.local:${port}/`;
const companionPort = certificates ? await startCompanionServer(port) : null;

const lines = ["Buddy's phone app is ready:"];
if (companionPort) {
  const setup = `http://${short}.local:${companionPort}/install`;
  lines.push(
    '',
    `   1. On the phone (same Wi-Fi), open:   ${setup}`,
    '      That page installs the little certificate he needs, then turns on his microphone.',
    `   2. Then add him to the home screen:   ${link}`
  );
  await printQRCode(setup);
} else {
  lines.push('', `   Open this on your phone (same Wi-Fi):   ${link}`, '   Then Share -> Add to Home Screen.');
  await printQRCode(link);
}
if (DEMO) lines.push('', 'Demo mode is ON: no Mac needed, he does faces and answers from a script.');
else lines.push('', 'He finds your Mac on his own when the Buddy app is running.');
if (!certificates) lines.push('', 'Plain HTTP: the face and buttons work; iPhone will not give a web page the microphone.');

console.log(`\n\u001b[35m${lines.join('\n')}\u001b[0m\n`);

// Show him off on this machine too (localhost counts as a trusted address, so
// the microphone works there as well). --no-open keeps him out of the way.
if (process.platform === 'darwin' && !process.argv.includes('--no-open')) {
  try {
    execFileSync('open', [`${scheme}://localhost:${port}/`], { stdio: 'ignore' });
  } catch {
    /* nothing to open with; the addresses above are enough */
  }
}

if (FORCED_HOST) connectToMac(FORCED_HOST, FORCED_PORT || 8737);
else discoverMac();
if (DEMO) startDemo();
