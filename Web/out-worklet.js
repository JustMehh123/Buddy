/**
 * Speaker ← 16-bit PCM at 24 kHz.
 *
 * The realtime voice servers send raw PCM with no container, so the browser
 * needs a queue that plays it back smoothly: chunks arrive every ~20 ms and we
 * drain them on the audio clock. A tiny jitter buffer keeps it from clicking.
 */
class OutWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.current = null;
    this.offset = 0;
    this.muted = true;
    this.port.onmessage = (event) => {
      const data = event.data;
      if (!data) return;
      if (data.type === 'pcm') {
        const view = new Int16Array(data.buffer);
        const floats = new Float32Array(view.length);
        for (let i = 0; i < view.length; i += 1) floats[i] = view[i] / 0x8000;
        this.queue.push(floats);
        // Never let the buffer run away: drop the oldest audio if we fall behind.
        while (this.queue.length > 48) this.queue.shift();
      } else if (data.type === 'muted') {
        this.muted = data.value !== false;
      } else if (data.type === 'flush') {
        this.queue.length = 0;
        this.current = null;
        this.offset = 0;
      }
    };
  }

  process(_inputs, outputs) {
    const output = outputs[0][0];
    if (!output) return true;
    if (this.muted) {
      output.fill(0);
      return true;
    }
    for (let i = 0; i < output.length; i += 1) {
      if (!this.current || this.offset >= this.current.length) {
        this.current = this.queue.shift() || null;
        this.offset = 0;
      }
      output[i] = this.current ? this.current[this.offset] || 0 : 0;
      if (this.current) this.offset += 1;
    }
    return true;
  }
}

registerProcessor('buddy-out', OutWorklet);
