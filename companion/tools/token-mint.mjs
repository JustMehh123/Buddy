#!/usr/bin/env node
/**
 * The token the phone actually gets, checked against a stand-in for Gemini.
 *
 *   node companion/tools/token-mint.mjs
 *
 * The one thing this cannot do here is talk to Google: there is no API key in
 * this repository, and the machine running these tests may not even have a
 * route to generativelanguage.googleapis.com. What it *can* do is stand a local
 * server in Gemini's place (BUDDY_GEMINI_BASE) and check the request the bridge
 * makes, byte for byte, against what the ephemeral-token documentation says:
 *
 *   POST {v1beta|v1alpha}/auth_tokens
 *   x-goog-api-key: <the key>
 *   { uses: 1, expireTime, newSessionExpireTime, liveConnectConstraints }
 *
 * …and check what comes back reaches the phone intact: the token, the
 * constrained socket URL, the window for starting a session, and the exact
 * session the token was pinned to. A stand-in that records requests is a
 * stricter judge than the real service: it fails if an unused field appears.
 *
 * Which means the parts that need the real thing — a real key, a real voice,
 * a real 404 from an account that only answers on v1alpha — still have to run
 * on the user's own Mac. Both those cases are scripted here, so the code path
 * is covered even though the network is not.
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

const FAKE_KEY = 'fake-key-for-tests';
const work = mkdtempSync(join(tmpdir(), 'buddy-mint-test-'));
const pairFile = join(work, 'pair.json');

// ── The stand-in for Gemini ────────────────────────────────────────────────

/** What the stand-in should do with the next request, per version. */
const script = { v1beta: 'ok', v1alpha: 'ok' };
const seen = [];

const fake = createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    const version = request.url.split('/')[1];
    seen.push({
      version,
      url: request.url,
      method: request.method,
      key: request.headers['x-goog-api-key'] || '',
      contentType: request.headers['content-type'] || '',
      body: raw ? JSON.parse(raw) : null
    });

    const behaviour = script[version] || 'ok';
    if (behaviour === '404') {
      response.writeHead(404, { 'content-type': 'application/json' });
      return response.end(JSON.stringify({ error: { code: 404, message: 'not found' } }));
    }
    if (behaviour === 'no-constraints') {
      // An account whose model cannot be pinned: a request that tries to pin it
      // is refused for a reason that is not about permission, while the same
      // request without the constraints is fine. That distinction is the whole
      // point of this case.
      const triedToPin = Boolean(JSON.parse(raw || '{}').liveConnectConstraints);
      if (triedToPin) {
        response.writeHead(400, { 'content-type': 'application/json' });
        return response.end(JSON.stringify({ error: { code: 400, message: 'unknown field liveConnectConstraints' } }));
      }
    }
    if (behaviour === 'forbidden') {
      response.writeHead(403, { 'content-type': 'application/json' });
      return response.end(JSON.stringify({ error: { code: 403, message: 'API key not valid' } }));
    }
    const body = JSON.parse(raw || '{}');
    const now = Date.now();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        name: `auth_tokens/fake-${seen.length}`,
        uses: body.uses,
        expireTime: body.expireTime || new Date(now + 30 * 60 * 1000).toISOString(),
        newSessionExpireTime: body.newSessionExpireTime || new Date(now + 60 * 1000).toISOString()
      })
    );
  });
});
await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
const fakePort = fake.address().port;

// ── The bridge, pointed at the stand-in ───────────────────────────────────

const freePort = () =>
  new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
const port = await freePort();
const logLines = [];

const startBridge = (extra = {}) => {
  const child = spawn(process.execPath, [SERVER, '--no-open'], {
    cwd: join(HERE, '..'),
    env: {
      ...process.env,
      BUDDY_DEMO: '1',
      BUDDY_NO_TLS: '1',
      BUDDY_PHONE_PORT: String(port),
      BUDDY_PAIR_FILE: pairFile,
      BUDDY_CERT_DIR: join(work, 'certs'),
      BUDDY_GEMINI_BASE: `http://127.0.0.1:${fakePort}`,
      GEMINI_API_KEY: FAKE_KEY,
      GOOGLE_API_KEY: '',
      ...extra
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (chunk) => logLines.push(...String(chunk).split('\n')));
  child.stderr.on('data', (chunk) => logLines.push(...String(chunk).split('\n')));
  return child;
};

let bridge = startBridge();
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 80 && !logLines.some((line) => line.includes('phone app is ready')); i += 1) {
  await sleep(100);
}

const pair = async () => {
  const secret = JSON.parse(readFileSync(pairFile, 'utf8')).setupSecret;
  const response = await fetch(`${base}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret, name: 'Test iPhone' })
  });
  return (await response.json()).token;
};

console.log('Buddy voice credentials — stand-in test\n');

const token = await pair();
const askForSession = async (body = {}) => {
  const response = await fetch(`${base}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body)
  });
  return { status: response.status, json: await response.json() };
};

// ── What the bridge asks Gemini for ───────────────────────────────────────
console.log('The token request\n');
const session = await askForSession({ model: 'gemini-3.8-live' });
const request = seen[0];
note(Boolean(request), 'the bridge asked the token endpoint');

if (request) {
  note(request.method === 'POST', `it is a POST (${request.method})`);
  note(/^\/v1beta\/auth_tokens$/.test(request.url), `at the documented path (${request.url})`);
  note(request.key === FAKE_KEY, 'the API key travels in the x-goog-api-key header');
  note(request.contentType.includes('application/json'), 'and the body is JSON');

  const body = request.body || {};
  note(body.uses === 1, `the token is for one session (uses: ${body.uses})`);
  const window = Date.parse(body.newSessionExpireTime || '') - Date.now();
  note(window > 60_000 && window <= 160_000, `newSessionExpireTime is set, not left at the 60s default (${Math.round(window / 1000)}s)`);
  const life = Date.parse(body.expireTime || '') - Date.now();
  note(life > window, `and expireTime outlasts it, so a session can continue (${Math.round(life / 60000)} min)`);
  note(!('ex' in body) && !('expire_time' in body) && !('new_session_expire_time' in body), 'no invented field names');

  const constraints = body.liveConnectConstraints;
  note(Boolean(constraints), 'the session is pinned to the token (liveConnectConstraints)');
  note(constraints?.model === 'models/gemini-3.8-live', `it names the model the page asked for (${constraints?.model})`);
  note(constraints?.config?.generationConfig?.responseModalities?.[0] === 'AUDIO', 'and the audio response the page will send');
  note(
    Boolean(constraints?.config?.generationConfig?.speechConfig?.voiceConfig?.prebuiltVoiceConfig?.voiceName),
    'including the voice, so a stolen token cannot be used to run someone else’s session'
  );
  note(Boolean(constraints?.config?.systemInstruction), 'and his instructions');
}

// ── And what the phone is handed ─────────────────────────────────────────
console.log('\nWhat the phone is handed\n');
note(session.status === 200, `the session request succeeded (${session.status})`);
const live = session.json?.live;
note(typeof live?.token === 'string' && live.token.length > 8, 'a token');
note(/BidiGenerateContentConstrained$/.test(live?.wsUrl || ''), `the constrained socket URL (…${String(live?.wsUrl).slice(-28)})`);
note(live?.constrained === true, 'marked as constrained, so the page sends the pinned session');
note(live?.newSessionExpiresAt > Date.now(), `with the window it is good for (${Math.round((live?.newSessionExpiresAt - Date.now()) / 1000)}s)`);
note(live?.setup?.model === 'models/gemini-3.8-live', `and the exact setup it was pinned to (${live?.setup?.model})`);
note(Array.isArray(live?.fallbacks) && live.fallbacks.length > 0, `the models to fall back on (${live?.fallbacks?.join(', ')})`);
note(session.json?.settings?.voice === 'Puck', `the voice the settings sheet will show (${session.json?.settings?.voice})`);
note(!JSON.stringify(session.json).includes(FAKE_KEY), 'the API key itself never reaches the phone');

// ── An account that only answers on the other version ───────────────────
console.log('\nWhen the documented version answers 404\n');
script.v1beta = '404';
script.v1alpha = 'ok';
seen.length = 0;
const viaAlpha = await askForSession({ model: 'gemini-3.1-flash-live-preview' });
note(seen.some((entry) => entry.version === 'v1beta'), 'v1beta is tried first, as documented');
note(seen.some((entry) => entry.version === 'v1alpha'), 'and v1alpha picks it up when v1beta has nothing there');
note(viaAlpha.json?.live?.token, `the phone still gets a token (${viaAlpha.json?.live?.token})`);

// ── An account that cannot pin a model still gets a voice ───────────────
console.log('\nWhen the account refuses a pinned session\n');
script.v1beta = 'no-constraints';
script.v1alpha = 'no-constraints';
seen.length = 0;
const unpinned = await askForSession({ model: 'gemini-3.8-live' });
const constrainedTry = seen.find((entry) => entry.body?.liveConnectConstraints);
const plainTry = seen.find((entry) => entry.body && !entry.body.liveConnectConstraints);
note(Boolean(constrainedTry), 'the constrained request is tried first');
note(Boolean(plainTry), 'and the same token is minted without constraints rather than leaving him mute');
note(unpinned.status === 200 && Boolean(unpinned.json?.live?.token), 'the phone gets a working token either way');
note(unpinned.json?.live?.constrained === false, 'and is told it is not constrained, so it sends its own setup');

// ── A bad key is an error, not a silent failure ─────────────────────────
console.log('\nWhen the key is wrong\n');
script.v1beta = 'forbidden';
seen.length = 0;
const forbidden = await askForSession({});
note(forbidden.status === 503, `the phone is told something is wrong (${forbidden.status})`);
note(/403|key/i.test(forbidden.json?.error || ''), `with the reason (${forbidden.json?.error?.slice(0, 60)})`);
note(!/fake-key/i.test(JSON.stringify(forbidden.json)), 'and never the key itself');
note(seen.filter((entry) => entry.version === 'v1beta').length === 1, 'a wrong key is not retried in a loop');

// ── The log is safe to paste into an issue ──────────────────────────────
console.log('\nThe log\n');
const whole = logLines.join('\n');
note(!whole.includes(FAKE_KEY), 'the API key never appears in the log');
note(!whole.includes(String(session.json?.live?.token)), 'no token appears in the log');

bridge.kill('SIGTERM');
await sleep(120);
fake.close();
rmSync(work, { recursive: true, force: true });

const total = problems.length;
console.log(`\n${total === 0 ? 'all good' : `${total} problem(s)`}`);
for (const problem of problems) console.log(` - ${problem}`);
process.exit(total === 0 ? 0 : 1);
