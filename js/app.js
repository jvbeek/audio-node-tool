// ── Main app controller ────────────────────────────────────────────

const SAMPLE_RATE = 16000;
const BUFFER_SIZE = 320; // 20ms at 16kHz

// ── DOM refs ────────────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);

const statusDot = $('#status-dot');
const statusText = $('#status-text');
const modeSelect = $('#mode-select');
const canvas = $('#visualizer');
const idleHint = $('#idle-hint');
const transcriptContent = $('#transcript-content');
const responseContent = $('#response-content');
const btnStart = $('#btn-start');
const btnStop = $('#btn-stop');
const pushBtn = $('#push-btn');

// ── State ───────────────────────────────────────────────────────────
let audioCtx = null;
let capture = null;
let playback = null;
let wsClient = new AudioWebSocket();
let isRecording = false;
let currentMode = 'push';
let animFrameId = null;
let waveData = new Float32Array(200);
let transcriptLines = [];
let responseLines = [];

// ── Initialize ──────────────────────────────────────────────────────
function init() {
  audioCtx = new (window.AudioContext || window.webkitAudioContext)({
    sampleRate: SAMPLE_RATE,
  });

  capture = new AudioCapture(audioCtx, BUFFER_SIZE);
  capture.onChunk = (pcm) => {
    if (!isRecording) return;
    wsClient.sendPCM(pcm);
    updateVisualizer();
  };

  playback = new AudioPlayback(audioCtx);
  playback.init();

  wsClient.onStatus = (text) => {
    setStatusText(text);
    if (text.startsWith('📝')) {
      const m = text.match(/"(.*)"/);
      if (m) transcriptContent.textContent = m[1];
    } else if (text.startsWith('💬')) {
      const m = text.match(/"(.*)"/);
      if (m) responseContent.textContent = m[1].replace('...', '');
    } else if (text.startsWith('✅ Done') || text.startsWith('⚠️') || text.startsWith('❌')) {
      // Processing complete (success or error) - reset UI
      btnStart.disabled = false;
      btnStop.disabled = true;
      isRecording = false;
      if (currentMode === 'push') {
        pushBtn.classList.remove('active');
      }
    }
  };

  wsClient.onPCM = (pcm) => {
    playback.sendChunk(pcm);
  };

  wsClient.connect();

  // Event listeners
  btnStart.addEventListener('click', onStart);
  btnStop.addEventListener('click', onStop);
  modeSelect.addEventListener('change', onModeChange);

  // Push-to-talk
  pushBtn.addEventListener('mousedown', onPushStart);
  pushBtn.addEventListener('mouseup', onPushEnd);
  pushBtn.addEventListener('mouseleave', onPushEnd);
  pushBtn.addEventListener('touchstart', (e) => { e.preventDefault(); onPushStart(); });
  pushBtn.addEventListener('touchend', (e) => { e.preventDefault(); onPushEnd(); });

  // Keyboard shortcut (Space for push-to-talk)
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !e.repeat && currentMode === 'push') {
      e.preventDefault();
      onPushStart();
    }
  });
  document.addEventListener('keyup', (e) => {
    if (e.code === 'Space') {
      e.preventDefault();
      onPushEnd();
    }
  });

  console.log('[app] Initialized');
}

// ── Recording controls ──────────────────────────────────────────────
async function onStart() {
  if (audioCtx.state === 'suspended') await audioCtx.resume();

  try {
    await capture.start();
    isRecording = true;
    wsClient.sendCommand({ type: 'start' });

    btnStart.disabled = true;
    btnStop.disabled = false;
    idleHint.style.display = 'none';
    setStatusText('🎤 Recording...');
    startVisualizer();
    console.log('[app] Recording started');
  } catch (err) {
    console.error('[app] Failed to start recording:', err);
    setStatusText('❌ ' + err.message);
  }
}

function onStop() {
  isRecording = false;
  capture.stop();
  wsClient.sendCommand({ type: 'stop' });

  btnStart.disabled = false;
  btnStop.disabled = true;
  setStatusText('⏳ Processing...');
  console.log('[app] Recording stopped');
}

// ── Push-to-talk ───────────────────────────────────────────────────
let pushInterval = null;
function onPushStart() {
  if (audioCtx.state === 'suspended') audioCtx.resume();

  capture.start().then(() => {
    isRecording = true;
    wsClient.sendCommand({ type: 'start' });
    setStatusText('🎤 Speaking...');
    startVisualizer();
    pushBtn.classList.add('active');
    console.log('[app] Push-to-talk started');
  }).catch(err => {
    console.error('[app] PTT error:', err);
  });
}

function onPushEnd() {
  if (!isRecording) return;
  isRecording = false;
  capture.stop();
  wsClient.sendCommand({ type: 'stop' });
  setStatusText('⏳ Processing...');
  pushBtn.classList.remove('active');
  console.log('[app] Push-to-talk ended');
}

// ── Mode change ─────────────────────────────────────────────────────
function onModeChange() {
  currentMode = modeSelect.value;
  if (currentMode === 'push') {
    btnStart.style.display = 'none';
    btnStop.style.display = 'none';
    pushBtn.style.display = 'block';
  } else {
    btnStart.style.display = 'inline-block';
    btnStop.style.display = 'inline-block';
    pushBtn.style.display = 'none';
  }
  console.log(`[app] Mode: ${currentMode}`);
}

// ── Status ──────────────────────────────────────────────────────────
function setStatusText(text) {
  statusText.textContent = text;
}

function setConnectionStatus(connected) {
  if (connected) {
    statusDot.className = 'dot connected';
  } else {
    statusDot.className = 'dot disconnected';
  }
}

// ── Visualizer ──────────────────────────────────────────────────────
function startVisualizer() {
  if (animFrameId) return;
  drawVisualizer();
}

function drawVisualizer() {
  const ctx = canvas.getContext('2d');
  const w = canvas.width = canvas.offsetWidth * devicePixelRatio;
  const h = canvas.height = canvas.offsetHeight * devicePixelRatio;

  ctx.clearRect(0, 0, w, h);

  // Draw waveform
  const barWidth = w / waveData.length;
  ctx.fillStyle = '#58a6ff';
  for (let i = 0; i < waveData.length; i++) {
    const val = Math.abs(waveData[i]);
    const barH = val * h;
    const x = i * barWidth;
    ctx.fillRect(x, (h - barH) / 2, barWidth - 1, barH);
  }

  animFrameId = requestAnimationFrame(drawVisualizer);
}

function updateVisualizer() {
  // Generate random-ish waveform data for visual effect
  // In a real app, you'd use an AnalyserNode
  for (let i = 0; i < waveData.length; i++) {
    waveData[i] = (Math.random() * 2 - 1) * 0.8;
  }
}

// ── Boot ────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
