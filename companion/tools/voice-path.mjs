#!/usr/bin/env node
/**
 * Tests the voice path end to end, with no network and no model installed.
 *
 *   node tools/voice-path.mjs
 *
 * The phone speaks with its own built-in speech, and all the thinking happens on
 * a local, open-source model. This stands up a *fake* Ollama server, boots the
 * real bridge pointed at it, and drives the same HTTP calls the phone makes:
 *
 *   GET  /api/status   → is the brain ready?
 *   POST /api/session  → who is he? (and: no `live` credential any more)
 *   POST /api/chat     → the answer the phone actually shows and speaks
 *
 * If the bridge stopped reaching the model, or started leaking a `live` block
 * again, this fails.
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createSocket } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPANION = join(HERE, '..');

const problems = [];
const note = (ok, what) => {
  console.log(`${ok ? '  ok  ' : 'FAIL  '}${what}`);
  if (!ok) problems.push(what);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Ask the OS for a free TCP port, then let it go so the child can take it. */
const freePort = () =>
  new Promise((resolve) => {
    const probe = createSocket();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

// ── A fake Ollama, so the test runs anywhere ────────────────────────────────

const seen = [];
const fakeOllama = createServer((request, response) => {
  let body = '';
  request.on('data', (chunk) => (body += chunk));
  request.on('end', () => {
    const send = (status, payload) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(payload));
    };
    if (request.url.endsWith('/models')) {
      return send(200, { data: [{ id: 'llama3.2' }] });
    }
    if (request.url.endsWith('/chat/completions')) {
      seen.push(JSON.parse(body || '{}'));
      return send(200, {
        choices: [{ message: { role: 'assistant', content: 'Hello from the local model.' } }]
      });
    }
    send(404, { error: 'not found' });
  });
});

await new Promise((resolve) => fakeOllama.listen(0, '127.0.0.1', resolve));
const ollamaPort = fakeOllama.address().port;
const brainHost = `http://127.0.0.1:${ollamaPort}`;

// ── Boot the real bridge against it ──────────────────────────────────────────

const bridgePort = await freePort();
const child = spawn(process.execPath, [join(COMPANION, 'server.mjs')], {
  cwd: COMPANION,
  env: {
    ...process.env,
    BUDDY_NO_TLS: '1', // no certificate needed for a local test
    BUDDY_PHONE_PORT: String(bridgePort),
    BUDDY_OLLAMA_HOST: brainHost,
    BUDDY_MODEL: 'llama3.2'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
let bridgeLog = '';
child.stdout.on('data', (chunk) => (bridgeLog += chunk));
child.stderr.on('data', (chunk) => (bridgeLog += chunk));

const base = `http://127.0.0.1:${bridgePort}`;
const post = async (path, body) => {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
};

async function waitForBridge() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${base}/api/status`);
      if (response.ok) return await response.json();
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  return null;
}

console.log('Buddy voice path — bridge ↔ local model test\n');

const status = await waitForBridge();
note(Boolean(status), 'the bridge came up');
note(status?.brain?.ready === true, 'the bridge found his brain');
note(status?.brain?.model === 'llama3.2', `the model is the one we asked for (${status?.brain?.model})`);
note(status?.brain?.host === brainHost, 'the model server is the local one');

// ── The session the phone asks for ──────────────────────────────────────────

const session = await post('/api/session', { device: 'test', wants: 'text' });
note(session.status === 200, `asking for a session works (${session.status})`);
note(!('live' in session.body) || session.body.live === undefined, 'no live credential is handed out any more');
note(typeof session.body.instructions === 'string' && session.body.instructions.length > 0, 'he is given instructions');
note(session.body.brain?.ready === true, 'the session reports the brain as ready');
note(session.body.settings?.brain?.model === 'llama3.2', 'the settings screen can show the model');

// ── The answer the phone actually shows and speaks ──────────────────────────

const chat = await post('/api/chat', { text: 'Are you awake?', device: 'test' });
note(chat.status === 200, `chat answers (${chat.status})`);
note(chat.body.text === 'Hello from the local model.', `the reply comes back verbatim ("${chat.body.text}")`);
note(chat.body.via === 'bridge', 'the bridge answered it (no Mac connected in this test)');

note(seen.length === 1, `the model was asked exactly once (${seen.length})`);
const request = seen[0] || {};
note(request.model === 'llama3.2', 'the request names the model');
note(Array.isArray(request.messages) && request.messages[0]?.role === 'system', 'his instructions go first');
note(request.messages?.[1]?.content === 'Are you awake?', 'the words the user said are passed through');
note(request.stream === false, 'a plain (non-streaming) answer is asked for');

// ── And it says plainly when the brain is missing ───────────────────────────

const lonely = spawn(process.execPath, [join(COMPANION, 'server.mjs')], {
  cwd: COMPANION,
  env: {
    ...process.env,
    BUDDY_NO_TLS: '1',
    BUDDY_PHONE_PORT: String(await freePort()),
    BUDDY_OLLAMA_HOST: 'http://127.0.0.1:1', // nothing lives here
    BUDDY_MODEL: 'llama3.2'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
let lonelyLog = '';
lonely.stdout.on('data', (chunk) => (lonelyLog += chunk));
lonely.stderr.on('data', (chunk) => (lonelyLog += chunk));
for (let attempt = 0; attempt < 60 && !/Brain: nothing is answering/.test(lonelyLog); attempt += 1) {
  await sleep(100);
}
note(/Brain: nothing is answering/.test(lonelyLog), 'with no model running, he says so instead of pretending');
note(/ollama pull llama3\.2/.test(lonelyLog), 'and he tells you exactly what to run');
lonely.kill('SIGKILL');

note(/Brain: llama3\.2 on http:\/\/127\.0\.0\.1:\d+ — free, open source and unlimited/.test(bridgeLog), 'with a model present, he says his brain is free and unlimited');

child.kill('SIGKILL');
fakeOllama.close();

console.log(`\n${problems.length === 0 ? 'all good' : `${problems.length} problem(s)`}`);
for (const problem of problems) console.log(` - ${problem}`);

if (problems.length) console.log(`\n--- bridge log ---\n${bridgeLog}`);
process.exit(problems.length === 0 ? 0 : 1);
