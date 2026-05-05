// ── Playback AudioWorklet Processor ────────────────────────────────
// Receives Int16 PCM from main thread, plays through speakers

class PlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.port.onmessage = (e) => {
      if (e.data.type === 'pcm') {
        // Convert Int16 → Float32
        const pcm = e.data.pcm;
        const float = new Float32Array(pcm.length);
        for (let i = 0; i < pcm.length; i++) {
          float[i] = pcm[i] / 0x7fff;
        }
        this.queue.push(float);
      }
    };
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    const channel = output[0];
    const needed = channel.length;

    if (this.queue.length > 0) {
      let written = 0;
      while (this.queue.length > 0 && written < needed) {
        const chunk = this.queue[0];
        const toWrite = Math.min(chunk.length, needed - written);
        for (let i = 0; i < toWrite; i++) {
          channel[written + i] = chunk[i];
        }
        written += toWrite;
        if (toWrite >= chunk.length) {
          this.queue.shift();
        } else {
          this.queue[0] = chunk.slice(toWrite);
        }
      }
    } else {
      // Silence
      channel.fill(0);
    }

    return true;
  }
}

registerProcessor('playback-processor', PlaybackProcessor);
