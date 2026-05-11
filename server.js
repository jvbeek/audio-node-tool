#!/usr/bin/env node
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const config = require('./config');

// ── SSL/TLS (self-signed, for LAN access) ──────────────────────────
const certPath = path.join(__dirname, 'certs', 'localhost.crt');
const keyPath = path.join(__dirname, 'certs', 'localhost.key');
let sslEnabled = false;
let httpsServer = null;

if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
  try {
    const cert = fs.readFileSync(certPath);
    const key = fs.readFileSync(keyPath);
    httpsServer = https.createServer({ cert, key }, handleRequest);
    sslEnabled = true;
    console.log('🔒 HTTPS enabled (self-signed cert)');
  } catch (e) {
    console.error(`[ssl] Failed to load cert: ${e.message}`);
  }
} else {
  console.log('🔓 No SSL certs found (HTTPS disabled)');
}

// ── MIME types ──────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

// ── Static file server ──────────────────────────────────────────────
const root = __dirname;

function serveStatic(req, res) {
  let urlPath = new URL(req.url, 'http://localhost').pathname;
  if (urlPath === '/') urlPath = '/index.html';

  const filePath = path.join(root, urlPath);
  const ext = path.extname(filePath);
  const contentType = MIME[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

// ── Request handler (shared by HTTP and HTTPS) ──────────────────────
function handleRequest(req, res) {
  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', clients: clients.size }));
    return;
  }
  serveStatic(req, res);
}

// ── HTTP server ─────────────────────────────────────────────────────
const httpServer = http.createServer(handleRequest);

// ── WebSocket server ────────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });
let wssHttps = null;

const clients = new Map(); // ws → session
let nextId = 1;

// ── Audio session ───────────────────────────────────────────────────
class AudioSession {
  constructor(ws, id) {
    this.ws = ws;
    this.id = id;
    this.pcmBuffer = Buffer.alloc(0);
    this.processing = false;
    this.startTime = Date.now();
  }

  appendPCM(buf) {
    this.pcmBuffer = Buffer.concat([this.pcmBuffer, buf]);
  }

  flush() {
    const buf = this.pcmBuffer;
    this.pcmBuffer = Buffer.alloc(0);
    this.startTime = Date.now();
    return buf;
  }

  reset() {
    this.pcmBuffer = Buffer.alloc(0);
    this.startTime = Date.now();
  }
}

// ── Binary frame helpers ────────────────────────────────────────────
function parseFrame(data) {
  if (data.length < 5) return null;
  const type = data[0];
  const length = (data[1] << 16) | (data[2] << 8) | data[3];
  const payload = data.slice(5);
  return { type, length, payload };
}

function makeStatusFrame(text) {
  const txt = Buffer.from(text, 'utf-8');
  const len = txt.length;
  const header = Buffer.alloc(5);
  header[0] = 0x03; // status
  header[1] = (len >> 16) & 0xff;
  header[2] = (len >> 8) & 0xff;
  header[3] = len & 0xff;
  return Buffer.concat([header, txt]);
}

function makePCMFrame(pcm) {
  const len = pcm.length;
  const header = Buffer.alloc(5);
  header[0] = 0x02; // playback PCM
  header[1] = (len >> 16) & 0xff;
  header[2] = (len >> 8) & 0xff;
  header[3] = len & 0xff;
  return Buffer.concat([header, pcm]);
}

// ── WAV encoder (for whisper) ───────────────────────────────────────
function encodeWAV(pcm, sampleRate) {
  const numSamples = pcm.length / 2;
  const dataSize = numSamples * 2;
  const bufferSize = 44 + dataSize;
  const wav = Buffer.alloc(bufferSize);

  wav.write('RIFF', 0);
  wav.writeUInt32LE(bufferSize - 8, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataSize, 40);
  pcm.copy(wav, 44);

  return wav;
}

// ── Whisper transcription via llama-swap ──────────────────────────────
// Endpoint: POST /v1/audio/transcriptions (multipart/form-data)
// Fields: model (string), file (audio/wav)
// Response: { text: "..." }
// ⚠️ NOT /v1/chat/completions — whisper uses OpenAI audio API protocol
// ──────────────────────────────────────────────────────────────────────
async function transcribe(pcm) {
  const { llamaSwap } = config;
  const wav = encodeWAV(pcm, config.audio.sampleRate);

  const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
  const bodyParts = [
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from(`Content-Disposition: form-data; name="model"\r\n\r\n`),
    Buffer.from(llamaSwap.sttModel),
    Buffer.from(`\r\n--${boundary}\r\n`),
    Buffer.from(`Content-Disposition: form-data; name="file"; filename="recording.wav"\r\n`),
    Buffer.from('Content-Type: audio/wav\r\n\r\n'),
    wav,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ];

  const body = Buffer.concat(bodyParts);

  console.log(`[whisper] Transcribing ${pcm.length / 2} samples (${(pcm.length / 2 / config.audio.sampleRate).toFixed(1)}s)`);

  const resp = await fetch(`http://${llamaSwap.host}:${llamaSwap.port}/v1/audio/transcriptions`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Whisper ${resp.status}: ${err}`);
  }

  const result = await resp.json();
  console.log(`[whisper] → "${result.text}"`);
  return result.text;
}

// ── Kokoro TTS via llama-swap ──────────────────────────────────────
// Endpoint: POST /v1/audio/speech (application/json)
// Body: { model, input, voice, response_format?, sample_rate? }
// Response: audio binary (mp3 or wav)
// ⚠️ NOT /v1/chat/completions — kokoro uses OpenAI audio API protocol
// ──────────────────────────────────────────────────────────────────────
async function synthesize(text, session) {
  const { llamaSwap } = config;

  console.log(`[kokoro] Synthesizing: "${text}"`);

  const resp = await fetch(`http://${llamaSwap.host}:${llamaSwap.port}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: llamaSwap.ttsModel,
      input: text,
      voice: llamaSwap.ttsVoice,
      response_format: 'wav',
      sample_rate: config.audio.sampleRate,
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Kokoro ${resp.status}: ${err}`);
  }

  const wav = Buffer.from(await resp.arrayBuffer());
  const pcm = wav.slice(44); // strip WAV header
  console.log(`[kokoro] → ${pcm.length / 2} samples (${(pcm.length / 2 / config.audio.sampleRate).toFixed(1)}s)`);

  // Stream PCM chunks to client
  const CHUNK = 320;
  for (let i = 0; i < pcm.length; i += CHUNK) {
    const chunk = pcm.slice(i, i + CHUNK);
    if (session.ws.readyState === 1) {
      session.ws.send(makePCMFrame(chunk));
    }
  }
}

// ── Chat relay via gateway ──────────────────────────────────────────
async function sendToGateway(message) {
  const { gateway } = config;

  console.log(`[gateway] Sending: "${message}"`);

  const resp = await fetch(`http://${gateway.host}:${gateway.port}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${gateway.token}`,
    },
    body: JSON.stringify({
      model: 'openclaw',
      messages: [
        { role: 'user', content: message }
      ],
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Gateway ${resp.status}: ${err}`);
  }

  const result = await resp.json();
  const reply = result.choices?.[0]?.message?.content || 'No response';
  console.log(`[gateway] → "${reply.slice(0, 100)}..."`);
  return reply;
}

// ── Process pipeline: transcribe → chat → TTS ───────────────────────
async function processAudio(session) {
  if (session.processing) return;
  session.processing = true;

  const pcm = session.flush();
  console.log(`[process] Flushed ${pcm.length} bytes (${(pcm.length / 2 / config.audio.sampleRate).toFixed(1)}s audio)`);
  if (pcm.length < 64) { // Too short (<2ms)
    session.processing = false;
    session.ws.send(makeStatusFrame('⚠️ Audio too short'));
    return;
  }

  try {
    session.ws.send(makeStatusFrame('⏳ Transcribing...'));
    const text = await transcribe(pcm);

    session.ws.send(makeStatusFrame(`📝 "${text}"`));

    session.ws.send(makeStatusFrame('🤖 Thinking...'));
    const reply = await sendToGateway(text);

    session.ws.send(makeStatusFrame(`💬 "${reply.slice(0, 80)}..."`));

    session.ws.send(makeStatusFrame('🔊 Speaking...'));
    await synthesize(reply, session);

    session.ws.send(makeStatusFrame('✅ Done'));
  } catch (err) {
    console.error('[process] Error:', err.message);
    session.ws.send(makeStatusFrame(`❌ ${err.message}`));
  }

  session.processing = false;
}

// ── WebSocket connection handler (shared by HTTP + HTTPS) ───────────
function onWsConnection(ws, req) {
  const id = nextId++;
  const session = new AudioSession(ws, id);
  clients.set(ws, session);

  console.log(`[ws] Client #${id} connected (${req.socket.remoteAddress})`);
  ws.send(makeStatusFrame('✅ Connected to audio-node-tool'));

  ws.on('message', (data, isBinary) => {
    console.log(`[ws] Client #${id} message: type=${isBinary ? 'binary' : 'text'}, length=${data.length}`);
    if (!isBinary) {
      try {
        const cmd = JSON.parse(data.toString());
        console.log(`[ws] Client #${id} command: ${cmd.type}`);
        if (cmd.type === 'start') {
          session.reset();
          console.log(`[ws] Client #${id} started recording`);
        } else if (cmd.type === 'stop') {
          console.log(`[ws] Client #${id} stopped recording, processing...`);
          processAudio(session);
        } else if (cmd.type === 'clear') {
          session.reset();
        }
      } catch (e) {
        console.log(`[ws] Client #${id} parse error:`, e.message);
      }
      return;
    }

    // Accept both framed and raw binary audio
    if (data.length >= 5) {
      const frame = parseFrame(data);
      if (frame && frame.type === 0x01) {
        session.appendPCM(frame.payload);
        return;
      }
    }
    // Raw PCM (no framing) - treat entire payload as audio
    session.appendPCM(Buffer.from(data));
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[ws] Client #${id} disconnected`);
  });

  ws.on('error', (err) => {
    console.error(`[ws] Client #${id} error:`, err.message);
  });
}

// Attach to HTTP WebSocket server
wss.on('connection', (ws, req) => {
  onWsConnection(ws, req);
});

// ── Start ───────────────────────────────────────────────────────────
httpServer.listen(config.port, '0.0.0.0', () => {
  console.log(`🎧 audio-node-tool running on port ${config.port}`);
  console.log(`   → http://localhost:${config.port}`);
  console.log(`   → WebSocket: ws://localhost:${config.port}`);

  if (sslEnabled) {
    const httpsPort = config.httpsPort || (config.port + 1);
    try {
      httpsServer.listen(httpsPort, '0.0.0.0', () => {
        console.log(`   → https://0.0.0.0:${httpsPort} (self-signed, accept in browser)`);
        console.log(`   → WSS: wss://0.0.0.0:${httpsPort}`);
      });
    } catch(e) {
      console.log(`   → HTTPS failed (${e.code}), HTTP-only`);
    }
  } else {
    console.log('   → HTTPS disabled (no certs)');
  }

  console.log(`   Gateway: ${config.gateway.host}:${config.gateway.port}`);
  console.log(`   LlamaSwap: ${config.llamaSwap.host}:${config.llamaSwap.port}`);
});
