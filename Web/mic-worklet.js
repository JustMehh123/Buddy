/**
 * Microphone → 16-bit PCM frames.
 *
 * Runs on the audio thread so the main thread can stay busy drawing his face.
 * The AudioContext is created at 16 kHz, so the browser does the resampling for
 * us and we only have to convert to little-endian PCM16 — the format the
 * realtime voice APIs want.
 */
class MicWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this.active = false;
    this.port.onmessage = (event) => {
      if (event.data?.type === 'gate') this.active = event.data.value !== false;
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    // Level metering always runs, so his mouth moves even when muted.
    let sum = 0;
    const channel = input[0];
    for (let i = 0; i < channel.length; i += 1) sum += channel[i] * channel[i];
    const rms = Math.sqrt(sum / channel.length);
    this.port.postMessage({ type: 'level', value: Math.min(1, rms * 3.4) });

    if (!this.active) return true;

    const pcm = new Int16Array(channel.length);
    for (let i = 0; i < channel.length; i += 1) {
      const sample = Math.max(-1, Math.min(1, channel[i]));
      pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }
    this.port.postMessage({ type: 'pcm', buffer: pcm.buffer }, [pcm.buffer]);
    return true;
  }
}

registerProcessor('buddy-mic', MicWorklet);
