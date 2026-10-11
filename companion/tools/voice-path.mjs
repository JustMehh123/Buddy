#!/usr/bin/env node
/**
 * Tests the voice path without a network: a fake Gemini socket, the real
 * LiveVoice class.
 *
 *   node companion/tools/voice-path.mjs
 *
 * The interesting part is the loop between his eyes and his mouth. When a tool
 * comes back with a screenshot, Gemini's function responses cannot carry an
 * image, so the picture has to go out as a still frame of live input just before
 * the answer. That ordering is easy to break and hard to notice by hand, so it
 * is pinned down here: setup → tool call → image frame → tool response.
 */

const problems = [];
const note = (ok, what) => {
  console.log(`${ok ? '  ok  ' : 'FAIL  '}${what}`);
  if (!ok) problems.push(what);
};

// ── A browser's worth of stubs ──────────────────────────────────────────────

class FakeSocket {
  static last = null;
  static all = [];
  // live.js checks these constants exactly as a browser provides them.
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    FakeSocket.last = this;
    FakeSocket.all.push(this);
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.();
    }, 0);
  }

  send(payload) {
    this.sent.push(JSON.parse(payload));
    // The service acknowledges a session with setupComplete; connect() waits
    // for exactly that before calling itself connected.
    if (this.acknowledges !== false && this.sent[this.sent.length - 1].setup) {
      setTimeout(() => this.deliver({ setupComplete: {} }), 2);
    }
  }

  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: '' });
  }

  /** A message from the service. */
  deliver(message) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  events(...types) {
    return this.sent.filter((payload) => types.some((type) => payload[type] !== undefined));
  }

  last(type) {
    const matches = this.events(type);
    return matches[matches.length - 1]?.[type];
  }

  indexOf(type) {
    return this.sent.findIndex((payload) => payload[type] !== undefined);
  }
}

const workletNode = () => ({
  port: { postMessage() {}, set onmessage(_) {} },
  connect() {},
  disconnect() {}
});

class FakeAudioContext {
  constructor(options = {}) {
    this.sampleRate = options.sampleRate || 48000;
    this.state = 'running';
    this.destination = { name: 'destination' };
    this.audioWorklet = { addModule: async () => undefined };
  }
  resume() {
    return Promise.resolve();
  }
  createMediaStreamSource() {
    return { connect() {} };
  }
  createGain() {
    return { gain: { value: 1 }, connect() {} };
  }
  close() {
    return Promise.resolve();
  }
}

Object.defineProperties(globalThis, {
  navigator: {
    value: {
      mediaDevices: {
        getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] })
      },
      language: 'en-CA',
      userAgent: 'node-test'
    },
    configurable: true
  },
  fetch: { value: async () => ({ ok: true, json: async () => ({}) }), configurable: true },
  window: { value: globalThis, configurable: true },
  isSecureContext: { value: true, configurable: true },
  WebSocket: { value: FakeSocket, configurable: true },
  AudioContext: { value: FakeAudioContext, configurable: true },
  AudioWorkletNode: {
    value: class {
      constructor() {
        this.port = { postMessage() {}, set onmessage(_) {} };
      }
      connect() {}
    },
    configurable: true
  }
});

const { LiveVoice } = await import('../../Web/live.js');

// ── The session ─────────────────────────────────────────────────────────────

const SCREENSHOT = '/9j/4AAQSkZJRgABAQAAAQ==' + 'morejpegbytes';
const frame = { ok: true, text: 'The screen shows Mail open.', image: SCREENSHOT };
const tools = [
  {
    name: 'look_at_screen',
    description: 'Take a fresh look at the screen.',
    parameters: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'point_at',
    description: 'Point at something.',
    parameters: { type: 'object', properties: { target_id: { type: 'string' } }, required: ['target_id'] }
  }
];

const toolCalls = [];
const voice = new LiveVoice({
  onTool: async (call) => {
    toolCalls.push(call);
    return frame;
  },
  onTranscript: () => undefined,
  onStatus: () => undefined
});

console.log('Buddy voice path — fake socket test\n');

await voice.connect({
  token: 'eph-token',
  wsUrl: 'wss://generativelanguage.googleapis.com/ws/…BidiGenerateContent',
  session: { model: 'gemini-3.1-flash-live-preview', instructions: 'You are Buddy.', voice: 'Puck', tools },
  pushToTalk: true,
  voiceOut: false
});

const socket = FakeSocket.last;
note(socket.url.includes('access_token=eph-token'), 'the token is passed on the socket URL');
note(socket.indexOf('setup') === 0, 'the first thing sent is a setup message');

const setup = socket.last('setup');
note(setup?.model === 'models/gemini-3.1-flash-live-preview', `the setup names the model (${setup?.model})`);
note(setup?.generationConfig?.responseModalities?.[0] === 'AUDIO', 'he answers with audio');
note(setup?.generationConfig?.speechConfig?.voiceConfig?.prebuiltVoiceConfig?.voiceName === 'Puck', 'the voice is the one the Mac asked for');
note(setup?.systemInstruction?.parts?.[0]?.text === 'You are Buddy.', 'his instructions come from the Mac');
const declarations = setup?.tools?.[0]?.functionDeclarations || [];
note(declarations.length === 2, `his tools travel with the session (${declarations.length})`);
note(declarations[0]?.name === 'look_at_screen', 'the first tool is look_at_screen');
note(!('type' in (declarations[0] || {})) || declarations[0].type === undefined, 'tool declarations are in Gemini style, not OpenAI style');
note(Boolean(setup?.realtimeInputConfig?.automaticActivityDetection?.disabled), 'push-to-talk disables automatic turns');

// ── A turn: hold, speak, let go ─────────────────────────────────────────────

voice.beginHold();
note(socket.last('realtimeInput')?.activityStart !== undefined, 'holding the screen opens a turn');
voice.endHold();
const endMessages = socket.events('realtimeInput');
note(JSON.stringify(endMessages[endMessages.length - 1]).includes('activityEnd'), 'letting go closes the turn');

// ── A tool call, with a picture coming back ─────────────────────────────────

socket.deliver({
  toolCall: {
    functionCalls: [{ id: 'fc1', name: 'look_at_screen', args: {} }]
  }
});
await new Promise((resolve) => setTimeout(resolve, 30));

note(toolCalls.length === 1 && toolCalls[0].name === 'look_at_screen', 'the tool call reaches the page');

const videoPayload = socket.sent.filter((payload) => payload.realtimeInput?.video).pop();
note(Boolean(videoPayload), 'the screenshot goes out as a still frame');
note(videoPayload?.realtimeInput?.video?.mimeType === 'image/jpeg', 'it is sent as a JPEG');
note(videoPayload?.realtimeInput?.video?.data === SCREENSHOT, 'the frame is the picture the Mac sent');

const responses = socket.events('toolResponse');
note(responses.length === 1, 'exactly one tool response goes back');
const response = responses[0]?.toolResponse?.functionResponses?.[0];
note(response?.id === 'fc1' && response?.name === 'look_at_screen', 'the response is paired with the call by id');
note(response?.response?.result?.text?.includes('Mail'), 'the words of the tool result are passed on');
note(response?.response?.result?.image === undefined, 'the picture is not duplicated inside the JSON response');

const frameOrder = socket.sent.findIndex((payload) => payload.realtimeInput?.video);
const responseOrder = socket.sent.findIndex((payload) => payload.toolResponse);
note(frameOrder >= 0 && responseOrder > frameOrder, 'the frame is sent before the tool response, so he can see it');

// ── What he says comes back as both a caption and a voice ───────────────────

const captions = [];
voice.options.onTranscript = ({ role, text, final }) => captions.push({ role, text, final });
socket.deliver({ serverContent: { outputTranscription: { text: 'Looking now.' } } });
socket.deliver({ serverContent: { outputTranscription: { text: ' It is your inbox.', finished: true } } });
note(captions.some((caption) => caption.text.includes('It is your inbox')), 'his speech becomes a caption bubble');

// ── And a tool that changes nothing about pictures still works ──────────────

socket.deliver({ toolCall: { functionCalls: [{ id: 'fc2', name: 'point_at', args: { target_id: 'W12' } }] } });
await new Promise((resolve) => setTimeout(resolve, 30));
note(toolCalls.length === 2 && toolCalls[1].args.target_id === 'W12', 'tool arguments arrive parsed');
note(socket.events('toolResponse').length === 2, 'the second tool gets its own response');

voice.close();

// ── A model Google has retired must not leave him mute ──────────────────────

let attempts = 0;
class RetiredModelSocket extends FakeSocket {
  constructor(url) {
    super(url);
    attempts += 1;
    this.attempt = attempts;
    this.acknowledges = false;
  }
  send(raw) {
    // Recorded like the real thing, but the first attempt is turned away
    // before the session is ever acknowledged — a retired model.
    const payload = JSON.parse(raw);
    this.sent.push(payload);
    if (!payload.setup) return;
    if (this.attempt === 1) setTimeout(() => this.onclose?.({ code: 1007, reason: 'model not found' }), 5);
    else setTimeout(() => this.deliver({ setupComplete: {} }), 2);
  }
}

const socketFor = globalThis.WebSocket;
globalThis.WebSocket = RetiredModelSocket;
attempts = 0;
const socketsBefore = FakeSocket.all.length;
const retryVoice = new LiveVoice({ onTool: async () => ({ ok: true, text: '' }), onStatus: () => undefined });
const firstModel = 'gemini-2.0-gone';
try {
  await retryVoice.connect({
    token: 't2',
    wsUrl: 'wss://example/…',
    session: { model: firstModel, instructions: 'x', voice: 'Puck', tools: [] },
    pushToTalk: true,
    voiceOut: false
  });
} catch {
  /* if every model fails that is a real error, asserted below */
}
const retried = FakeSocket.last; // the newest socket created
note(attempts >= 2, `a retired model is retried rather than given up on (${attempts} attempts)`);
const sentModels = FakeSocket.all.slice(socketsBefore)
  .map((socket) => socket.sent.find((payload) => payload.setup)?.setup?.model)
  .filter(Boolean);
note(sentModels[0] === `models/${firstModel}`, `the named model is tried first (${sentModels[0]})`);
note(sentModels[1] && sentModels[1] !== `models/${firstModel}`, `then a known-good one (${sentModels[1]})`);
note(retryVoice.connected, 'the session ends up connected');
note(Boolean(retryVoice.micNode), 'the microphone survived the retry');
retryVoice.close();
globalThis.WebSocket = socketFor;

console.log(`\n${problems.length === 0 ? 'all good' : `${problems.length} problem(s)`}`);
for (const problem of problems) console.log(` - ${problem}`);
process.exit(problems.length === 0 ? 0 : 1);
