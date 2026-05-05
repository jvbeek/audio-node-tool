module.exports = {
  port: 18790,
  httpsPort: 18800,
  gateway: {
    host: 'localhost',
    port: 18789,
    token: process.env.OPENCLAW_TOKEN || 'KOPPARORM',
  },
  llamaSwap: {
    host: process.env.LLAMA_HOST || 'llama-3090-core',
    port: 8080,
    sttModel: 'whisper-tiny',
    ttsModel: 'kokoro',
    ttsVoice: 'af_bella',
  },
  audio: {
    sampleRate: 16000,
    channels: 1,
    bufferSize: 320, // 20ms at 16kHz
  },
};
