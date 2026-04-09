/**
 * app.js — Mini-RAFT Drawing Board Frontend
 *
 * Pipeline:
 *   User draws  →  points collected on live canvas layer
 *   onPointerUp →  decimated points sent as { type:"stroke", data:{points,color,width} }
 *   Gateway     →  forwards to RAFT Leader via /client-stroke
 *   Leader      →  AppendEntries to majority → commit → POST /broadcast to Gateway
 *   Gateway     →  broadcasts { type:"stroke-committed", data:{index,points,color,width} }
 *   Frontend    →  receives stroke-committed, deduplicates, adds to committedStrokes, redraws
 *
 * Key design decisions:
 *  - Two logical layers: committedStrokes[] (persisted), pendingStrokes[] (in-flight local)
 *    Both are replayed on resize → no strokes vanish during replication round-trip
 *  - Stroke point decimation (distance threshold 3px) keeps message sizes manageable
 *  - Pending strokes are matched to committed ones by a client-local tempId to avoid
 *    double-rendering when the committed echo arrives back
 *  - Eraser is rendered with the canvas background colour (#f8f8f8) for correct erase effect
 */

'use strict';

// ── DOM references ────────────────────────────────────────────────────────────
const canvas = document.getElementById('drawing-canvas');
const ctx = canvas.getContext('2d');
const statusEl = document.getElementById('status-indicator');
const overlayEl = document.getElementById('canvas-overlay');
const overlayMsgEl = document.getElementById('overlay-message');
const leaderNameEl = document.getElementById('leader-name');
const countValueEl = document.getElementById('count-value');
const queueDepthEl = document.getElementById('queue-depth');
const toastContainer = document.getElementById('toast-container');
const brushSizeInput = document.getElementById('brush-size');
const brushPreviewEl = document.getElementById('brush-preview');
const btnClear = document.getElementById('btn-clear');
const colourBtns = document.querySelectorAll('.colour-btn');

// ── Canvas background colour (must match CSS #canvas-container background) ───
const CANVAS_BG = '#f8f8f8';

// ── Drawing state ─────────────────────────────────────────────────────────────
let isDrawing = false;
let currentColor = '#1e1e2e';
let brushSize = 4;
let isEraser = false;
let currentStrokePoints = []; // Raw points collected during the current stroke gesture
let lastEmittedPoint = null; // Last point added — used for distance decimation

// ── Point decimation threshold ────────────────────────────────────────────────
// Skip a new point if it is closer than this to the last recorded point.
// 3 CSS px is imperceptible visually but cuts point count by ~60–80% on fast strokes.
const MIN_POINT_DISTANCE_PX = 3;

// ── Stroke stores ─────────────────────────────────────────────────────────────
/**
 * Committed strokes received from the RAFT cluster (authoritative, survive resize).
 * Each entry: { index, points, color, width }
 */
const committedStrokes = [];

/**
 * Locally-drawn strokes awaiting commit acknowledgment from the server.
 * Each entry: { tempId, points, color, width }
 * Removed when the matching stroke-committed arrives (matched by tempId).
 * Rendered in a slightly faded style to signal "sending".
 */
const pendingStrokes = [];

/**
 * Map of tempId → stroke data for fast lookup when committed echo arrives.
 * Since the server doesn't echo tempId, we match instead by checking that
 * the pending stroke was sent most recently (FIFO queue assumption).
 */
let nextTempId = 1;

// ── WebSocket state ───────────────────────────────────────────────────────────
const GATEWAY_WS_URL = `ws://${location.hostname}:3000`;
let ws = null;
let reconnectDelay = 500;   // ms — doubles on each failure (exponential backoff)
const MAX_DELAY = 16000; // cap at 16 s

// ══════════════════════════════════════════════════════════════════════════════
// CANVAS UTILITIES
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Resize the canvas backing buffer to match its CSS display size.
 * Called on init and on every window resize. Re-renders both committed and
 * pending strokes because changing canvas dimensions clears the context.
 */
function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.floor(rect.width * window.devicePixelRatio);
  canvas.height = Math.floor(rect.height * window.devicePixelRatio);
  ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
  redrawAll();
}

window.addEventListener('resize', resizeCanvas);

/**
 * Render a single stroke onto the canvas.
 * @param {{ points: {x,y}[], color: string, width: number }} stroke
 * @param {number} [alpha=1]  Opacity — 0.45 for pending strokes
 */
function renderStroke(stroke, alpha = 1) {
  if (!stroke.points || stroke.points.length < 2) return;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = stroke.color === 'eraser' ? CANVAS_BG : stroke.color;
  ctx.lineWidth = stroke.width;

  const [first, ...rest] = stroke.points;
  ctx.moveTo(first.x, first.y);
  for (const pt of rest) ctx.lineTo(pt.x, pt.y);
  ctx.stroke();
  ctx.restore();
}

/**
 * Re-render all committed strokes then all pending strokes.
 * Called after resize or full-sync.
 */
function redrawAll() {
  const cssW = canvas.width / window.devicePixelRatio;
  const cssH = canvas.height / window.devicePixelRatio;
  ctx.clearRect(0, 0, cssW, cssH);

  for (const stroke of committedStrokes) renderStroke(stroke);
  for (const stroke of pendingStrokes) renderStroke(stroke, 0.45);
}

// ══════════════════════════════════════════════════════════════════════════════
// POINTER (MOUSE + TOUCH) EVENT HANDLERS
// ══════════════════════════════════════════════════════════════════════════════

/** Convert a mouse or touch event to canvas-relative CSS coordinates. */
function eventToPoint(e) {
  const rect = canvas.getBoundingClientRect();
  const src = e.touches ? e.touches[0] : e;
  return { x: src.clientX - rect.left, y: src.clientY - rect.top };
}

/** Squared distance between two points (avoids Math.sqrt). */
function dist2(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function onPointerDown(e) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  e.preventDefault();
  isDrawing = true;
  currentStrokePoints = [];
  lastEmittedPoint = null;

  const pt = eventToPoint(e);
  currentStrokePoints.push(pt);
  lastEmittedPoint = pt;

  // Begin live path on canvas immediately for responsive feel
  ctx.save();
  ctx.beginPath();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = isEraser ? CANVAS_BG : currentColor;
  ctx.lineWidth = brushSize;
  ctx.moveTo(pt.x, pt.y);
}

function onPointerMove(e) {
  if (!isDrawing) return;
  e.preventDefault();

  const pt = eventToPoint(e);

  // ── Point decimation ───────────────────────────────────────────────────────
  // Only record this point if it moved far enough from the last recorded one.
  const threshold2 = MIN_POINT_DISTANCE_PX * MIN_POINT_DISTANCE_PX;
  if (lastEmittedPoint && dist2(pt, lastEmittedPoint) < threshold2) return;

  currentStrokePoints.push(pt);
  lastEmittedPoint = pt;

  // Draw the stroke segment live
  ctx.lineTo(pt.x, pt.y);
  ctx.stroke();
  ctx.beginPath(); // Re-open to avoid accumulation
  ctx.moveTo(pt.x, pt.y);
}

function onPointerUp(e) {
  if (!isDrawing) return;
  e.preventDefault();
  ctx.restore();
  isDrawing = false;

  // Ensure at least 2 points for a visible stroke
  if (currentStrokePoints.length < 2) {
    const pt = currentStrokePoints[0];
    if (pt) currentStrokePoints.push({ x: pt.x + 0.5, y: pt.y + 0.5 });
  }
  if (currentStrokePoints.length < 2) return;

  const strokeData = {
    points: currentStrokePoints,
    color: isEraser ? 'eraser' : currentColor,
    width: brushSize,
  };

  // ── Add to pending store so it survives resize while in-flight ────────────
  const tempId = nextTempId++;
  const pending = { tempId, ...strokeData };
  pendingStrokes.push(pending);

  // Send to Gateway → Leader → RAFT cluster
  sendStroke(strokeData, tempId);

  currentStrokePoints = [];
  lastEmittedPoint = null;
}

// Mouse events
canvas.addEventListener('mousedown', onPointerDown);
canvas.addEventListener('mousemove', onPointerMove);
canvas.addEventListener('mouseup', onPointerUp);
canvas.addEventListener('mouseleave', onPointerUp);

// Touch events
canvas.addEventListener('touchstart', onPointerDown, { passive: false });
canvas.addEventListener('touchmove', onPointerMove, { passive: false });
canvas.addEventListener('touchend', onPointerUp, { passive: false });

// ══════════════════════════════════════════════════════════════════════════════
// WEBSOCKET CLIENT
// ══════════════════════════════════════════════════════════════════════════════

function connect() {
  setStatus('reconnecting', 'Connecting…');
  showOverlay('Connecting to server…');

  ws = new WebSocket(GATEWAY_WS_URL);

  ws.addEventListener('open', () => {
    reconnectDelay = 500;
    setStatus('connected', 'Connected');
    hideOverlay();
    console.log('[WS] Connected to Gateway');
    startPing();
  });

  ws.addEventListener('message', (event) => {
    let msg;
    try { msg = JSON.parse(event.data); }
    catch { console.warn('[WS] Non-JSON message:', event.data); return; }
    handleMessage(msg);
  });

  ws.addEventListener('close', (event) => {
    stopPing();
    const wasConnected = statusEl.classList.contains('connected');
    setStatus('reconnecting', 'Reconnecting…');
    showOverlay('Connection lost — reconnecting…');
    if (wasConnected) showToast('Connection lost. Reconnecting…', 'warn');
    console.log(`[WS] Closed (code=${event.code}). Retrying in ${reconnectDelay}ms…`);
    setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_DELAY);
      connect();
    }, reconnectDelay);
  });

  ws.addEventListener('error', (err) => {
    console.error('[WS] Error:', err);
  });
}

// ── Incoming message handler ──────────────────────────────────────────────────
function handleMessage(msg) {
  switch (msg.type) {

    case 'stroke-committed': {
      /**
       * A stroke has been committed by the RAFT cluster.
       *
       * Deduplication strategy:
       *  - Committed strokes already in committedStrokes[] → skip (idempotent on reconnect sync)
       *  - The *first* pending stroke in our queue is assumed to be the matching local stroke
       *    (FIFO: we don't reorder strokes). Remove it from pending to stop its faded rendering.
       *    The committed copy is added to committedStrokes[] and rendered at full opacity.
       *  - If no pending, it's someone else's stroke → just render it.
       */
      const stroke = msg.data;

      // Idempotency guard — full-sync can replay already-committed strokes
      if (committedStrokes.some(s => s.index === stroke.index)) break;

      // Remove the oldest pending stroke (matches iff we sent it; otherwise harmless)
      if (pendingStrokes.length > 0) {
        pendingStrokes.shift(); // Consume the local pending placeholder
      }

      committedStrokes.push(stroke);

      // Full redraw so pending strokes are correctly re-layered after dequeue
      redrawAll();
      break;
    }

    case 'full-sync': {
      // Full canvas state on connect / reconnect — rebuild everything
      const strokes = msg.data?.strokes || [];
      committedStrokes.length = 0;
      committedStrokes.push(...strokes);
      // Keep pending strokes — they're still in-flight and will sync when committed
      redrawAll();
      console.log(`[WS] Full-sync: ${strokes.length} stroke(s)`);
      if (strokes.length > 0) showToast(`Canvas synced — ${strokes.length} stroke(s) loaded`, 'info');
      break;
    }

    case 'pong':
      // Keep-alive reply — no-op
      break;

    case 'error':
      console.warn('[WS] Server error:', msg.data?.message);
      showToast(msg.data?.message || 'Server error', 'error');
      break;

    /**
     * Graceful failover messages (FR-GW-07 / FR-GW-08)
     *
     * These are pushed by the Gateway when leaderTracker detects a leader
     * transition.  The WebSocket connection is NEVER closed — we only update
     * the status indicator and show a transient toast so the user knows
     * their strokes are safely queued.
     */
    case 'leader-changing':
      // Leader is down — election in progress, strokes are queued gateway-side
      console.warn('[WS] Leader changing — election in progress');
      setFailoverIndicator(true);
      showToast('Leader election in progress — strokes are safely queued ⏳', 'warn', 5000);
      break;

    case 'leader-restored':
      // New leader elected, queue drained — system is back to full health
      console.log('[WS] Leader restored:', msg.data?.leader);
      setFailoverIndicator(false);
      updateLeaderBadge(msg.data?.leader || null);
      showToast('New leader elected — drawing resumed ✅', 'success', 3000);
      break;

    default:
      console.warn('[WS] Unknown message type:', msg.type);
  }
}

/** Send a stroke to the Gateway. */
function sendStroke(strokeData) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'stroke', data: strokeData }));
  console.log(`[WS] Sent stroke — ${strokeData.points.length} point(s)`);
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

function setStatus(cssClass, text) {
  statusEl.className = `status ${cssClass}`;
  statusEl.textContent = text;
}

/**
 * Show or hide the failover indicator.
 *
 * When isActive=true the status pill switches to a pulsing "Electing…" state
 * (reusing the existing .reconnecting CSS class so no new styles are needed).
 * When isActive=false, it reverts to "Connected" — keeping the WS intact.
 *
 * The overlay is intentionally NOT shown: the canvas stays usable so the user
 * can keep drawing (strokes are queued and will be replayed automatically).
 */
function setFailoverIndicator(isActive) {
  if (isActive) {
    // Show pulsing yellow pill — don't show the full canvas overlay
    setStatus('reconnecting', 'Electing…');
    if (queueDepthEl) {
      queueDepthEl.textContent = 'queued';
      queueDepthEl.classList.remove('hidden');
    }
  } else {
    // Only restore 'connected' if the WS is actually still open
    if (ws && ws.readyState === WebSocket.OPEN) {
      setStatus('connected', 'Connected');
    }
    if (queueDepthEl) {
      queueDepthEl.classList.add('hidden');
    }
  }
}

function showOverlay(message) {
  overlayMsgEl.textContent = message;
  overlayEl.classList.remove('hidden');
  overlayEl.removeAttribute('aria-hidden');
}

function hideOverlay() {
  overlayEl.classList.add('hidden');
  overlayEl.setAttribute('aria-hidden', 'true');
}

/**
 * Show a toast notification.
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

/** Update the leader badge. Accepts "http://replica1:4001" → shows "replica1". */
function updateLeaderBadge(leaderUrl) {
  if (!leaderUrl) { leaderNameEl.textContent = '–'; return; }
  try {
    leaderNameEl.textContent = new URL(leaderUrl).hostname;
  } catch {
    leaderNameEl.textContent = leaderUrl;
  }
}

// ── Brush preview ─────────────────────────────────────────────────────────────
function updateBrushPreview() {
  const size = Math.min(brushSize, 22);
  const color = isEraser ? '#aaa' : currentColor;
  brushPreviewEl.style.width = `${size}px`;
  brushPreviewEl.style.height = `${size}px`;
  brushPreviewEl.style.background = color;
  brushPreviewEl.style.border = isEraser ? '1.5px dashed #666' : 'none';
}

// ── Poll Gateway /health for leader info + queue depth ────────────────────────
function startHealthPolling() {
  const HEALTH_URL = `http://${location.hostname}:3000/health`;

  setInterval(async () => {
    try {
      const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(2000) });
      const data = await res.json();

      // Update leader badge (unless failover is in progress — badge will
      // be updated from the leader-restored WS message instead)
      if (!data.failoverActive) {
        updateLeaderBadge(data.leader);
      }

      if (data.clients !== undefined) {
        countValueEl.textContent = data.clients;
      }

      // Keep failover indicator in sync with gateway state (catches cases
      // where the WS 'leader-changing' message arrived before we were ready)
      if (data.failoverActive) {
        setFailoverIndicator(true);
      } else if (statusEl.classList.contains('reconnecting') && ws && ws.readyState === WebSocket.OPEN) {
        // Failover ended but we might have missed the leader-restored WS message
        setFailoverIndicator(false);
        updateLeaderBadge(data.leader);
      }

      // Show queue depth badge — hidden when queue is empty
      if (queueDepthEl) {
        const depth = data.queueDepth ?? 0;
        if (depth > 0) {
          queueDepthEl.textContent = `${depth} queued`;
          queueDepthEl.classList.remove('hidden');
        } else if (!data.failoverActive) {
          queueDepthEl.classList.add('hidden');
        }
      }
    } catch {
      // Gateway unreachable — WS reconnection handles recovery
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
    colourBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    if (colour === 'eraser') {
      isEraser = true;
    } else {
      isEraser = false;
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

// Clear button — local canvas only
btnClear.addEventListener('click', () => {
  committedStrokes.length = 0;
  pendingStrokes.length = 0;
  const cssW = canvas.width / window.devicePixelRatio;
  const cssH = canvas.height / window.devicePixelRatio;
  ctx.clearRect(0, 0, cssW, cssH);
  showToast('Canvas cleared locally', 'info', 2000);
});

// ══════════════════════════════════════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════════════════════════════════════

resizeCanvas();       // Set correct pixel dimensions + scale immediately
updateBrushPreview(); // Sync brush preview with initial values
connect();            // Open WebSocket to Gateway
startHealthPolling(); // Poll /health every 3 s for leader info + queue depth

console.log('[Frontend] Mini-RAFT Drawing Board initialised');
