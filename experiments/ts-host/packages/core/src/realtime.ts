import type { RealtimeCredentials, RealtimeTool } from '@buddy/protocol';

/**
 * The phone's voice session.
 *
 * A direct WebRTC peer connection to OpenAI's Realtime API, authenticated with
 * the short-lived ephemeral token the host minted. Audio flows peer-to-peer,
 * so the round trip doesn't include the host at all — the only thing the
 * computer does is hand over the token and provide tools.
 *
 * Server events have changed names between API generations (`response.audio.delta`
 * became `response.output_audio.delta`, and so on). We accept both spellings so
 * Buddy keeps working if you pin an older model.
 */

export type RealtimeStatus = 'idle' | 'connecting' | 'connected' | 'speaking' | 'listening' | 'closed' | 'error';

export interface ToolCallRequest {
  name: string;
  callId: string;
  args: Record<string, unknown>;
}

export interface RealtimeHandlers {
  onStatus?: (status: RealtimeStatus, detail?: string) => void;
  onTranscript?: (transcript: { role: 'you' | 'buddy'; text: string; final: boolean }) => void;
  /** The user started talking — barge-in. */
  onSpeechStarted?: () => void;
  onSpeechStopped?: () => void;
  /** He's about to make noise. Move his mouth. */
  onResponseStarted?: () => void;
  onResponseFinished?: (text: string) => void;
  /** Loudness of his voice, 0..1, for the mouth. */
  onLevel?: (level: number) => void;
  onToolCall?: (call: ToolCallRequest) => Promise<unknown>;
  onError?: (error: Error) => void;
  /** Raw server event, for dev tools / logging. */
  onRawEvent?: (event: Record<string, unknown>) => void;
}

export interface RealtimeVoiceOptions {
  credentials: RealtimeCredentials;
  handlers?: RealtimeHandlers;
  /** Where his voice comes out. In the browser we create one if omitted. */
  audioElement?: HTMLAudioElement;
  /** Reuse an existing mic stream (the phone keeps one warm). */
  mediaStream?: MediaStream;
  /** Needed when the OpenAI endpoint can't be reached directly (CORS). */
  sdpProxy?: (sdp: string) => Promise<string>;
  WebRTCImpl?: { new (config?: RTCConfiguration): RTCPeerConnection };
  mediaDevices?: MediaDevices;
  AudioContextImpl?: typeof AudioContext;
  /** Request echo cancellation + noise suppression (default true). */
  voiceProcessing?: boolean;
}

type ServerEvent = Record<string, unknown> & { type?: string };

const pickString = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback;

export class RealtimeVoice {
  private pc: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private stream: MediaStream | null = null;
  private ownsStream = false;
  private analyser: AnalyserNode | null = null;
  private audioContext: AudioContext | null = null;
  private levelFrame: number | null = null;
  private levelBuffer: Uint8Array<ArrayBuffer> | null = null;
  private smoothedLevel = 0;
  private status: RealtimeStatus = 'idle';
  private assistantBuffer = '';
  private userBuffer = '';
  private pendingCalls = new Set<string>();
  private readonly handlers: RealtimeHandlers;
  private readonly options: RealtimeVoiceOptions;

  constructor(options: RealtimeVoiceOptions) {
    this.options = options;
    this.handlers = options.handlers ?? {};
  }

  get currentStatus(): RealtimeStatus {
    return this.status;
  }

  /** Call from a user gesture — iOS won't let audio start any other way. */
  async connect(): Promise<void> {
    if (this.status === 'connected' || this.status === 'listening' || this.status === 'speaking') return;
    this.setStatus('connecting');
    this.primeAudioSession();

    const Ctor = this.options.WebRTCImpl ?? (globalThis.RTCPeerConnection as RealtimeVoiceOptions['WebRTCImpl']);
    if (!Ctor) throw new Error('WebRTC is not available here.');

    const pc = new Ctor({ iceServers: [] });
    this.pc = pc;

    try {
      const stream = await this.getMicStream();
      for (const track of stream.getAudioTracks()) pc.addTrack(track, stream);

      pc.ontrack = (event) => {
        const [remoteStream] = event.streams;
        const element = this.options.audioElement ?? this.createAudioElement();
        element.srcObject = remoteStream ?? new MediaStream([event.track]);
        element.play().catch(() => {
          // iOS can refuse until a gesture; the next tap fixes it.
        });
        this.attachAnalyser(element.srcObject as MediaStream);
      };

      pc.onconnectionstatechange = () => {
        if (!this.pc) return;
        const state = this.pc.connectionState;
        if (state === 'failed' || state === 'disconnected' || state === 'closed') {
          this.emitError(new Error(`realtime connection ${state}`));
          this.setStatus(state === 'closed' ? 'closed' : 'error', state);
        }
      };

      const dc = pc.createDataChannel('oai-events');
      this.dataChannel = dc;
      dc.onmessage = (message) => this.handleServerEvent(message.data as string);
      dc.onopen = () => {
        this.setStatus('listening');
        this.sendClientEvent({
          type: 'session.update',
          session: this.buildSessionUpdate(this.options.credentials.session)
        });
      };
      dc.onerror = () => this.emitError(new Error('realtime data channel error'));

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await this.waitForIceGathering(pc);

      const sdpResponse = await this.exchangeSdp(pc.localDescription?.sdp ?? offer.sdp ?? '');
      await pc.setRemoteDescription({ type: 'answer', sdp: sdpResponse });
    } catch (error) {
      this.emitError(error instanceof Error ? error : new Error(String(error)));
      this.setStatus('error');
      await this.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    this.stopLevelTracking();
    if (this.dataChannel) {
      try {
        this.dataChannel.close();
      } catch {
        /* already closed */
      }
      this.dataChannel = null;
    }
    if (this.pc) {
      try {
        this.pc.close();
      } catch {
        /* already closed */
      }
      this.pc = null;
    }
    if (this.stream && this.ownsStream) {
      for (const track of this.stream.getTracks()) track.stop();
    }
    this.stream = null;
    const element = this.options.audioElement;
    if (element) element.srcObject = null;
    void this.audioContext?.close().catch(() => undefined);
    this.audioContext = null;
    this.setStatus('closed');
  }

  /** Push a new personality/voice into the live session. */
  setInstructions(instructions: string, voice?: string): void {
    this.sendClientEvent({
      type: 'session.update',
      session: {
        instructions,
        ...(voice ? { audio: { output: { voice } } } : {})
      }
    });
  }

  /** Swap the tool belt when settings change (e.g. computer use switched off). */
  setTools(tools: RealtimeTool[]): void {
    this.sendClientEvent({
      type: 'session.update',
      session: {
        tools: tools.map(({ meta: _meta, ...rest }) => rest),
        tool_choice: 'auto'
      }
    });
  }

  /** Say something without the microphone. */
  sendText(text: string): void {
    this.sendClientEvent({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text }]
      }
    });
    this.sendClientEvent({ type: 'response.create' });
  }

  /** Stop him mid-sentence. */
  interrupt(): void {
    this.sendClientEvent({ type: 'response.cancel' });
    this.sendClientEvent({ type: 'output_audio_buffer.clear' });
    this.setStatus('listening');
  }

  setMuted(muted: boolean): void {
    this.stream?.getAudioTracks().forEach((track) => {
      track.enabled = !muted;
    });
    for (const sender of this.pc?.getSenders() ?? []) {
      if (sender.track?.kind === 'audio') sender.track.enabled = !muted;
    }
  }

  /** True once the socket is live and the model is listening. */
  get isReady(): boolean {
    return this.dataChannel?.readyState === 'open';
  }

  // ── internals ────────────────────────────────────────────────────────────

  private buildSessionUpdate(session: RealtimeCredentials['session']): Record<string, unknown> {
    return {
      type: 'realtime',
      model: session.model,
      instructions: session.instructions,
      output_modalities: session.outputModalities,
      audio: {
        input: {
          transcription: { model: session.inputAudioTranscriptionModel },
          noise_reduction: { type: 'near_field' },
          turn_detection: null // push-to-talk: committed by hand, no VAD cutting us off
        },
        output: { voice: session.voice, speed: 1 }
      },
      tools: session.tools.map(({ meta: _meta, ...rest }) => rest),
      tool_choice: session.toolChoice,
      temperature: session.temperature
    };
  }

  /**
   * Push-to-talk lives here: the mic is always connected (so he hears the room
   * as context), but audio is only *committed* while the screen is held.
   */
  async beginUtterance(): Promise<void> {
    this.sendClientEvent({ type: 'input_audio_buffer.clear' });
    this.sendClientEvent({ type: 'input_audio_buffer.start' });
  }

  async endUtterance(): Promise<void> {
    this.sendClientEvent({ type: 'input_audio_buffer.commit' });
    this.sendClientEvent({ type: 'response.create' });
  }

  private async getMicStream(): Promise<MediaStream> {
    if (this.options.mediaStream) {
      this.stream = this.options.mediaStream;
      this.ownsStream = false;
      return this.stream;
    }
    const devices = this.options.mediaDevices ?? navigator.mediaDevices;
    if (!devices?.getUserMedia) throw new Error('No microphone available.');
    const stream = await devices.getUserMedia({
      audio: {
        echoCancellation: this.options.voiceProcessing !== false,
        noiseSuppression: this.options.voiceProcessing !== false,
        autoGainControl: true,
        channelCount: 1
      }
    });
    this.stream = stream;
    this.ownsStream = true;
    return stream;
  }

  private createAudioElement(): HTMLAudioElement {
    const element = document.createElement('audio');
    element.autoplay = true;
    element.setAttribute('playsinline', 'true');
    element.style.display = 'none';
    document.body.appendChild(element);
    return element;
  }

  /** Safari insists on a 'play-and-record' session or he talks out of the earpiece. */
  private primeAudioSession(): void {
    try {
      const session = (navigator as unknown as { audioSession?: { type: string } }).audioSession;
      if (session) session.type = 'play-and-record';
    } catch {
      /* not supported, fine */
    }
  }

  private async waitForIceGathering(pc: RTCPeerConnection, timeoutMs = 2500): Promise<void> {
    if (pc.iceGatheringState === 'complete') return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      const check = () => {
        if (pc.iceGatheringState === 'complete') {
          clearTimeout(timer);
          pc.removeEventListener('icegatheringstatechange', check);
          resolve();
        }
      };
      pc.addEventListener('icegatheringstatechange', check);
    });
  }

  private async exchangeSdp(sdp: string): Promise<string> {
    const { callsUrl, clientSecret } = this.options.credentials;
    const headers = {
      authorization: `Bearer ${clientSecret}`,
      'content-type': 'application/sdp'
    };
    try {
      const response = await fetch(callsUrl, { method: 'POST', headers, body: sdp });
      if (!response.ok) throw new Error(`SDP exchange failed: ${response.status} ${await response.text()}`);
      return await response.text();
    } catch (error) {
      // Safari/WKWebView can refuse the cross-origin POST; relay through the host.
      if (this.options.sdpProxy) return await this.options.sdpProxy(sdp);
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  private attachAnalyser(stream: MediaStream | null): void {
    const Ctor = this.options.AudioContextImpl ?? (globalThis.AudioContext as typeof AudioContext | undefined);
    if (!Ctor || !stream) return;
    try {
      this.audioContext = new Ctor();
      const source = this.audioContext.createMediaStreamSource(stream);
      const analyser = this.audioContext.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.75;
      source.connect(analyser);
      this.analyser = analyser;
      this.levelBuffer = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
      this.startLevelTracking();
    } catch {
      this.analyser = null;
    }
  }

  private startLevelTracking(): void {
    if (!this.analyser || !this.options.handlers?.onLevel) return;
    const tick = () => {
      if (!this.analyser || !this.levelBuffer) return;
      this.analyser.getByteTimeDomainData(this.levelBuffer);
      let sum = 0;
      for (const sample of this.levelBuffer) {
        const centred = (sample - 128) / 128;
        sum += centred * centred;
      }
      const rms = Math.sqrt(sum / this.levelBuffer.length);
      const level = Math.min(1, rms * 3.2);
      this.smoothedLevel = this.smoothedLevel * 0.7 + level * 0.3;
      this.handlers.onLevel?.(this.smoothedLevel);
      this.levelFrame = requestAnimationFrame(tick);
    };
    this.levelFrame = requestAnimationFrame(tick);
  }

  private stopLevelTracking(): void {
    if (this.levelFrame !== null) cancelAnimationFrame(this.levelFrame);
    this.levelFrame = null;
    this.analyser = null;
  }

  private sendClientEvent(event: Record<string, unknown>): void {
    if (this.dataChannel?.readyState !== 'open') return;
    try {
      this.dataChannel.send(JSON.stringify(event));
    } catch (error) {
      this.emitError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private handleServerEvent(raw: string): void {
    let event: ServerEvent;
    try {
      event = JSON.parse(raw) as ServerEvent;
    } catch {
      return;
    }
    this.handlers.onRawEvent?.(event);

    switch (event.type) {
      case 'session.created':
      case 'session.updated':
        break;

      case 'input_audio_buffer.speech_started':
      case 'input_audio_buffer.speech-start':
        this.handlers.onSpeechStarted?.();
        break;

      case 'input_audio_buffer.speech_stopped':
      case 'input_audio_buffer.speech-stopped':
        this.handlers.onSpeechStopped?.();
        break;

      case 'conversation.item.input_audio_transcription.delta':
      case 'conversation.item.input_audio_transcription.updated': {
        this.userBuffer += pickString(event.delta);
        this.handlers.onTranscript?.({ role: 'you', text: this.userBuffer, final: false });
        break;
      }

      case 'conversation.item.input_audio_transcription.completed': {
        const text = pickString(event.transcript, this.userBuffer).trim();
        this.userBuffer = '';
        if (text) this.handlers.onTranscript?.({ role: 'you', text, final: true });
        break;
      }

      case 'response.created':
        this.assistantBuffer = '';
        this.setStatus('speaking');
        this.handlers.onResponseStarted?.();
        break;

      case 'response.output_audio_transcript.delta':
      case 'response.audio_transcript.delta':
      case 'response.output_text.delta': {
        this.assistantBuffer += pickString(event.delta);
        this.handlers.onTranscript?.({ role: 'buddy', text: this.assistantBuffer, final: false });
        break;
      }

      case 'response.output_audio_transcript.done':
      case 'response.audio_transcript.done':
      case 'response.output_text.done': {
        const text = pickString(event.transcript ?? event.text, this.assistantBuffer).trim();
        if (text) this.handlers.onTranscript?.({ role: 'buddy', text, final: true });
        break;
      }

      case 'response.function_call_arguments.done':
        void this.runToolCall({
          name: pickString(event.name),
          callId: pickString(event.call_id),
          args: parseArgs(event.arguments)
        });
        break;

      case 'response.output_item.done': {
        const item = event.item as Record<string, unknown> | undefined;
        if (item && item.type === 'function_call') {
          void this.runToolCall({
            name: pickString(item.name),
            callId: pickString(item.call_id),
            args: parseArgs(item.arguments)
          });
        }
        break;
      }

      case 'response.done': {
        const text = this.assistantBuffer.trim();
        this.assistantBuffer = '';
        this.setStatus('listening');
        this.handlers.onResponseFinished?.(text);
        break;
      }

      case 'error': {
        const detail = (event.error as Record<string, unknown> | undefined) ?? {};
        this.emitError(new Error(pickString(detail.message, 'realtime error')));
        break;
      }

      default:
        break;
    }
  }

  private async runToolCall(call: ToolCallRequest): Promise<void> {
    if (!call.name || !call.callId) return;
    // The same call can arrive from both event spellings; only run it once.
    if (this.pendingCalls.has(call.callId)) return;
    this.pendingCalls.add(call.callId);

    let output: unknown = { status: 'error', message: 'Buddy could not do that.' };
    try {
      this.setStatus('speaking');
      output = (await this.handlers.onToolCall?.(call)) ?? output;
    } catch (error) {
      output = {
        status: 'error',
        message: error instanceof Error ? error.message : 'Something went wrong.'
      };
    } finally {
      this.pendingCalls.delete(call.callId);
    }

    if (this.dataChannel?.readyState !== 'open') return;
    this.sendClientEvent({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: call.callId,
        output: JSON.stringify(output ?? { status: 'ok' })
      }
    });
    this.sendClientEvent({ type: 'response.create' });
  }

  private setStatus(status: RealtimeStatus, detail?: string): void {
    if (this.status === status) return;
    this.status = status;
    this.handlers.onStatus?.(status, detail);
  }

  private emitError(error: Error): void {
    this.handlers.onError?.(error);
  }
}

const parseArgs = (value: unknown): Record<string, unknown> => {
  if (typeof value === 'object' && value !== null) return value as Record<string, unknown>;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};
