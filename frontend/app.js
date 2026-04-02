/**
 * app.js — Mini-RAFT Drawing Board Frontend
 *
 * Implements (Week 2):
 *  ✓ WebSocket connection to Gateway with exponential-backoff reconnection
 *  ✓ Status indicator: connected / reconnecting / disconnected
 *  ✓ Canvas resize keeping pixel-perfect dimensions on every window resize
 *  ✓ Freehand drawing via mouse (mousedown → mousemove → mouseup)
 *  ✓ Freehand drawing via touch (touchstart → touchmove → touchend)
 *  ✓ Strokes collected as arrays of {x, y} points — sent on mouseup/touchend
 *  ✓ Send:  { type: "stroke", data: { points, color, width } }
 *  ✓ Recv:  { type: "stroke-committed",  data: stroke }  → render single stroke
 *  ✓ Recv:  { type: "full-sync",         data: { strokes } } → redraw all
 *  ✓ Recv:  { type: "pong" }  → latency measurement
 *  ✓ Recv:  { type: "error", data: { message } }  → toast notification
 *  ✓ Colour palette + eraser tool
 *  ✓ Adjustable brush size with live preview
 *  ✓ Clear button (local canvas clear only)
 *  ✓ Leader name display  (parsed from /health polling)
 *  ✓ Toast notification system
 *  ✓ Disconnected overlay (blocks drawing when offline)
 *
 * WebSocket message shapes (SRS §6.3):
 *  Client → Gateway: { type: "stroke", data: { points:[{x,y}], color, width } }
 *  Gateway → Client: { type: "stroke-committed", data: { index, points, color, width } }
 *  Gateway → Client: { type: "full-sync",        data: { strokes:[...] } }
 */

'use strict';

// ── DOM references ────────────────────────────────────────────────────────────
const canvas         = document.getElementById('drawing-canvas');
const ctx            = canvas.getContext('2d');
const statusEl       = document.getElementById('status-indicator');
const overlayEl      = document.getElementById('canvas-overlay');
const overlayMsgEl   = document.getElementById('overlay-message');
const leaderNameEl   = document.getElementById('leader-name');
const countValueEl   = document.getElementById('count-value');
const toastContainer = document.getElementById('toast-container');
const brushSizeInput = document.getElementById('brush-size');
const brushPreviewEl = document.getElementById('brush-preview');
const btnClear       = document.getElementById('btn-clear');
const colourBtns     = document.querySelectorAll('.colour-btn');

// ── Drawing state ─────────────────────────────────────────────────────────────
let isDrawing    = false;
let currentColor = '#1e1e2e';
let brushSize    = 4;
let isEraser     = false;
let currentStrokePoints = []; // Points collected during the current stroke gesture

// ── WebSocket state ───────────────────────────────────────────────────────────
const GATEWAY_WS_URL = `ws://${location.hostname}:3000`;
let ws            = null;
let reconnectDelay = 500;   // ms — doubles on each failure (exponential backoff)
const MAX_DELAY    = 16000; // cap at 16 s

// ── All committed strokes (for canvas redraw on resize) ───────────────────────
const committedStrokes = []; // Array of { index, points, color, width }

// ══════════════════════════════════════════════════════════════════════════════
// CANVAS UTILITIES
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Resize the canvas backing buffer to match its CSS display size.
 * Called on init and on every window resize. Re-renders all committed strokes
 * after resize because changing canvas dimensions clears the context.
 */
function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  canvas.width  = Math.floor(rect.width  * window.devicePixelRatio);
  canvas.height = Math.floor(rect.height * window.devicePixelRatio);
  ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
  redrawAll();
}

window.addEventListener('resize', resizeCanvas);

/**
 * Render a single stroke onto the canvas.
 * A stroke is { points:[{x,y}…], color, width }
 * Coordinates are CSS pixels (0–canvasCSS width/height).
 */
function renderStroke(stroke) {
  if (!stroke.points || stroke.points.length < 2) return;

  ctx.save();
  ctx.beginPath();
  ctx.lineCap     = 'round';
  ctx.lineJoin    = 'round';
  ctx.strokeStyle = stroke.color === 'eraser' ? '#f8f8f8' : stroke.color;
  ctx.lineWidth   = stroke.width;

  const [first, ...rest] = stroke.points;
  ctx.moveTo(first.x, first.y);
  for (const pt of rest) {
    ctx.lineTo(pt.x, pt.y);
  }
  ctx.stroke();
  ctx.restore();
}

/** Re-render every committed stroke (called after resize or full-sync). */
function redrawAll() {
  const cssW = canvas.width  / window.devicePixelRatio;
  const cssH = canvas.height / window.devicePixelRatio;
  ctx.clearRect(0, 0, cssW, cssH);
  for (const stroke of committedStrokes) {
    renderStroke(stroke);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// POINTER (MOUSE + TOUCH) EVENT HANDLERS
// ══════════════════════════════════════════════════════════════════════════════

/** Convert a mouse or touch event to canvas-relative CSS coordinates. */
function eventToPoint(e) {
  const rect = canvas.getBoundingClientRect();
  const src  = e.touches ? e.touches[0] : e;
  return {
    x: src.clientX - rect.left,
    y: src.clientY - rect.top,
  };
}

function onPointerDown(e) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return; // Block drawing when offline
  e.preventDefault();
  isDrawing = true;
  currentStrokePoints = [];
  const pt = eventToPoint(e);
  currentStrokePoints.push(pt);

  // Start the path visually immediately for responsiveness
  ctx.save();
  ctx.beginPath();
  ctx.lineCap     = 'round';
  ctx.lineJoin    = 'round';
  ctx.strokeStyle = isEraser ? '#f8f8f8' : currentColor;
  ctx.lineWidth   = brushSize;
  ctx.moveTo(pt.x, pt.y);
}

function onPointerMove(e) {
  if (!isDrawing) return;
  e.preventDefault();
  const pt = eventToPoint(e);
  currentStrokePoints.push(pt);

  // Draw the stroke segment live on the local canvas
  ctx.lineTo(pt.x, pt.y);
  ctx.stroke();
  ctx.beginPath();         // Re-open path to avoid visual accumulation
  ctx.moveTo(pt.x, pt.y);
}

function onPointerUp(e) {
  if (!isDrawing) return;
  e.preventDefault();
  ctx.restore();
  isDrawing = false;

  if (currentStrokePoints.length < 2) {
    // Single tap — add a tiny movement so the stroke is visible
    const pt = currentStrokePoints[0];
    if (pt) currentStrokePoints.push({ x: pt.x + 0.1, y: pt.y + 0.1 });
  }

  if (currentStrokePoints.length < 2) return;

  // Send stroke to the Gateway
  sendStroke({
    points: currentStrokePoints,
    color:  isEraser ? 'eraser' : currentColor,
    width:  brushSize,
  });

  currentStrokePoints = [];
}

// Mouse events
canvas.addEventListener('mousedown',  onPointerDown);
canvas.addEventListener('mousemove',  onPointerMove);
canvas.addEventListener('mouseup',    onPointerUp);
canvas.addEventListener('mouseleave', onPointerUp); // Treat leave as stroke end

// Touch events (FR-FE-03)
canvas.addEventListener('touchstart', onPointerDown, { passive: false });
canvas.addEventListener('touchmove',  onPointerMove, { passive: false });
canvas.addEventListener('touchend',   onPointerUp,   { passive: false });

// ══════════════════════════════════════════════════════════════════════════════
// WEBSOCKET CLIENT
// ══════════════════════════════════════════════════════════════════════════════

function connect() {
  setStatus('reconnecting', 'Connecting…');
  showOverlay('Connecting to server…');

  ws = new WebSocket(GATEWAY_WS_URL);

  ws.addEventListener('open', () => {
    reconnectDelay = 500; // Reset backoff on successful connection
    setStatus('connected', 'Connected');
    hideOverlay();
    console.log('[WS] Connected to Gateway');
    // Start a keep-alive ping every 20 s
    startPing();
  });

  ws.addEventListener('message', (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      console.warn('[WS] Received non-JSON message:', event.data);
      return;
    }
    handleMessage(msg);
  });

  ws.addEventListener('close', (event) => {
    stopPing();
    const wasConnected = statusEl.classList.contains('connected');
    setStatus('reconnecting', 'Reconnecting…');
    showOverlay('Connection lost — reconnecting…');

    if (wasConnected) {
      showToast('Connection lost. Reconnecting…', 'warn');
    }

    console.log(`[WS] Closed (code=${event.code}). Retrying in ${reconnectDelay}ms…`);
    setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_DELAY);
      connect();
    }, reconnectDelay);
  });

  ws.addEventListener('error', (err) => {
    console.error('[WS] Error:', err);
    // 'close' fires after 'error', so reconnection is handled there
  });
}

/** Handle an incoming WebSocket message from the Gateway. */
function handleMessage(msg) {
  switch (msg.type) {

    case 'stroke-committed': {
      // A stroke has been committed by the RAFT leader — render it
      const stroke = msg.data;
      // Avoid duplicating locally-drawn strokes (they're rendered live already)
      if (!committedStrokes.find(s => s.index === stroke.index)) {
        committedStrokes.push(stroke);
        renderStroke(stroke);
      }
      break;
    }

    case 'full-sync': {
      // Full canvas state received (on connect / reconnect) — rebuild canvas
      const strokes = msg.data?.strokes || [];
      committedStrokes.length = 0;
      committedStrokes.push(...strokes);
      redrawAll();
      console.log(`[WS] Full-sync: rendered ${strokes.length} stroke(s)`);
      if (strokes.length > 0) {
        showToast(`Canvas synced — ${strokes.length} stroke(s) loaded`, 'info');
      }
      break;
    }

    case 'pong':
      // Heartbeat reply — connection healthy
      break;

    case 'error':
      console.warn('[WS] Server error:', msg.data?.message);
      showToast(msg.data?.message || 'Server error', 'error');
      break;

    default:
      console.warn('[WS] Unknown message type:', msg.type);
  }
}

/** Send a stroke to the Gateway. */
function sendStroke(strokeData) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'stroke', data: strokeData }));
}

// ── Keep-alive ping ───────────────────────────────────────────────────────────
let pingInterval = null;

function startPing() {
  pingInterval = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping' }));
    }
  }, 20_000);
}

function stopPing() {
  clearInterval(pingInterval);
  pingInterval = null;
}

// ══════════════════════════════════════════════════════════════════════════════
// UI HELPERS
// ══════════════════════════════════════════════════════════════════════════════

/** Update the status badge text + CSS class. */
function setStatus(cssClass, text) {
  statusEl.className = `status ${cssClass}`;
  statusEl.textContent = text;
}

/** Show the blocking overlay with a message. */
function showOverlay(message) {
  overlayMsgEl.textContent = message;
  overlayEl.classList.remove('hidden');
  overlayEl.removeAttribute('aria-hidden');
}

/** Hide the blocking overlay (reveals the canvas for drawing). */
function hideOverlay() {
  overlayEl.classList.add('hidden');
  overlayEl.setAttribute('aria-hidden', 'true');
}

/**
 * Show a toast notification for a given duration.
 * @param {string} message
 * @param {'info'|'success'|'warn'|'error'} type
 * @param {number} duration  ms before auto-dismiss
 */
function showToast(message, type = 'info', duration = 3500) {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  toastContainer.appendChild(toast);
  setTimeout(() => toast.remove(), duration);
}

/** Update the leader badge in the header. */
function updateLeaderBadge(leaderUrl) {
  if (!leaderUrl) {
    leaderNameEl.textContent = '–';
    return;
  }
  // Parse "http://replica2:4002" → "replica2"
  try {
    const hostname = new URL(leaderUrl).hostname;
    leaderNameEl.textContent = hostname;
  } catch {
    leaderNameEl.textContent = leaderUrl;
  }
}

// ── Brush preview ─────────────────────────────────────────────────────────────
function updateBrushPreview() {
  const size  = Math.min(brushSize, 22);
  const color = isEraser ? '#aaa' : currentColor;
  brushPreviewEl.style.width      = `${size}px`;
  brushPreviewEl.style.height     = `${size}px`;
  brushPreviewEl.style.background = color;
  brushPreviewEl.style.border     = isEraser ? '1.5px dashed #666' : 'none';
}

// ── Poll Gateway /health for leader info ──────────────────────────────────────
function startHealthPolling() {
  const HEALTH_URL = `http://${location.hostname}:3000/health`;
  setInterval(async () => {
    try {
      const res  = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(2000) });
      const data = await res.json();
      updateLeaderBadge(data.leader);
      if (data.clients !== undefined) {
        countValueEl.textContent = data.clients;
      }
    } catch {
      // Gateway unreachable — WS reconnection will handle recovery
    }
  }, 3000);
}

// ══════════════════════════════════════════════════════════════════════════════
// TOOLBAR WIRE-UP
// ══════════════════════════════════════════════════════════════════════════════

// Colour buttons
colourBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    const colour = btn.dataset.colour;

    // Update active state
    colourBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    if (colour === 'eraser') {
      isEraser = true;
    } else {
      isEraser     = false;
      currentColor = colour;
    }

    updateBrushPreview();
  });
});

// Brush size slider
brushSizeInput.addEventListener('input', () => {
  brushSize = parseInt(brushSizeInput.value, 10);
  updateBrushPreview();
});

// Clear button (local canvas only — does not send a stroke to the cluster)
btnClear.addEventListener('click', () => {
  committedStrokes.length = 0;
  const cssW = canvas.width  / window.devicePixelRatio;
  const cssH = canvas.height / window.devicePixelRatio;
  ctx.clearRect(0, 0, cssW, cssH);
  showToast('Canvas cleared locally', 'info', 2000);
});

// ══════════════════════════════════════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════════════════════════════════════

resizeCanvas();         // Set correct pixel dimensions immediately
updateBrushPreview();   // Sync brush preview with initial values
connect();              // Open WebSocket to Gateway
startHealthPolling();   // Poll /health every 3 s for leader info

console.log('[Frontend] Mini-RAFT Drawing Board initialised');
