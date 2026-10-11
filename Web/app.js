/**
 * Buddy on the phone.
 *
 * This page is the whole "phone app": the face, the ears, the chirp and the
 * bubble. It talks to the computer over one websocket (the same newline-JSON
 * packet protocol the original used) and to the voice model through whatever
 * link the computer hands it — so the API key never comes near the phone.
 *
 * Gestures, the same as the original:
 *   double tap        wake up / go to sleep
 *   press and hold    ask something
 *   (hold longer)     keep talking; let go and he answers
 */

import { BuddyFace } from './face.js';
import { LiveVoice } from './live.js';

const face = new BuddyFace(document.getElementById('face'));
const els = {
  status: document.getElementById('status'),
  statusDot: document.getElementById('status-dot'),
  bubble: document.getElementById('bubble'),
  bubbleText: document.getElementById('bubble-text'),
  hint: document.getElementById('hint'),
  settings: document.getElementById('settings'),
  settingsBody: document.getElementById('settings-body'),
  settingsClose: document.getElementById('settings-close'),
  topbar: document.getElementById('topbar'),
  name: document.getElementById('buddy-name'),
  overlay: document.getElementById('overlay'),
  overlayTitle: document.getElementById('overlay-title'),
  overlayBody: document.getElementById('overlay-body'),
  overlayAction: document.getElementById('overlay-action'),
  chirpToggle: document.getElementById('toggle-chirp'),
  voiceToggle: document.getElementById('toggle-voice'),
  handsFreeToggle: document.getElementById('toggle-handsfree')
};

const state = {
  awake: false,
  events: null,
  outbox: Promise.resolve(),
  onlineTimer: null,
  connectedToMac: false,
  hostName: 'your computer',
  hostId: null,
  deviceId: getDeviceId(),
  deviceName: deviceLabel(),
  deviceToken: getDeviceToken(),
  paired: Boolean(getDeviceToken()),
  pairing: false,
  live: null,
  session: null,
  settings: null,
  pendingTools: new Map(),
  chirp: true,
  voiceOut: false,
  handsFree: false,
  bubbleTimer: null,
  recording: false,
  holding: false,
  lastTap: 0,
  sound: null
};

// ── Sound: a little cartoon chirp, synthesised so there's nothing to download ──

function chirp(kind = 'up') {
  if (!state.chirp) return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    state.sound ||= new Ctx({ sampleRate: 24000 });
    const ctx = state.sound;
    if (ctx.state === 'suspended') ctx.resume().catch(() => undefined);
    const now = ctx.currentTime;
    const notes = kind === 'up' ? [660, 990] : kind === 'down' ? [520, 380] : [780];
    notes.forEach((frequency, index) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(frequency, now + index * 0.07);
      gain.gain.setValueAtTime(0.0001, now + index * 0.07);
      gain.gain.exponentialRampToValueAtTime(0.07, now + index * 0.07 + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + index * 0.07 + 0.12);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + index * 0.07);
      osc.stop(now + index * 0.07 + 0.14);
    });
  } catch {
    /* sound is a luxury */
  }
}

// ── The link to the computer ─────────────────────────────────────────────────

/**
 * The link to the computer.
 *
 * Browsers cannot open raw sockets, so the computer speaks HTTP to us instead:
 * one long-lived event stream coming down (`/api/events`) and small POSTs going
 * up (`/api/send`). Same packets the original app sent, just wrapped in HTTP —
 * and this shape works whether the page is served by the Mac itself or by the
 * little bridge that sits beside it.
 */
function connectToMac() {
  state.events?.close();
  if (!state.deviceToken) {
    // Unpaired: the stream would only be refused. Point at the setup link.
    setStatus('offline', 'Not paired');
    face.setMood('sleepy');
    showPairingHelp();
    return;
  }
  setStatus('connecting', 'Finding your computer…');

  let events;
  try {
    events = new EventSource(state.deviceToken ? `./api/events?token=${encodeURIComponent(state.deviceToken)}` : './api/events');
  } catch {
    setTimeout(connectToMac, 2000);
    return;
  }
  state.events = events;

  events.onopen = () => {
    const wasOffline = !state.connectedToMac;
    state.connectedToMac = true;
    clearTimeout(state.onlineTimer);
    state.onlineTimer = null;
    send({ hello: state.deviceName });
    send({ command: 'webClient' });
    setStatus('ready', 'Connected');
    hideOverlay();
    if (wasOffline) chirp('up');
    // What the computer knows about him — his voice, his model — without
    // asking for a credential yet. That wait happens at the press.
    requestInfo().catch(() => undefined);
  };

  events.onmessage = (event) => {
    let packet;
    try {
      packet = JSON.parse(event.data);
    } catch {
      return;
    }
    state.connectedToMac = true;
    handlePacket(packet);
  };

  events.onerror = () => {
    if (!state.deviceToken) {
      // No token: the bridge will not open the stream. Say what to do about it
      // instead of hammering a locked door.
      state.events?.close();
      state.events = null;
      showPairingHelp();
      return;
    }
    // EventSource reconnects by itself while the page is open. Only when it
    // gives up entirely do we rebuild the stream, so a sleeping laptop or a
    // walk out of Wi-Fi range heals on its own without flashing an overlay.
    if (state.events === events && events.readyState === EventSource.CLOSED) {
      state.events = null;
      setTimeout(connectToMac, 2000);
      return;
    }
    if (state.onlineTimer) return;
    state.connectedToMac = false;
    state.onlineTimer = setTimeout(() => {
      state.onlineTimer = null;
      if (state.connectedToMac) return;
      state.awake = false;
      endSession();
      face.setMood('sleepy');
      setStatus('offline', 'Looking for your computer…');
      showOverlay(
        'Waiting for your computer',
        "Make sure the Buddy app is running on your Mac and that you're on the same Wi-Fi. This page will reconnect on its own.",
        'Try again',
        () => connectToMac()
      );
    }, 6000);
  };
}

/**
 * Post a packet up to the computer. Sends are chained so they arrive in the
 * order they were made (a `hello` before the `awake` that follows it), and the
 * promise resolves with whether it actually landed.
 */
function send(packet) {
  state.outbox = state.outbox
    .catch(() => undefined)
    .then(async () => {
      try {
        const response = await api('./api/send', { method: 'POST', body: JSON.stringify(packet) });
        if (response.ok) state.connectedToMac = true;
        return response.ok;
      } catch {
        return false;
      }
    });
  return state.outbox;
}

/**
 * Talk to the bridge, with this phone's paired-device token attached.
 *
 * The bridge only answers a device it has been introduced to — the token is
 * what says "this is the phone the user paired", and it never leaves the phone
 * except in this header. A 401 means the phone was revoked (or never paired),
 * which is worth explaining on screen rather than retrying forever.
 */
async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(state.deviceToken ? { authorization: `Bearer ${state.deviceToken}` } : {}),
      ...(options.headers || {})
    }
  });
  if (response.status === 401 || response.status === 403) {
    state.paired = false;
    const detail = await response.json().catch(() => ({}));
    const error = new Error(detail.error || 'This phone is no longer paired with your computer.');
    error.pairing = true;
    showPairingHelp(detail.hint);
    throw error;
  }
  return response;
}

/**
 * Ask the bridge for a fresh voice credential, for one named model, at the
 * last possible moment — the window in which a token can start a session is
 * about a minute, so anything fetched earlier is worthless by the time the
 * user presses the screen.
 */
async function requestSession(model = null) {
  const response = await api('./api/session', {
    method: 'POST',
    body: JSON.stringify({
      model: model || undefined,
      device: state.deviceId,
      name: state.deviceName,
      wants: state.voiceOut ? 'audio' : 'text'
    })
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail.error || `session request failed (${response.status})`);
  }
  const payload = await response.json();
  state.session = payload;
  state.settings = payload.settings || state.settings;
  if (payload.host?.name) state.hostName = payload.host.name;
  applySettingsToUi();
  return payload;
}

/** What the computer knows about him, without starting any token's clock. */
async function requestInfo() {
  if (!state.deviceToken) return null;
  const response = await api('./api/info').catch(() => null);
  if (!response?.ok) return null;
  const info = await response.json().catch(() => null);
  if (!info) return null;
  state.settings = info.settings || state.settings;
  if (info.host?.name) state.hostName = info.host.name;
  applySettingsToUi();
  return info;
}

/**
 * Pairing: the user scans a code the bridge printed, so this page arrives with
 * ?pair=<secret>. Trading it here, once, is what makes this phone *this user's*
 * phone — and it is what keeps someone else on the same Wi-Fi out.
 */
async function pairFromUrl() {
  const url = new URL(window.location.href);
  const secret = url.searchParams.get('pair');
  if (!secret || state.pairing) return false;
  state.pairing = true;
  setStatus('connecting', 'Pairing with your computer…');
  try {
    const response = await fetch('./api/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret, name: state.deviceName })
    });
    const detail = await response.json().catch(() => ({}));
    if (!response.ok || !detail.token) {
      state.pairing = false;
      showOverlay('That pairing link did not work', detail.error || 'Ask the computer for a fresh one.', 'Try again', () => pairFromUrl());
      return false;
    }
    state.deviceToken = detail.token;
    state.paired = true;
    localStorage.setItem('buddy.token', detail.token);
    state.deviceId = detail.device?.id || state.deviceId;
    localStorage.setItem('buddy.device', state.deviceId);
    // Keep the secret out of the address bar (and out of any bookmark, history
    // or screenshot) now that it has been spent.
    url.searchParams.delete('pair');
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
    chirp('up');
    setStatus('ready', 'Paired');
    hideOverlay();
    return true;
  } catch (error) {
    state.pairing = false;
    showOverlay('Could not reach your computer', error.message || 'Check that you are on the same Wi-Fi.', 'Try again', () => pairFromUrl());
    return false;
  }
}

function showPairingHelp(hint) {
  showOverlay(
    'This phone is not paired',
    hint || 'Open the setup link the Buddy bridge printed (or scan its QR code) to pair this phone.',
    'Pair again',
    () => {
      if (!state.deviceToken) window.location.reload();
      else setStatus('offline', 'Not paired');
    }
  );
}

// ── Packets from the computer ───────────────────────────────────────────────

function handlePacket(packet) {
  if (packet.hello) {
    state.hostName = packet.hello;
    els.name.textContent = 'Buddy';
    document.title = `Buddy — ${packet.hello}`;
  }

  if (packet.face) {
    const { mood, gazeX, gazeY, talk } = packet.face;
    if (mood) face.setMood(mapMood(mood));
    face.setGaze(gazeX ?? 0, gazeY ?? 0);
    face.setTalk(talk ?? 0);
  }

  // Something to show in the bubble right now — the computer passing on what
  // he is saying, his notes, or the little demo that runs without a Mac.
  if (packet.command === 'caption' && packet.text) {
    showBubble(packet.text);
    face.setMood('talking');
    send({ command: 'captionDone', text: packet.text });
  }

  // The Mac asking us to do something (start/stop a session, test the voice).
  if (packet.command === 'wake') wake();
  if (packet.command === 'sleep') sleep();
  if (packet.command === 'testVoice') chirp('up');
  if (packet.command === 'settings' && packet.text) {
    try {
      const incoming = JSON.parse(packet.text);
      state.settings = { ...(state.settings || {}), ...incoming };
      applySettingsToUi();
      firstRunGreeting(incoming);
    } catch {
      /* ignore */
    }
  }
  if (packet.command === 'stopSpeech') state.live?.interrupt();

  // A tool the model asked for, answered by the Mac.
  if (packet.command === 'toolResult' && packet.callID) {
    const pending = state.pendingTools.get(packet.callID);
    if (pending) {
      state.pendingTools.delete(packet.callID);
      pending({ ok: true, text: packet.text || '', image: packet.image || undefined });
    }
  }
}

/**
 * The very first time someone opens him, he says hello and tells them what to
 * do — or, if something is still missing, exactly what that is. Once per
 * browser: after that it would just be noise.
 */
function firstRunGreeting(info = {}) {
  try {
    if (localStorage.getItem('buddy.greeted')) return;
    localStorage.setItem('buddy.greeted', '1');
  } catch {
    return; // no storage (private mode): better to stay quiet than to repeat
  }
  if (info.demo) {
    showBubble("I'm Buddy. This is demo mode — hook up your computer and I can really see your screen and do things.");
  } else if (info.hasKey === false) {
    showBubble("I'm Buddy, but I haven't got a voice key yet. Open my menu in your Mac's menu bar and choose “Voice Key (free Gemini)…”.");
  } else {
    showBubble("Hi, I'm Buddy. Hold the screen and talk to me — let go and I'll answer.");
  }
}

const mapMood = (mood) =>
  ({
    listening: 'listening',
    resting: 'resting',
    thinking: 'thinking',
    talking: 'talking',
    pointing: 'pointing',
    happy: 'happy',
    sleepy: 'sleepy'
  })[mood] || 'listening';

/** Forward a tool call to the computer and wait for what it did. */
function callTool(call) {
  return new Promise((resolve) => {
    const callID = call.id || `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    state.pendingTools.set(callID, resolve);
    send({
      command: 'tool',
      callID,
      tool: call.name,
      text: JSON.stringify(call.args || {})
    }).then((sent) => {
      if (!sent) {
        state.pendingTools.delete(callID);
        resolve({ ok: false, error: 'the computer is not connected' });
      }
    });
    // Never leave the model hanging on a tool that never answers.
    setTimeout(() => {
      if (state.pendingTools.has(callID)) {
        state.pendingTools.delete(callID);
        resolve({ ok: false, error: 'the computer took too long' });
      }
    }, 40000);

    if (call.name === 'look_at_screen') face.setMood('thinking');
    if (call.name === 'point_at' || call.name === 'point_at_spot') face.setMood('pointing');
  });
}

// ── Sessions ────────────────────────────────────────────────────────────────

async function wake() {
  if (state.awake) return;
  state.awake = true;
  face.setMood('waking');
  chirp('up');
  send({ command: 'awake' });
  setStatus('ready', 'Waking up…');

  try {
    // A credential is asked for *now*, in the same breath as connecting: the
    // one the page fetched when it loaded is long past its window, and a
    // single-use token that was already tried cannot be used again.
    const session = await requestSession();
    if (!session.live) {
      // No realtime provider: the computer can still do everything, but the
      // talking has to happen on-device.
      startLocalVoice();
      return;
    }
    await startRealtime(session.live);
  } catch (error) {
    face.setMood('error');
    setStatus('offline', 'No voice yet');
    showOverlay(
      'He has no voice yet',
      `${error.message}. Add a free Gemini key on the computer (aistudio.google.com/apikey) and restart the Buddy app, or use on-device voice below.`,
      'Use on-device voice',
      () => startLocalVoice()
    );
  }
}

async function startRealtime(live) {
  endSession();
  const voice = new LiveVoice({
    onStatus: (status, detail) => {
      if (status === 'ready') {
        face.setMood(state.handsFree ? 'listening' : 'listening');
        setStatus('ready', state.handsFree ? 'Listening' : 'Hold the screen to talk');
      }
      if (status === 'thinking') setStatus('ready', 'Thinking…');
      if (status === 'listening') face.setMood('listening');
      if (status === 'reconnect') {
        setStatus('connecting', detail || 'Reconnecting…');
        reconnectSoon();
      }
      if (status === 'closed') {
        setStatus('offline', 'Voice stopped');
      }
    },
    onTranscript: ({ role, text, final }) => {
      if (role === 'you') {
        if (!final) showHint(text);
        else showHint('');
        if (final) face.setMood('thinking');
        return;
      }
      showBubble(text);
      face.setMood('talking');
      send({ command: 'caption', text });
      if (final) {
        send({ command: 'captionDone', text });
        setTimeout(() => {
          if (!state.holding) face.setMood(state.handsFree ? 'listening' : 'resting');
        }, Math.min(9000, 1200 + text.split(' ').length * 260));
      }
    },
    onTool: async (call) => {
      const result = await callTool(call);
      return result;
    },
    onLevel: (level) => {
      // His mouth follows his own voice, or yours while you talk.
      if (state.lastWasBuddy) face.setTalk(level * 0.35);
    },
    onError: (message) => {
      setStatus('error', message);
      face.setMood('error');
    },
    onClose: () => {
      state.live = null;
      if (state.awake) reconnectSoon();
    }
  });
  try {
    await voice.connect({
      token: live.token,
      wsUrl: live.wsUrl,
      // The session the token is pinned to, when the bridge sent one: sending
      // exactly this is what makes a constrained token work.
      setup: live.setup,
      session: live.session,
      newSessionExpiresAt: live.newSessionExpiresAt,
      // Every retry inside connect() asks for its own fresh credential, for
      // the model it is about to try — never a used one.
      mint: (model) => requestSession(model),
      voiceOut: state.voiceOut,
      pushToTalk: !state.handsFree,
      ambient: true
    });
    state.live = voice;
    voice.setVoiceOut(state.voiceOut);
    if (state.holding) voice.beginHold();
  } catch (error) {
    state.live = null;
    throw error;
  }
}

let reconnectTimer = null;
function reconnectSoon() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(async () => {
    if (!state.awake) return;
    try {
      // A reconnect after a drop gets a brand-new credential too: the old one
      // was either spent on the session that just ended or is past its window.
      const session = await requestSession();
      if (session.live) await startRealtime(session.live);
      else startLocalVoice();
    } catch (error) {
      setStatus('offline', error.message || 'Voice stopped');
      face.setMood('error');
    }
  }, 1200);
}

function sleep() {
  if (!state.awake) return;
  state.awake = false;
  chirp('down');
  face.setMood('sleepy');
  send({ command: 'asleep' });
  setTimeout(() => !state.awake && face.setMood('asleep'), 1200);
  setStatus('ready', 'Double tap to wake him');
  endSession();
}

function endSession() {
  clearTimeout(reconnectTimer);
  state.live?.close();
  state.live = null;
  for (const [, resolve] of state.pendingTools) resolve({ ok: false, error: 'session ended' });
  state.pendingTools.clear();
}

/**
 * On-device voice: the browser listens and speaks, and the computer still does
 * the seeing, pointing and doing. Works with no key at all, and it's the
 * fallback when the realtime service can't be reached.
 */
function startLocalVoice() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    showOverlay('On-device voice is not available', 'This browser has no speech recognition. Safari and Chrome do.', 'Close', hideOverlay);
    return;
  }
  face.setMood('listening');
  setStatus('ready', 'On-device voice — hold to talk');
  state.localRecognition ||= new Recognition();
  const recognition = state.localRecognition;
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.lang = navigator.language || 'en-US';
  let finalText = '';
  recognition.onresult = (event) => {
    finalText = '';
    for (let i = 0; i < event.results.length; i += 1) finalText += event.results[i][0].transcript;
    showHint(finalText);
  };
  recognition.onerror = () => setStatus('ready', 'Didn\'t catch that');
  recognition.onend = async () => {
    showHint('');
    if (!finalText.trim()) {
      face.setMood('resting');
      return;
    }
    await askLocally(finalText.trim());
  };
  state.localWake = () => {
    try {
      recognition.start();
    } catch {
      /* already listening */
    }
  };
  // Woken up mid-press: don't make them lift and press again.
  if (state.holding) state.localWake();
}

async function askLocally(text) {
  face.setMood('thinking');
  try {
    const response = await api('./api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, device: state.deviceId })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'the computer could not answer');
    const reply = payload.text || '';
    showBubble(reply);
    send({ command: 'caption', text: reply });
    send({ command: 'captionDone', text: reply });
    face.setMood('talking');
    speakLocally(reply);
  } catch (error) {
    setStatus('error', error.message);
    face.setMood('error');
  }
}

function speakLocally(text) {
  if (!state.voiceOut || !text) return;
  try {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.05;
    utterance.pitch = 1.15;
    const voices = speechSynthesis.getVoices();
    const preferred = voices.find((voice) => /Samantha|Google UK English Female|Zoe|Karen/i.test(voice.name));
    if (preferred) utterance.voice = preferred;
    utterance.onend = () => face.setMood('resting');
    speechSynthesis.speak(utterance);
  } catch {
    /* no voice, no problem */
  }
}

// ── Gestures ────────────────────────────────────────────────────────────────

function bindGestures() {
  let holdStarted = 0;
  const surface = document.getElementById('surface');

  const down = (event) => {
    if (event.target.closest('.no-hold')) return;
    holdStarted = Date.now();
    state.holding = true;

    if (state.handsFree) return;
    if (!state.awake) wake();

    if (!state.live && state.localWake) {
      state.localWake();
      return;
    }
    state.live?.beginHold();
    face.setMood('listening');
    setStatus('ready', 'Listening…');
  };

  const up = () => {
    state.holding = false;
    if (state.handsFree) return;
    const held = Date.now() - holdStarted;
    if (held < 220) return; // too short to be a question
    state.live?.endHold();
    face.setMood('thinking');
  };

  surface.addEventListener('pointerdown', down);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);

  // Double tap: wake or sleep.
  surface.addEventListener('dblclick', () => {
    if (state.awake) sleep();
    else wake();
  });
  surface.addEventListener('click', () => {
    const now = Date.now();
    if (now - state.lastTap < 320) {
      state.lastTap = 0;
      if (state.awake) sleep();
      else wake();
    } else {
      state.lastTap = now;
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && state.live) state.live.setMuted(true);
    else state.live?.setMuted(false);
  });

  window.addEventListener('beforeunload', () => state.live?.close());
}

// ── Small UI helpers ────────────────────────────────────────────────────────

function setStatus(kind, text) {
  els.statusDot.dataset.kind = kind;
  els.status.textContent = text;
}

function showHint(text) {
  els.hint.textContent = text || '';
  els.hint.classList.toggle('visible', Boolean(text));
}

function showBubble(text) {
  if (!text?.trim()) return;
  state.lastWasBuddy = true;
  els.bubbleText.textContent = text.trim();
  els.bubble.classList.add('visible');
  clearTimeout(state.bubbleTimer);
  state.bubbleTimer = setTimeout(() => {
    els.bubble.classList.remove('visible');
    state.lastWasBuddy = false;
  }, Math.min(14000, 2600 + text.split(' ').length * 300));
}

function showOverlay(title, body, actionLabel, action) {
  els.overlayTitle.textContent = title;
  els.overlayBody.textContent = body;
  els.overlayAction.textContent = actionLabel || 'Retry';
  els.overlayAction.onclick = () => {
    hideOverlay();
    action?.();
  };
  els.overlay.classList.add('visible');
}

function hideOverlay() {
  els.overlay.classList.remove('visible');
}

function applySettingsToUi() {
  const settings = state.settings || {};
  state.chirp = settings.chime !== false;
  els.chirpToggle.checked = state.chirp;
  els.voiceToggle.checked = state.voiceOut;
  els.handsFreeToggle.checked = state.handsFree;
  if (settings.name) els.name.textContent = settings.name;
  renderSettings();
}

function renderSettings() {
  const settings = state.settings || {};
  const rows = [
    ['Computer', state.hostName],
    ['Voice', settings.voice || 'Puck'],
    ['Computer use', settings.computerUse === false ? 'off — he can look and point only' : 'on'],
    ['Memories', `${(settings.memoryCount ?? 0)} saved`],
    ['Simulate mode', settings.simulated ? 'yes — a pretend screen' : 'no — real screen'],
    ['Voice session', state.session?.live ? state.session.live.setup?.model || state.session.live.session?.model || state.session.live.model || 'ready' : 'not connected']
  ];
  els.settingsBody.innerHTML = rows
    .map(
      ([label, value]) => `<div class="row"><span class="label">${escapeHtml(label)}</span><span class="value">${escapeHtml(String(value))}</span></div>`
    )
    .join('');
  els.settingsBody.insertAdjacentHTML(
    'beforeend',
    `<div class="row"><span class="label">Personality</span><span class="value">edit it on the computer — he keeps one personality everywhere</span></div>`
  );
  els.settingsBody.insertAdjacentHTML(
    'beforeend',
    `<div class="row"><span class="label">This phone</span><span class="value">${
      state.paired ? `paired with ${escapeHtml(state.hostName)}` : 'not paired'
    } <button class="link" id="unpair">${state.paired ? 'unpair' : 'how to pair'}</button></span></div>`
  );
  document.getElementById('unpair')?.addEventListener('click', () => {
    if (!state.paired) {
      showPairingHelp();
      return;
    }
    if (!window.confirm('Forget the computer on this phone? You will have to scan the setup code again.')) return;
    // The bridge is told as well, so the token is dead on both sides.
    api('./api/unpair', { method: 'POST' }).catch(() => undefined);
    forgotComputer();
  });
}

/** Forget the computer on this phone: no token, no stream, no credentials. */
function forgotComputer() {
  state.paired = false;
  state.deviceToken = '';
  try {
    localStorage.removeItem('buddy.token');
  } catch {
    /* nothing to forget */
  }
  endSession();
  state.events?.close();
  state.events = null;
  face.setMood('sleepy');
  setStatus('offline', 'Not paired');
  showPairingHelp();
}

const escapeHtml = (value) =>
  value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

function getDeviceToken() {
  try {
    return localStorage.getItem('buddy.token') || '';
  } catch {
    return ''; // private mode: he still works, the phone just has to pair each visit
  }
}

function getDeviceId() {
  let id = localStorage.getItem('buddy.device');
  if (!id) {
    id = `web_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
    localStorage.setItem('buddy.device', id);
  }
  return id;
}

function deviceLabel() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Macintosh/.test(ua)) return 'Mac browser';
  return 'Browser';
}

// ── Boot ────────────────────────────────────────────────────────────────────

async function boot() {
  bindGestures();
  setStatus('connecting', 'Looking for your computer…');
  face.setMood('sleepy');
  await pairFromUrl();
  connectToMac();

  // Keep the shell cached so tapping his icon shows his face immediately, even
  // before the computer answers. (Browsers only allow this on trusted
  // addresses, which is the same condition the microphone has.)
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('./sw.js').catch(() => undefined);
  }

  els.settingsClose.addEventListener('click', () => els.settings.classList.remove('visible'));
  document.getElementById('gear').addEventListener('click', (event) => {
    event.stopPropagation();
    els.settings.classList.toggle('visible');
    renderSettings();
  });
  document.getElementById('power').addEventListener('click', (event) => {
    event.stopPropagation();
    if (state.awake) sleep();
    else wake();
  });

  els.chirpToggle.addEventListener('change', () => {
    state.chirp = els.chirpToggle.checked;
  });
  els.voiceToggle.addEventListener('change', () => {
    state.voiceOut = els.voiceToggle.checked;
    state.live?.setVoiceOut(state.voiceOut);
    if (!state.voiceOut) speechSynthesis?.cancel?.();
  });
  els.handsFreeToggle.addEventListener('change', () => {
    state.handsFree = els.handsFreeToggle.checked;
    state.live?.setPushToTalk(!state.handsFree);
    setStatus('ready', state.handsFree ? 'Listening' : 'Hold the screen to talk');
  });

  // Reconnect faster when the phone comes back to the app.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !state.connectedToMac) connectToMac();
  });
}

boot();
