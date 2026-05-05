// ── Capture AudioWorklet Processor ──────────────────────────────────
// Captures audio from mic, converts to Int16 PCM, sends to main thread

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(0);
    this.chunkSize = 320; // 20ms at 16kHz
    this.port.onmessage = (e) => {
      // Command handling if needed
    };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    const channel = input[0];
    if (!channel) return true;

    // Accumulate samples
    const newBuffer = new Float32Array(this.buffer.length + channel.length);
    newBuffer.set(this.buffer);
    newBuffer.set(channel, this.buffer.length);
    this.buffer = newBuffer;

    // Extract chunks
    while (this.buffer.length >= this.chunkSize) {
      const chunk = this.buffer.slice(0, this.chunkSize);
      this.buffer = this.buffer.slice(this.chunkSize);

      // Convert Float32 [-1, 1] → Int16
      const pcm = new Int16Array(this.chunkSize);
      for (let i = 0; i < this.chunkSize; i++) {
        const s = Math.max(-1, Math.min(1, chunk[i]));
        pcm[i] = s * 0x7fff;
      }

      this.port.postMessage({ type: 'pcm', pcm });
    }

    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
