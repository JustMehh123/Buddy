/**
 * The voice session: a live socket to a speech-to-speech model, plus the ears
 * and the mouth that feed it.
 *
 * Gemini's Live API is the default because its free tier covers realtime voice,
 * which is the whole point of Buddy. The protocol here is:
 *
 *   open  →  {setup: {...}}                      → {setupComplete: {}}
 *   hold  →  {realtimeInput:{activityStart:{}}}
 *           {realtimeInput:{audio:{data,mimeType}}}
 *   let go→  {realtimeInput:{activityEnd:{}}}   → {serverContent:{...}}
 *   tools ←  {toolCall:{functionCalls:[...]}}   → {toolResponse:{functionResponses:[...]}}
 *
 * Everything the model says comes back as text (outputAudioTranscription) and,
 * if the user wants to hear him, as 24 kHz PCM we push into an audio worklet.
 * Either way the Mac shows a speech bubble, which is how the original behaved.
 */

const AUDIO_IN_HZ = 16000;
const AUDIO_OUT_HZ = 24000;

export class LiveVoice {
  /**
   * @param {object} options
   * @param {() => void} [options.onOpen]
   * @param {(status: string, detail?: string) => void} [options.onStatus]
   * @param {(chunk: {role: 'you'|'buddy', text: string, final: boolean}) => void} [options.onTranscript]
   * @param {(call: {id: string, name: string, args: object}) => Promise<object>} [options.onTool]
   * @param {(level: number) => void} [options.onLevel]
   * @param {(message: string) => void} [options.onError]
   * @param {() => void} [options.onClose]
   */
  constructor(options = {}) {
    this.options = options;
    this.socket = null;
    this.micContext = null;
    this.outContext = null;
    this.micNode = null;
    this.outNode = null;
    this.stream = null;
    this.connected = false;
    this.holding = false;
    this.muted = false;
    this.voiceOut = false;
    this.pushToTalk = true;
    this.ambientEnabled = true;
    this.ambient = [];
    this.userBuffer = '';
    this.buddyBuffer = '';
    this.toolChain = Promise.resolve();
    this.lastGoAway = 0;
    this.openedAt = 0;
  }

  get isConnected() {
    return this.connected;
  }

  /** Must be called from a user gesture: iOS refuses audio any other way. */
  async connect(config) {
    this.config = config;
    this.voiceOut = Boolean(config.voiceOut);
    this.pushToTalk = config.pushToTalk !== false;
    this.ambientEnabled = config.ambient !== false;

    this.options.onStatus?.('connecting');
    await this.prepareAudio();

    const url = `${config.wsUrl}?access_token=${encodeURIComponent(config.token)}`;
    await new Promise((resolve, reject) => {
      let settled = false;
      const socket = new WebSocket(url);
      this.socket = socket;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        reject(error instanceof Error ? error : new Error(String(error)));
      };

      const timeout = setTimeout(() => fail(new Error('The voice connection timed out.')), 12000);

      socket.onopen = () => {
        clearTimeout(timeout);
        this.connected = true;
        this.openedAt = Date.now();
        this.sendSetup(config);
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      socket.onmessage = (event) => this.handleMessage(event.data);
      socket.onerror = () => fail(new Error('Could not reach the voice service.'));
      socket.onclose = (event) => {
        clearTimeout(timeout);
        const wasConnected = this.connected;
        this.connected = false;
        this.options.onStatus?.('closed', event.reason || `code ${event.code}`);
        if (!wasConnected) fail(new Error(event.reason || 'The voice service closed the connection.'));
        else this.options.onClose?.();
      };
    });

    this.startAmbient();
    this.options.onStatus?.('ready');
  }

  /** The `setup` message: who he is, what he can do, and how he should sound. */
  sendSetup(config) {
    const session = config.session || {};
    const setup = {
      model: `models/${session.model || config.model || 'gemini-3.1-flash-live-preview'}`,
      generationConfig: {
        responseModalities: ['AUDIO'],
        temperature: typeof session.temperature === 'number' ? session.temperature : 0.85,
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: normaliseVoice(session.voice || config.voice || 'Puck') }
          }
        }
      },
      systemInstruction: { parts: [{ text: session.instructions || '' }] },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      // Long conversations would otherwise hit the context limit; this lets him
      // run all day without losing the thread.
      contextWindowCompression: { slidingWindow: {} }
    };

    if (session.tools?.length) {
      setup.tools = [{ functionDeclarations: session.tools.map(toFunctionDeclaration) }];
    }

    if (this.pushToTalk) {
      // Manual turns: nothing is answered until the screen is held and let go.
      setup.realtimeInputConfig = {
        automaticActivityDetection: { disabled: true }
      };
    } else {
      setup.realtimeInputConfig = {
        automaticActivityDetection: { startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH', endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH' }
      };
    }

    this.send(setup);
  }

  /** Swap personality or tools mid-session (settings changed). */
  updateSession({ instructions, voice } = {}) {
    if (instructions) this.send({ systemInstruction: { parts: [{ text: instructions }] } });
    if (voice) {
      this.send({
        generationConfig: {
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: normaliseVoice(voice) } } }
        }
      });
    }
  }

  setPushToTalk(on) {
    this.pushToTalk = Boolean(on);
    this.send({
      realtimeInputConfig: on
        ? { automaticActivityDetection: { disabled: true } }
        : { automaticActivityDetection: { startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH' } }
    });
  }

  setVoiceOut(on) {
    this.voiceOut = Boolean(on);
    this.outNode?.port.postMessage({ type: 'muted', value: !on });
    if (!on) this.outNode?.port.postMessage({ type: 'flush' });
  }

  setMuted(muted) {
    this.muted = Boolean(muted);
    this.gateMic(!this.muted && (this.holding || !this.pushToTalk));
    if (!this.pushToTalk) this.gateMic(!this.muted);
  }

  /** The screen went down: open a turn and start streaming the microphone. */
  beginHold() {
    if (!this.connected) return;
    this.holding = true;
    this.userBuffer = '';
    if (this.pushToTalk) {
      this.send({ realtimeInput: { activityStart: {} } });
      this.gateMic(!this.muted);
      this.pushAmbientContext();
    } else {
      this.gateMic(!this.muted);
    }
    this.options.onStatus?.('listening');
  }

  /** The screen came up: commit the turn and ask for an answer. */
  endHold() {
    if (!this.connected) return;
    this.holding = false;
    if (this.pushToTalk) {
      this.send({ realtimeInput: { activityEnd: {} } });
      this.gateMic(false);
    }
    this.options.onStatus?.('thinking');
  }

  /** Say something without the microphone (a tapped suggestion, or typing). */
  sendText(text) {
    if (!this.connected || !text?.trim()) return;
    this.send({
      clientContent: {
        turns: [{ role: 'user', parts: [{ text: text.trim() }] }],
        turnComplete: true
      }
    });
    this.options.onStatus?.('thinking');
  }

  /** Stop him mid-sentence. */
  interrupt() {
    if (!this.connected) return;
    this.send({ clientContent: { turns: [], turnComplete: true } });
    this.send({ realtimeInput: { activityStart: {} } });
    this.send({ realtimeInput: { activityEnd: {} } });
    this.outNode?.port.postMessage({ type: 'flush' });
    this.options.onStatus?.('ready');
  }

  /** Hand an id back once a tool has finished, then let him speak about it. */
  sendToolResponse(id, name, response) {
    this.send({
      toolResponse: {
        functionResponses: [{ id, name, response: { result: response } }]
      }
    });
  }

  close() {
    this.stopAmbient();
    this.connected = false;
    try {
      this.socket?.close();
    } catch {
      /* already gone */
    }
    this.socket = null;
    this.gateMic(false);
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.micContext?.close().catch(() => undefined);
    this.outContext?.close().catch(() => undefined);
    this.micContext = null;
    this.outContext = null;
    this.options.onStatus?.('closed');
  }

  // ── Audio in ─────────────────────────────────────────────────────────────

  async prepareAudio() {
    if (this.micContext) return;

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error(
        window.isSecureContext
          ? 'This browser will not share the microphone.'
          : 'The microphone needs a trusted connection — open /install on this phone and follow the one-time step.'
      );
    }

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1
        }
      });
    } catch (error) {
      // The two failures worth explaining in person.
      if (error?.name === 'NotAllowedError' && !window.isSecureContext) {
        throw new Error('The microphone needs a trusted connection — open /install on this phone and follow the one-time step.');
      }
      if (error?.name === 'NotAllowedError') throw new Error('Allow the microphone when your browser asks, then hold the screen again.');
      throw new Error(error?.message || 'The microphone could not be opened.');
    }

    this.micContext = new AudioContext({ sampleRate: AUDIO_IN_HZ });
    await this.micContext.resume().catch(() => undefined);
    await this.micContext.audioWorklet.addModule('./mic-worklet.js');

    const source = this.micContext.createMediaStreamSource(this.stream);
    const mic = new AudioWorkletNode(this.micContext, 'buddy-mic');
    this.micNode = mic;
    mic.port.onmessage = (event) => this.onMicMessage(event.data);
    source.connect(mic);
    // A worklet with no output still needs to be in the graph to run.
    mic.connect(this.micContext.destination);
    this.gateMic(false);

    if (this.voiceOut) {
      this.outContext = new AudioContext({ sampleRate: AUDIO_OUT_HZ });
      await this.outContext.resume().catch(() => undefined);
      await this.outContext.audioWorklet.addModule('./out-worklet.js');
      const out = new AudioWorkletNode(this.outContext, 'buddy-out');
      this.outNode = out;
      out.port.postMessage({ type: 'muted', value: false });
      out.connect(this.outContext.destination);
    }
  }

  onMicMessage(data) {
    if (!data) return;
    if (data.type === 'level') {
      this.options.onLevel?.(data.value);
      return;
    }
    if (data.type === 'pcm' && this.connected) {
      this.send({
        realtimeInput: {
          audio: { data: base64FromArrayBuffer(data.buffer), mimeType: `audio/pcm;rate=${AUDIO_IN_HZ}` }
        }
      });
    }
  }

  gateMic(open) {
    this.micNode?.port.postMessage({ type: 'gate', value: Boolean(open) });
  }

  // ── Ambient awareness ────────────────────────────────────────────────────
  /**
   * He should already know what's been going on around you when you press the
   * screen — that's what makes the original feel present rather than deaf. The
   * browser's own speech recogniser runs quietly in the background and we hand
   * the last minute of it over as context when a question starts.
   */
  startAmbient() {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!this.ambientEnabled || !Recognition) return;
    try {
      const recognition = new Recognition();
      recognition.continuous = true;
      recognition.interimResults = false;
      recognition.lang = navigator.language || 'en-US';
      recognition.onresult = (event) => {
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          const text = event.results[i][0]?.transcript?.trim();
          if (text) this.ambient.push(text);
        }
        if (this.ambient.length > 24) this.ambient.splice(0, this.ambient.length - 24);
      };
      recognition.onerror = () => {
        /* it just stops, which is fine */
      };
      recognition.onend = () => {
        if (this.connected && this.ambientEnabled) {
          try {
            recognition.start();
          } catch {
            /* already started */
          }
        }
      };
      recognition.start();
      this.recognition = recognition;
    } catch {
      this.recognition = null;
    }
  }

  stopAmbient() {
    try {
      this.recognition?.stop();
    } catch {
      /* never started */
    }
    this.recognition = null;
  }

  pushAmbientContext() {
    if (!this.ambient.length || !this.connected) return;
    const recent = this.ambient.slice(-14).join('\n');
    this.send({
      clientContent: {
        turns: [
          {
            role: 'user',
            parts: [
              {
                text: `(Quietly, for context only — do not answer this. Lately around the user: ${recent})`
              }
            ]
          }
        ],
        turnComplete: false
      }
    });
  }

  // ── Server events ────────────────────────────────────────────────────────

  handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(typeof raw === 'string' ? raw : '');
    } catch {
      return;
    }

    if (message.setupComplete) {
      this.options.onStatus?.('ready');
      return;
    }

    if (message.serverContent) {
      const content = message.serverContent;

      if (content.inputTranscription?.text) {
        this.userBuffer += content.inputTranscription.text;
        this.options.onTranscript?.({ role: 'you', text: this.userBuffer, final: false });
      }
      if (content.outputTranscription?.text) {
        this.buddyBuffer += content.outputTranscription.text;
        this.options.onTranscript?.({ role: 'buddy', text: this.buddyBuffer, final: false });
      }

      if (content.interrupted) {
        this.outNode?.port.postMessage({ type: 'flush' });
        this.options.onStatus?.('ready');
      }

      const parts = content.modelTurn?.parts || [];
      for (const part of parts) {
        if (part.inlineData?.data && this.voiceOut) {
          this.outNode?.port.postMessage({
            type: 'pcm',
            buffer: arrayBufferFromBase64(part.inlineData.data)
          });
        }
      }

      if (content.turnComplete) {
        const said = this.buddyBuffer.trim();
        this.buddyBuffer = '';
        this.userBuffer = '';
        this.options.onStatus?.('ready');
        if (said) this.options.onTranscript?.({ role: 'buddy', text: said, final: true });
      }
      return;
    }

    if (message.toolCall) {
      const calls = message.toolCall.functionCalls || [];
      // Tools run one at a time, in the order he asked for them.
      for (const call of calls) {
        this.toolChain = this.toolChain.then(async () => {
          let response = { ok: false, error: 'no handler' };
          try {
            response = (await this.options.onTool?.({ id: call.id, name: call.name, args: call.args || {} })) ?? response;
          } catch (error) {
            response = { ok: false, error: error?.message || String(error) };
          }
          this.sendToolResponse(call.id, call.name, response);
        });
      }
      return;
    }

    if (message.toolCallCancellation) {
      this.options.onStatus?.('ready');
      return;
    }

    if (message.goAway) {
      this.lastGoAway = Date.now();
      this.options.onStatus?.('reconnect', 'The voice session is about to end; reconnecting keeps him awake.');
      this.options.onClose?.();
      return;
    }

    if (message.error) {
      this.options.onError?.(message.error.message || 'The voice service reported an error.');
    }
  }

  send(payload) {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    try {
      this.socket.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Gemini's JSON-Schema dialect rejects a couple of keywords OpenAI accepts. */
export const toFunctionDeclaration = (tool) => {
  const parameters = sanitise(tool.parameters || { type: 'object', properties: {} });
  return {
    name: tool.name,
    description: tool.description,
    parameters
  };
};

const sanitise = (schema) => {
  if (Array.isArray(schema)) return { anyOf: schema.map(sanitise) };
  if (!schema || typeof schema !== 'object') return { type: 'string' };
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'additionalProperties' || key === '$schema' || key === 'examples') continue;
    if (key === 'properties' && value && typeof value === 'object') {
      out.properties = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitise(v)]));
      continue;
    }
    if (key === 'items') {
      out.items = sanitise(value);
      continue;
    }
    if (key === 'enum') {
      out.enum = value.map(String);
      continue;
    }
    out[key] = value;
  }
  if (!out.type && out.properties) out.type = 'object';
  return out;
};

/** Gemini's voice names are capitalised; the settings UI sends what a human picked. */
const normaliseVoice = (voice) => {
  const known = ['Puck', 'Kore', 'Leda', 'Aoede', 'Zephyr', 'Charon', 'Fenrir', 'Autonoe', 'Enceladus', 'Iapetus', 'Umbriel', 'Algieba'];
  if (!voice) return 'Puck';
  const match = known.find((name) => name.toLowerCase() === String(voice).toLowerCase());
  return match || 'Puck';
};

export const base64FromArrayBuffer = (buffer) => {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
};

export const arrayBufferFromBase64 = (base64) => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
};

export { AUDIO_IN_HZ, AUDIO_OUT_HZ };
