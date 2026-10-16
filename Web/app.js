/**
 * Buddy on the phone.
 *
 * This page is the whole "phone app": the face, the ears, the chirp and the
 * bubble. It talks to the computer through the little bridge server — an event
 * stream coming down (SSE) and small POSTs going up (/api/send, /api/session,
 * /api/chat). The ears and mouth are the speech the phone already has
 * (SpeechRecognition + SpeechSynthesis): free, unlimited, no key. The thinking
 * happens on the computer, on a free open-source model (Ollama).
 *
 * Gestures:
 *   double tap        wake up / go to sleep
 *   press and hold    ask something (browser listens while you hold)
 *   release           he thinks, then answers in text + spoken voice
 */

import { BuddyFace } from './face.js';

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
  session: null,
  settings: null,
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
  setStatus('connecting', 'Finding your computer…');

  let events;
  try {
    events = new EventSource('./api/events');
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
    requestSession().catch(() => undefined);
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
        const response = await fetch('./api/send', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(packet)
        });
        if (response.ok) state.connectedToMac = true;
        return response.ok;
      } catch {
        return false;
      }
    });
  return state.outbox;
}

/** Ask the bridge who he is: his instructions, which model he thinks with, and his settings. */
async function requestSession() {
  const response = await fetch('./api/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ device: state.deviceId, name: state.deviceName, wants: state.voiceOut ? 'audio' : 'text' })
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
  if (packet.command === 'stopSpeech') speechSynthesis?.cancel?.();
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
  } else if (info.brain && info.brain.ready === false) {
    showBubble("I'm Buddy, but I can't find my brain yet. Start Ollama on your computer (ollama serve) with a model pulled.");
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

// ── Sessions ────────────────────────────────────────────────────────────────

async function wake() {
  if (state.awake) return;
  state.awake = true;
  face.setMood('waking');
  chirp('up');
  send({ command: 'awake' });
  setStatus('ready', 'Waking up…');

  // His ears and mouth are the speech the phone already has — free, unlimited,
  // no key. The thinking happens on the computer, on a free open-source model.
  if (!state.session) {
    try {
      await requestSession();
    } catch {
      /* the stream reconnect will try again; voice still works */
    }
  }
  startLocalVoice();
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
  try {
    speechSynthesis?.cancel?.();
  } catch {
    /* nothing speaking */
  }
}

/**
 * His voice: the phone's own speech. The browser listens while you hold the
 * screen, the computer thinks, and the browser speaks the answer back. There is
 * no key and no quota — it comes with Safari and Chrome — and it is the only
 * voice path now, so there is nothing to fall back from.
 */
function startLocalVoice() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    showOverlay(
      'This browser has no speech recognition',
      'You can still type to him; try Safari or Chrome for voice.',
      'Close',
      hideOverlay
    );
    return;
  }

  face.setMood(state.handsFree ? 'listening' : 'resting');
  setStatus('ready', state.handsFree ? 'Listening' : 'Hold the screen to talk');

  state.localRecognition ||= new Recognition();
  const recognition = state.localRecognition;
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.lang = navigator.language || 'en-US';

  let heard = '';
  recognition.onresult = (event) => {
    heard = '';
    for (let i = 0; i < event.results.length; i += 1) heard += event.results[i][0].transcript;
    showHint(heard);
  };
  recognition.onerror = () => {
    showHint('');
    setStatus('ready', "Didn't catch that");
  };
  recognition.onend = async () => {
    showHint('');
    const question = heard.trim();
    heard = '';
    if (!question) {
      face.setMood(state.handsFree ? 'listening' : 'resting');
      return;
    }
    await askLocally(question);
  };

  state.localWake = () => {
    try {
      recognition.start();
    } catch {
      /* already listening */
    }
    face.setMood('listening');
    setStatus('ready', 'Listening…');
  };
  state.localStop = () => {
    try {
      recognition.stop();
    } catch {
      /* not listening */
    }
  };

  // Woken up mid-press: don't make them lift and press again.
  if (state.holding || state.handsFree) state.localWake();
}

async function askLocally(text) {
  face.setMood('thinking');
  try {
    const response = await fetch('./api/chat', {
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
    state.localWake?.();
  };

  const up = () => {
    state.holding = false;
    if (state.handsFree) return;
    const held = Date.now() - holdStarted;
    if (held < 220) return; // too short to be a question
    state.localStop?.();
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
    // Leaving the page mid-question: stop listening so he isn't overheard.
    if (document.hidden) state.localStop?.();
  });
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
  els.bubbleText.textContent = text.trim();
  els.bubble.classList.add('visible');
  clearTimeout(state.bubbleTimer);
  state.bubbleTimer = setTimeout(() => {
    els.bubble.classList.remove('visible');
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
  const brain = settings.brain || state.session?.brain || {};
  const rows = [
    ['Computer', state.hostName],
    ['Voice', 'the phone’s own (free)'],
    ['Brain', brain.model || state.session?.model || 'local model'],
    ['Model server', brain.host || 'http://127.0.0.1:11434'],
    ['Computer use', settings.computerUse === false ? 'off — he can look and point only' : 'on']
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
}

const escapeHtml = (value) =>
  value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

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

function boot() {
  bindGestures();
  setStatus('connecting', 'Looking for your computer…');
  face.setMood('sleepy');
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
    if (!state.voiceOut) speechSynthesis?.cancel?.();
  });
  els.handsFreeToggle.addEventListener('change', () => {
    state.handsFree = els.handsFreeToggle.checked;
    setStatus('ready', state.handsFree ? 'Listening' : 'Hold the screen to talk');
    if (state.handsFree) state.localWake?.();
  });

  // Reconnect faster when the phone comes back to the app.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !state.connectedToMac) connectToMac();
  });
}

boot();
