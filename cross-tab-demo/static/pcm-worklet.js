// Downsamples microphone audio to 16 kHz mono 16-bit PCM and posts ~256 ms chunks.
const TARGET_RATE = 16000;
const CHUNK_SAMPLES = 4096;

class PcmWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / TARGET_RATE;
    this.pos = 0; // fractional read position into the incoming block
    this.out = new Int16Array(CHUNK_SAMPLES);
    this.filled = 0;
  }

  process(inputs) {
    const input = inputs[0][0];
    if (!input) return true;
    while (this.pos < input.length) {
      const i = Math.floor(this.pos);
      const next = input[Math.min(i + 1, input.length - 1)];
      const sample = input[i] + (next - input[i]) * (this.pos - i);
      this.out[this.filled++] = Math.max(-1, Math.min(1, sample)) * 0x7fff;
      this.pos += this.ratio;
      if (this.filled === CHUNK_SAMPLES) {
        this.port.postMessage(this.out.buffer.slice(0));
        this.filled = 0;
      }
    }
    this.pos -= input.length;
    return true;
  }
}

registerProcessor("pcm-worklet", PcmWorklet);
