// ── Audio capture via AudioWorklet ─────────────────────────────────

class AudioCapture {
  constructor(audioContext, bufferSize = 320) {
    this.ctx = audioContext;
    this.bufferSize = bufferSize;
    this.stream = null;
    this.source = null;
    this.workletNode = null;
    this.port = null;
    this.onChunk = null;
    this.active = false;
  }

  async start(onChunk) {
    this.onChunk = onChunk;

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: 16000,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });

    this.source = this.ctx.createMediaStreamSource(this.stream);

    // Load worklet module
    await this.ctx.audioWorklet.addModule('js/worklets/capture.worklet.js');

    this.workletNode = new AudioWorkletNode(this.ctx, 'capture-processor', {
      channelCount: 1,
      numberOfInputs: 1,
      numberOfOutputs: 1,
    });

    this.port = this.workletNode.port;
    this.port.onmessage = (e) => {
      if (e.data.type === 'pcm' && this.onChunk) {
        this.onChunk(e.data.pcm);
      }
    };

    this.source.connect(this.workletNode);
    // Don't connect to destination (no echo)
    // this.workletNode.connect(this.ctx.destination);

    this.active = true;
    console.log('[capture] Started');
  }

  stop() {
    this.active = false;
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }
    if (this.workletNode) {
      this.workletNode.disconnect();
      this.workletNode = null;
    }
    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }
    console.log('[capture] Stopped');
  }

  getLevel() {
    // Could add RMS level detection here
    return 0;
  }
}
