# Audio Node Tool — Implementation Plan

> Status: **DRAFT — awaiting approval**  
> Created: 2026-05-05  
> Author: OpenClaw agent

## Overview

A browser-based audio capture and streaming tool that connects the user's microphone and speakers to OpenClaw's AI pipeline (STT → chat → TTS). Runs as a standalone Node.js web app served on a local port.

## Architecture

```
┌─────────────────────────────────────────────────┐
│                  Browser (SPA)                   │
│                                                  │
│  ┌──────────┐  MediaStream  ┌────────────────┐  │
│  │  Microphone ────────────▶│  AudioWorklet   │  │
│  └──────────┘               │  (capture +     │  │
│                              │   visualize)    │  │
│                              └───────┬────────┘  │
│                                      │            │
│                              PCM chunks (Int16)   │
│                                      │            │
│                              ┌───────▼────────┐  │
│                              │  WebSocket      │  │
│                              │  Client         │  │
│                              └───────┬────────┘  │
│                                      │            │
│                              ┌───────▼────────┐  │
│                              │  AudioContext   │  │
│                              │  (playback)     │  │
│                              └───────┬────────┘  │
│                                      │            │
│                              PCM chunks (Int16)   │
│                                      │            │
│                              ┌───────▼────────┐  │
│                              │   Speakers     │  │
│                              └────────────────┘  │
└──────────────────────────────────────────────────┘
         │
         │ WebSocket (binary frames, PCM Int16)
         │
         ▼
┌──────────────────────────────────────────────────┐
│              Node.js Server                       │
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │  WebSocket Server (ws)                     │  │
│  │  - Receives browser mic PCM chunks         │  │
│  │  - Accumulates into audio buffers          │  │
│  │  - Forwards to OpenClaw gateway            │  │
│  └────────────────────────────────────────────┘  │
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │  OpenClaw Relay                            │  │
│  │  - POST audio → llama-swap /transcriptions │  │
│  │  - Send transcript → gateway /chat/send    │  │
│  │  - Receive response → llama-swap /speech   │  │
│  │  - Stream TTS PCM back to browser          │  │
│  └────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────┘
```

## Port Allocation

| Port    | Service                    | Notes                        |
|---------|----------------------------|------------------------------|
| 18790   | Main app (HTTP + WS)       | Static files + WebSocket     |
| 18791   | — Reserved                 | OpenClaw gateway browser ctl |
| 18792   | Debug/telemetry (optional) | WebSocket-only diagnostics   |
| 18793   | Reserved for future        | —                            |

## Tech Stack

- **Frontend:** Vanilla HTML/CSS/JS — no build step, no npm dependencies
- **Audio capture:** `getUserMedia()` → `AudioWorklet` (low-latency PCM)
- **Audio playback:** `AudioContext` + `AudioWorkletNode` (low-latency PCM)
- **Transport:** WebSocket binary frames (Int16Array, 16kHz mono PCM)
- **Server:** Node.js `http` (static files) + `ws` (WebSocket)
- **STT:** `llama-swap` whisper-tiny via HTTP (`/v1/audio/transcriptions`)
- **TTS:** `llama-swap` kokoro via HTTP (`/v1/audio/speech`)
- **Chat:** OpenClaw gateway `chat.send` via WebSocket or REST

## Project Structure

```
audio-node-tool/
├── IMPLEMENTATION_PLAN.md   ← this file
├── README.md                ← user-facing docs
├── server.js                ← Node.js server (HTTP + WS + relay)
├── index.html               ← SPA entry (shell + styles)
├── js/
│   ├── app.js               ← main app logic
│   ├── capture.js           ← mic capture + AudioWorklet
│   ├── playback.js          ← speaker playback + AudioWorklet
│   ├── websocket.js         ← WS client + binary framing
│   └── worklets/
│       ├── capture.worklet.js  ← AudioWorklet processor (mic)
│       └── playback.worklet.js ← AudioWorklet processor (speaker)
├── css/
│   └── styles.css           ← all styles
├── config.js                ← runtime config (ports, endpoints)
├── .gitignore
└── package.json             ← ws dependency only
```

## Audio Pipeline

### Capture (Browser → Server)

1. User clicks "Start" → requests `getUserMedia({ audio: { sampleRate: 16000, channelCount: 1 } })`
2. `AudioWorklet` processes mic stream → extracts Int16 PCM samples
3. PCM chunks (20ms ≈ 320 samples) sent as WebSocket binary frames
4. Server accumulates chunks into a buffer
5. On VAD silence or manual stop, server sends buffer to whisper-tiny

### Transcription (Server → OpenClaw)

6. Server POSTs WAV/PCM to `llama-swap:8080/v1/audio/transcriptions` (model: `whisper-tiny`)
7. Receives transcript text
8. Server sends transcript to OpenClaw gateway via `chat.send`
9. Gateway returns AI response

### Synthesis & Playback (Server → Browser)

10. Server POSTs response text to `llama-swap:8080/v1/audio/speech` (model: `kokoro`)
11. Receives audio stream (MP3/PCM)
12. Server decodes and sends PCM chunks back to browser via WebSocket
13. Browser `AudioWorklet` plays PCM chunks through speakers

### Binary Frame Protocol

```
┌────────────┬──────────────────────────────────┐
│ 1 byte     │ 3 bytes     │ N bytes            │
│ type       │ length BE   │ payload            │
├────────────┼──────────────────────────────────┤
│ 0x01       │ PCM length  │ Int16 PCM samples  │  ← mic→server
│ 0x02       │ PCM length  │ Int16 PCM samples  │  ← server→speaker
│ 0x03       │ text len    │ UTF-8 text         │  ← server→browser (status)
│ 0x04       │ —           │ —                  │  ← browser→server (start/stop)
└────────────┴──────────────────────────────────┘
```

## Modes

| Mode       | Behavior                                              |
|------------|-------------------------------------------------------|
| **Push-to-talk** | Hold button to speak, release to process & play back |
| **Continuous**   | VAD-triggered capture, auto-process silence gaps      |
| **Passthrough**  | Mic → speakers (echo test, debugging)                 |

## OpenClaw Integration

Two approaches for chat relay:

**Option A — Direct HTTP relay (simpler, more control):**
- Server directly calls `llama-swap` for STT/TTS
- Server calls gateway `/v1/chat/completions` for AI responses
- No gateway WS connection needed

**Option B — Gateway WS relay (more integrated):**
- Server connects to gateway WebSocket
- Uses `chat.send` with transcript
- Receives streaming response via `chat` events
- More aligned with OpenClaw event model

**Recommendation:** Start with Option A for simplicity. Can migrate to Option B later.

## Config

```javascript
// config.js
module.exports = {
  port: 18790,
  gateway: {
    host: 'localhost',
    port: 18789,
    token: 'KOPPARORM',
  },
  llamaSwap: {
    host: 'llama-3090-core',
    port: 8080,
    sttModel: 'whisper-tiny',
    ttsModel: 'kokoro',
    ttsVoice: 'af_bella',
  },
  audio: {
    sampleRate: 16000,
    channels: 1,
    bufferSize: 320, // 20ms at 16kHz
    vadThreshold: 0.01,
    vadSilenceMs: 1000,
  },
};
```

## UI Design

Minimal, functional interface:

- **Header:** Title, connection status indicator, mode selector
- **Main area:** Audio waveform visualization (canvas), transcript display
- **Footer:** Push-to-talk button (large, center), mode toggle, volume sliders
- **Colors:** Dark theme matching voice-mesh (`#0d1117` bg, `#161b22` surfaces)

## Files

| File | Purpose | Lines (est.) |
|------|---------|-------------|
| `package.json` | Dependencies (ws only) | 15 |
| `config.js` | Runtime configuration | 30 |
| `server.js` | HTTP + WS server, audio relay | 250 |
| `index.html` | SPA shell, inline styles | 100 |
| `js/app.js` | Main app controller | 150 |
| `js/capture.js` | Mic capture logic | 100 |
| `js/playback.js` | Speaker playback logic | 100 |
| `js/websocket.js` | WS client, binary framing | 80 |
| `js/worklets/capture.worklet.js` | AudioWorklet processor | 40 |
| `js/worklets/playback.worklet.js` | AudioWorklet processor | 40 |
| `css/styles.css` | All styles | 200 |
| `README.md` | User docs | 80 |
| `IMPLEMENTATION_PLAN.md` | This file | — |

**Total:** ~1200 lines of code

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Browser AudioWorklet support | Core feature | All modern browsers support it; polyfill via ScriptProcessor if needed |
| CORS on llama-swap | STT/TTS fails | Server-side relay avoids browser CORS entirely |
| High latency in pipeline | Poor UX | Target <2s end-to-end; show loading states |
| Gateway WS auth complexity | Chat integration | Option A avoids gateway WS entirely |
| Audio buffer underrun | Choppy playback | Use larger playback buffer (200ms+) with pre-buffering |

## Next Steps

1. **Approve plan** → proceed to implementation
2. Implement core: `server.js` + `index.html` + `js/app.js`
3. Implement capture: `js/capture.js` + worklet
4. Implement playback: `js/playback.js` + worklet
5. Implement relay: STT → chat → TTS pipeline
6. Test end-to-end
7. Polish UI + documentation
