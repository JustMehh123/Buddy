#!/usr/bin/env node
/**
 * The bridge, from the outside, with no trust.
 *
 *   node companion/tools/bridge-security.mjs
 *
 * The phone app lives on a web page, and a web page on the same Wi-Fi is
 * reachable by anything else on that Wi-Fi. So this boots the real bridge on a
 * throwaway port with a throwaway pairing file, then behaves like the things it
 * has to survive:
 *
 *   - a stranger with a browser and a curl command, who must get nothing,
 *   - a phone with the right pairing code, which must get everything,
 *   - a phone whose code was already used once,
 *   - someone trying to read files outside the web folder,
 *   - someone whose phone was revoked from the command line,
 *   - and the log itself, which must never contain the key or a live token.
 *
 * Everything here is local: no network, no API key, no Mac.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, '..', 'server.mjs');

const problems = [];
const note = (ok, what) => {
  console.log(`${ok ? '  ok  ' : 'FAIL  '}${what}`);
  if (!ok) problems.push(what);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Any port the OS is happy to hand out. */
const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

const work = mkdtempSync(join(tmpdir(), 'buddy-bridge-test-'));
const pairFile = join(work, 'pair.json');
const port = await freePort();
const logLines = [];

const server = spawn(process.execPath, [SERVER, '--no-open'], {
  cwd: join(HERE, '..'),
  env: {
    ...process.env,
    BUDDY_DEMO: '1',
    BUDDY_NO_TLS: '1',
    BUDDY_PHONE_PORT: String(port),
    BUDDY_PAIR_FILE: pairFile,
    BUDDY_CERT_DIR: join(work, 'certs'),
    GEMINI_API_KEY: 'test-key-that-must-not-leak',
    GOOGLE_API_KEY: ''
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
server.stdout.on('data', (chunk) => logLines.push(...String(chunk).split('\n')));
server.stderr.on('data', (chunk) => logLines.push(...String(chunk).split('\n')));

const base = `http://127.0.0.1:${port}`;
const call = async (path, options = {}) => {
  const response = await fetch(base + path, options);
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* html or a plain refusal */
  }
  return { status: response.status, json, text };
};
const post = (path, body, token) =>
  call(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body ?? {})
  });

/** Talk to the socket directly, so the client cannot normalise the path away. */
const raw = (requestLine) =>
  new Promise((resolve, reject) => {
    import('node:net').then(({ connect }) => {
      const socket = connect(port, '127.0.0.1', () => {
        socket.write(`${requestLine}\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
      });
      let data = '';
      socket.on('data', (chunk) => {
        data += chunk;
      });
      socket.on('end', () => resolve(data));
      socket.on('error', reject);
    });
  });

console.log('Buddy bridge — security test\n');

// Wait for it to be listening (it prints its banner once it is).
for (let i = 0; i < 80 && !logLines.some((line) => line.includes('phone app is ready')); i += 1) {
  await sleep(100);
}
const banner = logLines.join('\n').replace(/\u001b\[[0-9;]*m/g, '');
note(banner.includes('phone app is ready'), 'the bridge started');

// ── The setup link is the only way in, and it carries a one-time code ──────
const secret = JSON.parse(readFileSync(pairFile, 'utf8')).setupSecret;
note(typeof secret === 'string' && secret.length >= 32, `a pairing code was made (${secret.length} characters)`);
note(banner.includes(`?pair=${secret}`), 'the link (and so the QR code) carries that code');
note(!banner.includes('test-key-that-must-not-leak'), 'the API key is not printed');

// ── A stranger gets nothing ───────────────────────────────────────────────
console.log('\nA device that was never paired\n');
note(!(await call('/api/status')).json?.paired, 'status admits it knows nothing');
for (const [path, method] of [
  ['/api/info', 'GET'],
  ['/api/events', 'GET'],
  ['/api/session', 'POST'],
  ['/api/chat', 'POST'],
  ['/api/send', 'POST']
]) {
  const refused = method === 'GET' ? await call(path) : await post(path, {});
  note(refused.status === 401, `${method} ${path} is refused (${refused.status})`);
  note(
    typeof refused.json?.hint === 'string' && refused.json.hint.length > 0,
    `and it says what to do about it`
  );
}
const strangerSend = await post('/api/send', { command: 'tool', tool: 'click' });
note(strangerSend.status === 401, 'a stranger cannot make the computer do anything');

// ── Reading files it should not ───────────────────────────────────────────
console.log('\nFiles outside the web folder\n');
for (const line of [
  'GET /..%2f..%2fcompanion/server.mjs HTTP/1.1',
  'GET /%2e%2e%2fpackage.json HTTP/1.1',
  'GET /..%2f..%2fstart.sh HTTP/1.1'
]) {
  const answer = await raw(line);
  const status = answer.split('\r\n', 1)[0];
  const leaked = /BUDDY_DEMO|"name": "buddy|#!/;
  note(!leaked.test(answer), `${line.split(' ')[1]} leaks nothing (${status})`);
}
note((await call('/nothere.js')).status === 404, 'a missing file is a 404, not the app shell');
note((await call('/')).status === 200, 'the page itself still loads');
note((await call('/this-is-an-app-route-actually')).status === 200, 'and so do the app routes');

// ── Pairing ───────────────────────────────────────────────────────────────
console.log('\nPairing\n');
const wrong = await post('/api/pair', { secret: 'n'.repeat(64), name: 'stranger' });
note(wrong.status === 401, `a wrong code is refused (${wrong.status})`);
note(!JSON.stringify(wrong.json).includes('test-key'), 'and the refusal reveals nothing');

const paired = await post('/api/pair', { secret, name: 'Test iPhone' });
const token = paired.json?.token;
note(paired.status === 200 && typeof token === 'string' && token.length >= 32, 'the right code pairs the phone');
note(JSON.stringify(paired.json).includes('Test iPhone'), 'the phone is remembered by name');

const replay = await post('/api/pair', { secret, name: 'replay' });
note(replay.status === 401, `the same code cannot be used twice (${replay.status})`);

const onDisk = readFileSync(pairFile, 'utf8');
note(!onDisk.includes(token), 'the pairing file holds a hash of the token, never the token');

// ── A paired phone can do everything ─────────────────────────────────────
console.log('\nThe paired phone\n');
note((await call('/api/status', { headers: { authorization: `Bearer ${token}` } })).json?.paired === true, 'status knows it');
const info = await call('/api/info', { headers: { authorization: `Bearer ${token}` } });
note(info.status === 200 && Boolean(info.json?.settings), 'it can read what the computer knows about him');
note((await post('/api/send', { command: 'awake' }, token)).status === 200, 'it can send a command');
note((await post('/api/chat', { text: 'hello' }, token)).status === 200, 'it can use the text fallback');
// The event stream never ends, so it is opened, read from, and dropped rather
// than awaited.
const controller = new AbortController();
try {
  const stream = await fetch(`${base}/api/events`, {
    headers: { authorization: `Bearer ${token}` },
    signal: controller.signal
  });
  note(stream.status === 200, 'it can open the event stream');
  const reader = stream.body.getReader();
  const { value } = await reader.read();
  const greeted = new TextDecoder().decode(value || new Uint8Array());
  note(greeted.includes(': buddy'), `and the stream greets it before anything happens (${greeted.trim()})`);
} finally {
  controller.abort();
}

// ── Revocation, from the command line, while the bridge is running ───────
console.log('\nRevocation\n');
const revoked = spawn(process.execPath, [SERVER, '--revoke', 'all'], {
  cwd: join(HERE, '..'),
  env: { ...process.env, BUDDY_PAIR_FILE: pairFile, BUDDY_PHONE_PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe']
});
let revokeOutput = '';
revoked.stdout.on('data', (chunk) => {
  revokeOutput += String(chunk);
});
await new Promise((resolve) => revoked.on('exit', resolve));
note(/revoked 1 device/.test(revokeOutput), `the command line revoked it (${revokeOutput.trim().split('\n').pop()})`);
const after = await call('/api/info', { headers: { authorization: `Bearer ${token}` } });
note(after.status === 401, `the revoked phone loses access immediately, without restarting (${after.status})`);

// ── The Mac only obeys its own bridge ────────────────────────────────────
//
// The Mac's packet socket is on the same Wi-Fi as everything else, and it can
// move the mouse. The bridge signs every command with the secret the Mac
// wrote; a stand-in Mac here checks that signature rather than trusting it.
console.log('\nTalking to the Mac\n');
const BRIDGE_TOKEN = 'bridge-secret-for-tests-only-0000000000';
const macPort = await freePort();
const heard = [];
const fakeMac = createNetServer((socket) => {
  socket.on('data', (chunk) => {
    for (const line of String(chunk).split('\n')) {
      if (line.trim()) heard.push(JSON.parse(line));
    }
  });
});
await new Promise((resolve) => fakeMac.listen(macPort, '127.0.0.1', resolve));

const secondPort = await freePort();
const second = spawn(process.execPath, [SERVER, '--no-open'], {
  cwd: join(HERE, '..'),
  env: {
    ...process.env,
    BUDDY_DEMO: '1',
    BUDDY_NO_TLS: '1',
    BUDDY_PHONE_PORT: String(secondPort),
    BUDDY_PAIR_FILE: join(work, 'pair2.json'),
    BUDDY_CERT_DIR: join(work, 'certs'),
    BUDDY_HOST: '127.0.0.1',
    BUDDY_PORT: String(macPort),
    BUDDY_MAC_TOKEN: BRIDGE_TOKEN,
    GEMINI_API_KEY: '',
    GOOGLE_API_KEY: ''
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
for (let i = 0; i < 60 && heard.length === 0; i += 1) await sleep(100);
note(heard.length > 0, `the bridge reached the Mac (${heard.length} packet(s))`);
note(heard.every((packet) => packet.auth === BRIDGE_TOKEN), 'and every packet it sends carries the Mac\'s secret');
note(heard.some((packet) => packet.command || packet.hello), 'including the ones that ask for something');
second.kill('SIGTERM');
fakeMac.close();
await sleep(150);

// ── Nothing leaked into the log ──────────────────────────────────────────
console.log('\nThe log\n');
const whole = logLines.join('\n');
note(!whole.includes('test-key-that-must-not-leak'), 'the API key never appears');
note(!whole.includes(token), 'no device token appears');

const wrote = [join(work, 'pair.json')];
for (const file of wrote) {
  try {
    rmSync(file, { force: true });
  } catch {
    /* nothing to clean */
  }
}
server.kill('SIGTERM');
await sleep(150);
rmSync(work, { recursive: true, force: true });

const total = problems.length;
console.log(`\n${total === 0 ? 'all good' : `${total} problem(s)`}`);
for (const problem of problems) console.log(` - ${problem}`);
process.exit(total === 0 ? 0 : 1);
