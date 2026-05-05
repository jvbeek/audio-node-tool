// ── Audio playback via AudioWorklet ────────────────────────────────

class AudioPlayback {
  constructor(audioContext) {
    this.ctx = audioContext;
    this.workletNode = null;
    this.port = null;
    this.active = false;
    this.queue = [];
  }

  async init() {
    if (!this.workletNode) {
      await this.ctx.audioWorklet.addModule('js/worklets/playback.worklet.js');
      this.workletNode = new AudioWorkletNode(this.ctx, 'playback-processor', {
        channelCount: 1,
        numberOfInputs: 0,
        numberOfOutputs: 1,
      });
      this.port = this.workletNode.port;
      this.workletNode.connect(this.ctx.destination);
      this.active = true;
      console.log('[playback] Initialized');
    }
  }

  sendChunk(pcm) {
    if (this.port) {
      this.port.postMessage({ type: 'pcm', pcm });
    }
  }

  sendSilence() {
    if (this.port) {
      const silence = new Int16Array(320);
      this.port.postMessage({ type: 'pcm', pcm: silence });
    }
  }

  stop() {
    this.active = false;
    if (this.workletNode) {
      this.workletNode.disconnect();
      this.workletNode = null;
    }
    this.queue = [];
    console.log('[playback] Stopped');
  }
}
