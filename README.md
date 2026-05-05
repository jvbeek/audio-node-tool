# Audio Node Tool

Browser-based audio capture and streaming tool for OpenClaw. Captures microphone input, transcribes via Whisper, relays through OpenClaw gateway, and plays back AI responses via Kokoro TTS.

## Quick Start

```bash
cd projects/audio-node-tool
npm install
npm start
```

- **Local:** Open `http://localhost:18790`
- **LAN:** Open `https://<your-ip>:18800` (self-signed cert — accept the browser warning)

> ⚠️ LAN access **requires HTTPS** — `getUserMedia` is blocked on insecure origins.

## Modes

- **Push-to-Talk** — Hold the button (or Space) to speak, release to process
- **Continuous** — Click Start/Stop for manual control
- **Passthrough** — Mic → speakers (echo test)

## Architecture

```
Browser mic → AudioWorklet (PCM) → WebSocket → Node.js server
                                                    ↓
                                            whisper-tiny (STT)
                                                    ↓
                                            OpenClaw gateway (chat)
                                                    ↓
                                            kokoro (TTS)
                                                    ↓
Browser ← WebSocket (PCM) ← AudioWorklet ← speakers
```

## Ports

| Port | Service |
|------|---------|
| 18790 | HTTP + WebSocket (localhost only) |
| 18800 | HTTPS + WSS (LAN access, self-signed cert) |
| 18789 | OpenClaw gateway |

## Config

Edit `config.js`:

```js
{
  port: 18790,
  httpsPort: 18800,
  gateway: { host: 'localhost', port: 18789, token: process.env.OPENCLAW_TOKEN || '...' },
  llamaSwap: { host: 'llama-3090-core', port: 8080, sttModel: 'whisper-tiny', ttsModel: 'kokoro' },
  audio: { sampleRate: 16000, channels: 1, bufferSize: 320 }
}
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENCLAW_TOKEN` | (none) | Gateway auth token |
| `LLAMA_HOST` | `llama-3090-core` | llama-swap hostname |
```

## WebSocket Protocol

Binary frames: `[type:1][length:3 BE][payload:N]`

| Type | Direction | Description |
|------|-----------|-------------|
| 0x01 | Browser → Server | Mic PCM (Int16, 16kHz) |
| 0x02 | Server → Browser | Playback PCM (Int16, 16kHz) |
| 0x03 | Server → Browser | Status text (UTF-8) |

Text messages: JSON commands `{ "type": "start|stop|clear" }`

## llama-swap API Endpoints

All audio calls go through llama-swap on `llama-3090-core:8080`.

### Whisper STT — `/v1/audio/transcriptions`

**Method:** `POST`
**Content-Type:** `multipart/form-data`
**Fields:** `model` (string), `file` (audio/wav)

```bash
curl -X POST http://llama-3090-core:8080/v1/audio/transcriptions \
  -F 'model=whisper-tiny' \
  -F 'file=@recording.wav'
```

**Response:** `{ "text": "..." }`

### Kokoro TTS — `/v1/audio/speech`

**Method:** `POST`
**Content-Type:** `application/json`

```bash
curl -X POST http://llama-3090-core:8080/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{
    "model": "kokoro",
    "input": "Hello world.",
    "voice": "af_bella"
  }' --output output.mp3
```

**Response:** Audio file (binary, format from `response_format`)

### Chat (LLM) — `/v1/chat/completions`

Used for `qwen35-9b` and other text models. **Not** for whisper or kokoro.

```bash
curl -X POST http://llama-3090-core:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen35-9b",
    "messages": [{"role": "user", "content": "test"}],
    "max_tokens": 5
  }'
```

## Dependencies

- Node.js v24+
- `ws` (WebSocket)
- llama-swap running whisper-tiny and kokoro
- OpenClaw gateway running on port 18789

## Rules

⚠️ **Never edit `llama-swap.yaml` or `openclaw.json` without explicit permission.**
⚠️ **Whisper uses `/v1/audio/transcriptions` (multipart), NOT `/v1/chat/completions`.**
⚠️ **Kokoro uses `/v1/audio/speech` (JSON), NOT `/v1/chat/completions`.**
