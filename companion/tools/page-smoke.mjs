#!/usr/bin/env node
/**
 * Boots the real phone page in a fake browser and drives it.
 *
 *   node companion/tools/page-smoke.mjs
 *
 * There is no browser in most places this runs, so this stands in for one: it
 * loads Web/index.html, stubs the few APIs jsdom lacks (canvas drawing,
 * EventSource, audio), imports the real app.js, and then walks through what a
 * phone would actually do — connect, hold to talk, receive a caption, open
 * settings, lose the computer. A typo or a missing element in the page fails
 * here instead of on someone's phone.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, '..', '..', 'Web');

const problems = [];
const note = (ok, what) => {
  console.log(`${ok ? '  ok  ' : 'FAIL  '}${what}`);
  if (!ok) problems.push(what);
};

// ── A canvas that remembers calls instead of pixels ─────────────────────────

const gradient = { addColorStop() {} };
const context = {
  canvas: null,
  createLinearGradient: () => gradient,
  createRadialGradient: () => gradient,
  measureText: () => ({ width: 12 }),
  getImageData: () => ({ data: new Uint8ClampedArray(4) })
};
for (const method of [
  'arc', 'beginPath', 'bezierCurveTo', 'clearRect', 'clip', 'closePath', 'ellipse', 'fill', 'fillRect',
  'fillText', 'lineTo', 'moveTo', 'quadraticCurveTo', 'rect', 'restore', 'rotate', 'save', 'scale',
  'setTransform', 'stroke', 'strokeRect', 'translate'
]) {
  context[method] = () => {};
}

// ── The fake browser ────────────────────────────────────────────────────────

const html = readFileSync(join(WEB, 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'https://buddy.test/', pretendToBeVisual: true });
const { window } = dom;

window.HTMLCanvasElement.prototype.getContext = function getContext() {
  context.canvas = this;
  return context;
};

class FakeEventSource {
  static last = null;
  constructor(url) {
    this.url = url;
    this.readyState = 0; // CONNECTING
    FakeEventSource.last = this;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  message(packet) {
    this.onmessage?.({ data: JSON.stringify(packet) });
  }
  error(state = 0) {
    this.readyState = state;
    this.onerror?.({ type: 'error' });
  }
  close() {
    this.readyState = 2;
  }
}
FakeEventSource.CLOSED = 2;
window.EventSource = FakeEventSource;

const requests = [];
const session = {
  instructions: 'You are Buddy.',
  brain: { host: 'http://127.0.0.1:11434', model: 'llama3.2', ready: true },
  settings: { name: 'Buddy', voice: 'System', computerUse: true, chime: true },
  host: { name: 'Test Mac' }
};
window.fetch = async (url, options = {}) => {
  requests.push({ url: String(url), body: options.body ? JSON.parse(options.body) : null });
  const body = String(url).includes('api/session') ? session : { text: 'From the computer.' };
  return { ok: true, status: 200, json: async () => body };
};

window.AudioContext = class {
  constructor() {
    this.currentTime = 0;
    this.state = 'running';
    this.destination = {};
  }
  resume() {
    return Promise.resolve();
  }
  createOscillator() {
    return {
      type: '',
      frequency: { setValueAtTime() {} },
      connect: () => ({ connect: () => undefined }),
      start() {},
      stop() {}
    };
  }
  createGain() {
    return {
      gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
      connect: () => ({ connect: () => undefined })
    };
  }
};
window.speechSynthesis = { getVoices: () => [], speak() {}, cancel() {} };
window.SpeechSynthesisUtterance = class {};

// Make the page's globals the globals app.js will see. Node's own globals are
// deliberately left alone where they will do (performance, Event, fetch is
// replaced only because the page must not really hit the network) — replacing
// them breaks jsdom's internals, which reach for those same globals.
for (const name of [
  'window', 'document', 'navigator', 'location', 'localStorage',
  'AudioContext', 'speechSynthesis', 'SpeechSynthesisUtterance'
]) {
  Object.defineProperty(globalThis, name, { value: window[name], configurable: true, writable: true });
}
globalThis.requestAnimationFrame = (callback) => window.requestAnimationFrame(callback);
globalThis.cancelAnimationFrame = (handle) => window.cancelAnimationFrame(handle);
globalThis.EventSource = FakeEventSource;
globalThis.fetch = window.fetch;
globalThis.isSecureContext = true;

// ── Boot the actual page ────────────────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const $ = (selector) => window.document.querySelector(selector);
let pageErrors = 0;
window.addEventListener('error', (event) => {
  pageErrors += 1;
  console.log('      page error:', event.message);
});
process.on('uncaughtException', (error) => {
  pageErrors += 1;
  console.log('      uncaught:', error && error.stack ? error.stack.split('\n').slice(0, 3).join('\n      ') : error);
});

console.log('Buddy phone page — smoke test\n');

await import(join(WEB, 'app.js'));
await sleep(80);

const stream = FakeEventSource.last;
note(Boolean(stream), 'the page opened its event stream');
note(Boolean(stream?.url.includes('/api/events')), 'the stream points at /api/events');

stream.open();
await sleep(80);

const posted = () => requests.filter((request) => request.url.includes('/api/send')).map((request) => request.body);
note(posted().some((packet) => packet?.hello), 'it introduced itself with a hello packet');
note(posted().some((packet) => packet?.command === 'webClient'), 'it told the computer it is the web client');
note(requests.some((request) => request.url.includes('/api/session')), 'it asked for a session (instructions + brain)');
note($('#status-dot').dataset.kind === 'ready', `the status dot reads "${$('#status-dot').dataset.kind}"`);
note($('#status').textContent.length > 0, `the status line reads "${$('#status').textContent}"`);

// A brand-new visitor gets greeted once, using what the computer told us.
stream.message({ hello: 'Test Mac' });
stream.message({ command: 'settings', text: JSON.stringify({ secure: true, host: 'Test Mac', demo: false, hasKey: true }) });
await sleep(60);
note($('#bubble').classList.contains('visible'), 'a first-time visitor gets a welcome bubble');
note(/Hold the screen/.test($('#bubble-text').textContent), `the welcome explains the gesture ("${$('#bubble-text').textContent.slice(0, 40)}…")`);
const greeted = window.localStorage.getItem('buddy.greeted');
stream.message({ command: 'settings', text: JSON.stringify({ secure: true, host: 'Test Mac', demo: false, hasKey: true }) });
note(Boolean(greeted), 'the greeting is remembered so it happens only once');

stream.message({ face: { mood: 'thinking', gazeX: 0.4, gazeY: -0.2, talk: 0 } });
stream.message({ command: 'caption', text: 'Looking at your screen…' });
stream.message({ command: 'captionDone', text: 'Looking at your screen…' });
await sleep(100);
note($('#bubble').classList.contains('visible'), 'a caption opens the speech bubble');
note($('#bubble-text').textContent.includes('Looking at your screen'), 'the caption text lands in the bubble');
note(window.document.title.startsWith('Buddy'), `the tab title becomes "${window.document.title}"`);

const surface = window.document.getElementById('surface');
surface.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
await sleep(320);
note(posted().some((packet) => packet?.command === 'awake'), 'holding the screen wakes him up');
window.dispatchEvent(new window.Event('pointerup', { bubbles: true }));
await sleep(60);

window.document.getElementById('gear').dispatchEvent(new window.Event('click', { bubbles: true }));
await sleep(50);
note($('#settings').classList.contains('visible'), 'the gear opens the settings sheet');
note($('#settings-body').innerHTML.includes('class="row"'), 'the settings sheet fills itself in');
window.document.getElementById('settings-close').dispatchEvent(new window.Event('click', { bubbles: true }));
await sleep(50);
note(!$('#settings').classList.contains('visible'), 'the sheet closes again');

// The stream drops but the browser is retrying (readyState CONNECTING): the
// page should stay quiet for a moment, then explain what is happening.
stream.error(0);
await sleep(7200);
note($('#overlay').classList.contains('visible'), 'losing the computer shows the waiting overlay');
note(/Waiting for your computer/.test($('#overlay-title').textContent), 'the overlay explains what to do');
note($('#status-dot').dataset.kind === 'offline', `the status dot goes offline (${$('#status-dot').dataset.kind})`);

await sleep(100);
note(pageErrors === 0, 'the page never threw');

const total = problems.length;
console.log(`\n${total === 0 ? 'all good' : `${total} problem(s)`}`);
for (const problem of problems) console.log(` - ${problem}`);
process.exit(total === 0 ? 0 : 1);
