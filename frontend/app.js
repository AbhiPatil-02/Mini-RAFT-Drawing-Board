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
 *  - Two logical layers: committedStrokes[] (RAFT-committed) + pendingStrokes[] (in-flight local)
 *    Both replayed on resize → no strokes vanish during replication round-trip
 *  - Stroke point decimation (3px threshold) cuts point count ~60–80% on fast strokes
 *  - On reconnect: pendingStrokes[] are CLEARED because the gateway may not have delivered
 *    them to the leader — the full-sync from the server is the authoritative canvas state
 *  - Eraser rendered with canvas background colour (#f8f8f8) for correct erase effect
 *  - visibilitychange + online events accelerate reconnection (no waiting up to 16 s)
 *  - Overlay uses opacity + pointer-events fade instead of display:none for smooth animation
 */

'use strict';

// ── DOM references ────────────────────────────────────────────────────────────
const canvas        = document.getElementById('drawing-canvas');
const ctx           = canvas.getContext('2d');
const statusEl      = document.getElementById('status-indicator');
const overlayEl     = document.getElementById('canvas-overlay');
const overlayMsgEl  = document.getElementById('overlay-message');
const overlaySubEl  = document.getElementById('overlay-sub');       // NEW
const leaderNameEl  = document.getElementById('leader-name');
const countValueEl  = document.getElementById('count-value');
const queueDepthEl  = document.getElementById('queue-depth');
const toastContainer = document.getElementById('toast-container');
const brushSizeInput = document.getElementById('brush-size');
const brushPreviewEl = document.getElementById('brush-preview');
const btnClear      = document.getElementById('btn-clear');
const colourBtns    = document.querySelectorAll('.colour-btn');

// ── Canvas background colour (must match CSS #canvas-container background) ───
const CANVAS_BG = '#f8f8f8';

// ── Drawing state ─────────────────────────────────────────────────────────────
let isDrawing         = false;
let currentColor      = '#1e1e2e';
let brushSize         = 4;
let isEraser          = false;
let currentStrokePoints = [];   // Raw points collected during current stroke gesture
let lastEmittedPoint  = null;   // Last recorded point — used for decimation

// ── Point decimation threshold ────────────────────────────────────────────────
// Skip a new point if it is closer than this to the last recorded one.
// 3 CSS px is imperceptible visually but cuts point count by ~60–80%.
const MIN_POINT_DISTANCE_PX = 3;

// ── Stroke stores ─────────────────────────────────────────────────────────────
/**
 * Committed strokes received from the RAFT cluster (authoritative, survive resize).
 * Each entry: { index, points, color, width }
 */
const committedStrokes = [];

/**
 * Locally-drawn strokes awaiting commit acknowledgment from the server.
 * IMPORTANT: these are cleared on every reconnect because the gateway may not
 * have forwarded them to the leader before the connection dropped.
 * The authoritative canvas state always comes from the full-sync on reconnect.
 */
const pendingStrokes = [];

/** Monotonic counter for client-local stroke IDs. */
let nextTempId = 1;

// ── Reconnection state ────────────────────────────────────────────────────────
const GATEWAY_WS_URL  = `ws://${location.hostname}:3000`;
let ws                = null;
let reconnectTimer    = null;
let reconnectDelay    = 500;        // ms — doubles on each failure (exponential backoff)
const RECONNECT_MIN   = 500;
const RECONNECT_MAX   = 16_000;    // cap at 16 s
let reconnectCount    = 0;          // counts consecutive failures (0 = first connect)
let isIntentionalClose = false;     // set before ws.close() to suppress reconnect

// ── Received index tracking (dedup during reconnect window) ──────────────────
/**
 * Highest committed index we've seen so far.
 * If a broadcast arrives BEFORE the full-sync completes (e.g. during the brief
 * window between WS open and receiving full-sync), we buffer it here so we can
 * merge correctly once full-sync arrives.
 */
let pendingBroadcasts = []; // strokes received before first full-sync on this conn

// ══════════════════════════════════════════════════════════════════════════════
// CANVAS UTILITIES
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Resize the canvas backing buffer to match its CSS display size.
 * Called on init and on every window resize. Re-renders all strokes because
 * changing canvas dimensions clears the context.
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
 * @param {{ points: {x,y}[], color: string, width: number }} stroke
 * @param {number} [alpha=1]  Opacity — 0.45 for pending strokes
 */
function renderStroke(stroke, alpha = 1) {
  if (!stroke.points || stroke.points.length < 2) return;

  ctx.save();
  ctx.globalAlpha    = alpha;
  ctx.beginPath();
  ctx.lineCap        = 'round';
  ctx.lineJoin       = 'round';
  ctx.strokeStyle    = stroke.color === 'eraser' ? CANVAS_BG : stroke.color;
  ctx.lineWidth      = stroke.width;

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
  const cssW = canvas.width  / window.devicePixelRatio;
  const cssH = canvas.height / window.devicePixelRatio;
  ctx.clearRect(0, 0, cssW, cssH);

  for (const stroke of committedStrokes) renderStroke(stroke);
  for (const stroke of pendingStrokes)   renderStroke(stroke, 0.45);
}

// ══════════════════════════════════════════════════════════════════════════════
// POINTER (MOUSE + TOUCH) EVENT HANDLERS
// ══════════════════════════════════════════════════════════════════════════════

/** Convert a mouse or touch event to canvas-relative CSS coordinates. */
function eventToPoint(e) {
  const rect = canvas.getBoundingClientRect();
  const src  = e.touches ? e.touches[0] : e;
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
  lastEmittedPoint    = null;

  const pt = eventToPoint(e);
  currentStrokePoints.push(pt);
  lastEmittedPoint = pt;

  // Begin live path on canvas immediately for responsive feel
  ctx.save();
  ctx.beginPath();
  ctx.lineCap    = 'round';
  ctx.lineJoin   = 'round';
  ctx.strokeStyle = isEraser ? CANVAS_BG : currentColor;
  ctx.lineWidth  = brushSize;
  ctx.moveTo(pt.x, pt.y);
}

function onPointerMove(e) {
  if (!isDrawing) return;
  e.preventDefault();

  const pt = eventToPoint(e);

  // ── Point decimation ─────────────────────────────────────────────────────
  const threshold2 = MIN_POINT_DISTANCE_PX * MIN_POINT_DISTANCE_PX;
  if (lastEmittedPoint && dist2(pt, lastEmittedPoint) < threshold2) return;

  currentStrokePoints.push(pt);
  lastEmittedPoint = pt;

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
    color:  isEraser ? 'eraser' : currentColor,
    width:  brushSize,
  };

  // Add to pending store so it survives resize while in-flight
  const tempId  = nextTempId++;
  pendingStrokes.push({ tempId, ...strokeData });

  sendStroke(strokeData);

  currentStrokePoints = [];
  lastEmittedPoint    = null;
}

// Mouse events
canvas.addEventListener('mousedown',  onPointerDown);
canvas.addEventListener('mousemove',  onPointerMove);
canvas.addEventListener('mouseup',    onPointerUp);
canvas.addEventListener('mouseleave', onPointerUp);

// Touch events
canvas.addEventListener('touchstart', onPointerDown, { passive: false });
canvas.addEventListener('touchmove',  onPointerMove, { passive: false });
canvas.addEventListener('touchend',   onPointerUp,   { passive: false });

// ══════════════════════════════════════════════════════════════════════════════
// WEBSOCKET CLIENT — RECONNECTION WITH FULL-SYNC
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Open a WebSocket connection to the Gateway.
 *
 * Reconnection behaviour (FR-FE-09 / FR-FE-10):
 *  1. On open → hide overlay, reset delay, wait for full-sync
 *  2. On full-sync → clear committedStrokes, rebuild from server state, redraw
 *     → also clear pendingStrokes (they were lost on disconnect; server is authoritative)
 *     → drain any broadcasts buffered before full-sync arrived
 *  3. On close/error → show overlay with attempt counter, schedule retry
 *     → exponential backoff: 500 → 1000 → 2000 → 4000 → 8000 → 16000 → 16000…
 *  4. visibilitychange / online events → trigger immediate reconnect
 *     (avoids user waiting up to 16 s when they switch back to the tab)
 *
 * Canvas guarantee: after every reconnect the canvas exactly matches
 * the RAFT cluster's committed log — zero missing strokes, zero duplicates.
 */
function connect() {
  // Clean up any previous socket
  if (ws) {
    isIntentionalClose = true;
    ws.close();
    isIntentionalClose = false;
    ws = null;
  }

  const isReconnect = reconnectCount > 0;
  setStatus('reconnecting', isReconnect ? 'Reconnecting…' : 'Connecting…');
  showOverlay(
    isReconnect
      ? `Reconnecting… (attempt ${reconnectCount})`
      : 'Connecting to server…',
    isReconnect ? 'Canvas will restore automatically' : ''
  );

  // Each new connection starts fresh: any broadcasts received before full-sync
  // is confirmed will be buffered here and merged in afterwards.
  pendingBroadcasts = [];
  let fullSyncReceived = false;

  ws = new WebSocket(GATEWAY_WS_URL);

  // ── Open ───────────────────────────────────────────────────────────────────
  ws.addEventListener('open', () => {
    reconnectDelay = RECONNECT_MIN;
    console.log(`[WS] ${isReconnect ? 'Reconnected' : 'Connected'} to Gateway`);
    // Status stays 'reconnecting' (spinner) until full-sync arrives
    startPing();
  });

  // ── Messages ───────────────────────────────────────────────────────────────
  ws.addEventListener('message', (event) => {
    let msg;
    try { msg = JSON.parse(event.data); }
    catch { console.warn('[WS] Non-JSON message:', event.data); return; }

    // Buffer stroke-committed messages that arrive BEFORE full-sync
    // (can happen in the brief window between open and receiving full-sync)
    if (msg.type === 'stroke-committed' && !fullSyncReceived) {
      pendingBroadcasts.push(msg.data);
      return;
    }

    // Once we know full-sync status, route all messages normally
    if (msg.type === 'full-sync') {
      fullSyncReceived = true;
    }

    handleMessage(msg);
  });

  // ── Close ──────────────────────────────────────────────────────────────────
  ws.addEventListener('close', (event) => {
    stopPing();

    if (isIntentionalClose) return; // We closed it ourselves — skip reconnect

    reconnectCount++;
    const delay = reconnectDelay;
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX);

    const wasConnected = statusEl.classList.contains('connected');
    setStatus('reconnecting', 'Reconnecting…');
    showOverlay(
      `Connection lost — reconnecting in ${Math.round(delay / 1000)}s…`,
      `Attempt ${reconnectCount} • Canvas will restore on reconnect`
    );

    if (wasConnected) {
      showToast('Connection lost — reconnecting…', 'warn', 4000);
    }

    console.log(`[WS] Closed (code=${event.code}). Retry #${reconnectCount} in ${delay}ms`);

    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, delay);
  });

  // ── Error ──────────────────────────────────────────────────────────────────
  ws.addEventListener('error', () => {
    // close event fires immediately after error — reconnect logic is there
    console.error('[WS] Socket error — waiting for close event to reconnect');
  });
}

// ── Incoming message router ───────────────────────────────────────────────────
function handleMessage(msg) {
  switch (msg.type) {

    // ── FULL-SYNC: complete canvas restore on (re)connect ──────────────────
    case 'full-sync': {
      /**
       * Full canvas restore protocol (FR-FE-10):
       *
       * 1.  Replace committedStrokes[] with the authoritative server state.
       * 2.  CLEAR pendingStrokes[] — these were sent to the old (dead) socket;
       *     the server has no record of them. Keeping them would show ghost
       *     strokes that the cluster may never commit.
       * 3.  Merge any stroke-committed broadcasts that arrived before this
       *     full-sync (the brief window between open and full-sync).
       *     Only merge indices not already in the full-sync payload.
       * 4.  Redraw the canvas.
       * 5.  Update UI: hide overlay, show connected, optional toast.
       */
      const strokes = msg.data?.strokes || [];

      // 1. Replace committed strokes
      committedStrokes.length = 0;
      committedStrokes.push(...strokes);

      // 2. Clear stale pending strokes — server state is authoritative
      const hadPending = pendingStrokes.length;
      pendingStrokes.length = 0;

      // 3. Drain buffered pre-sync broadcasts (idempotent merge)
      const committedSet = new Set(committedStrokes.map(s => s.index));
      for (const stroke of pendingBroadcasts) {
        if (!committedSet.has(stroke.index)) {
          committedStrokes.push(stroke);
          committedSet.add(stroke.index);
        }
      }
      // Sort so canvas renders in commit order
      committedStrokes.sort((a, b) => a.index - b.index);
      pendingBroadcasts = [];

      // 4. Redraw
      redrawAll();

      // 5. UI update
      hideOverlay();
      setStatus('connected', 'Connected');

      const isReconnect = reconnectCount > 0;
      reconnectCount = 0; // Reset after successful sync

      console.log(
        `[WS] Full-sync: ${strokes.length} stroke(s)` +
        (isReconnect ? ' (reconnected — canvas restored)' : '')
      );

      if (hadPending > 0) {
        showToast(`${hadPending} in-flight stroke(s) may not have been committed — canvas re-synced from server`, 'warn', 5000);
      } else if (strokes.length > 0) {
        showToast(
          isReconnect
            ? `Canvas restored — ${strokes.length} stroke(s) loaded ✅`
            : `Canvas synced — ${strokes.length} stroke(s)`,
          isReconnect ? 'success' : 'info',
          3000
        );
      } else if (isReconnect) {
        showToast('Reconnected — canvas is empty (nothing drawn yet)', 'info', 2500);
      }

      break;
    }

    // ── STROKE-COMMITTED: incremental update ───────────────────────────────
    case 'stroke-committed': {
      /**
       * A stroke has been committed by the RAFT cluster.
       *
       * Deduplication:
       *  - If index already in committedStrokes[] → skip (idempotent on reconnect)
       *  - The oldest pending stroke (FIFO) is consumed when a commit arrives,
       *    because it's the stroke we drew locally. This removes the faded
       *    placeholder and replaces it with the authoritative committed copy.
       *  - If no pending → it's another user's stroke, just append and render.
       */
      const stroke = msg.data;

      if (committedStrokes.some(s => s.index === stroke.index)) break;

      if (pendingStrokes.length > 0) {
        pendingStrokes.shift(); // Consume the local faded placeholder (FIFO)
      }

      committedStrokes.push(stroke);
      redrawAll(); // Re-layer so pending correctly stacks above committed
      break;
    }

    // ── PONG: keep-alive reply ─────────────────────────────────────────────
    case 'pong':
      break;

    // ── ERROR: server validation error ────────────────────────────────────
    case 'error':
      console.warn('[WS] Server error:', msg.data?.message);
      showToast(msg.data?.message || 'Server error', 'error');
      break;

    // ── LEADER-CHANGING: failover started (no WS disconnect) ──────────────
    case 'leader-changing':
      console.warn('[WS] Leader changing — election in progress');
      setFailoverIndicator(true);
      showToast('Leader election in progress — strokes are safely queued ⏳', 'warn', 5000);
      break;

    // ── LEADER-RESTORED: new leader elected, queue drained ────────────────
    case 'leader-restored':
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
  stopPing(); // Ensure no duplicate interval
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

// ── Fast reconnect on visibility / network restore ─────────────────────────
/**
 * When the browser tab becomes visible again or the network comes back online,
 * check if the socket is in a bad state and reconnect immediately rather than
 * waiting for the full exponential backoff to fire.
 *
 * This is critical for the scenario: user switches away for 30 s → tab goes
 * idle → socket dies → user switches back → canvas should restore in <1 s.
 */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      console.log('[WS] Tab became visible with dead socket — reconnecting immediately');
      clearTimeout(reconnectTimer);
      reconnectDelay = RECONNECT_MIN; // Reset backoff for user-initiated context switch
      connect();
    }
  }
});

window.addEventListener('online', () => {
  console.log('[WS] Network came online — reconnecting immediately');
  clearTimeout(reconnectTimer);
  reconnectDelay = RECONNECT_MIN;
  connect();
});

// ══════════════════════════════════════════════════════════════════════════════
// UI HELPERS
// ══════════════════════════════════════════════════════════════════════════════

function setStatus(cssClass, text) {
  statusEl.className   = `status ${cssClass}`;
  statusEl.textContent = text;
}

/**
 * Show or hide the failover indicator.
 *
 * isActive=true  → pulsing yellow "Electing…" pill (no canvas overlay —
 *                  canvas stays usable, strokes are queued gateway-side)
 * isActive=false → restore "Connected" pill
 */
function setFailoverIndicator(isActive) {
  if (isActive) {
    setStatus('reconnecting', 'Electing…');
    if (queueDepthEl) {
      queueDepthEl.textContent = 'queued';
      queueDepthEl.classList.remove('hidden');
    }
  } else {
    if (ws && ws.readyState === WebSocket.OPEN) {
      setStatus('connected', 'Connected');
    }
    if (queueDepthEl) {
      queueDepthEl.classList.add('hidden');
    }
  }
}

/**
 * Show the canvas overlay with a primary message and optional subtitle.
 * Uses opacity+pointer-events instead of display:none so the CSS fade plays.
 */
function showOverlay(message, sub = '') {
  overlayMsgEl.textContent = message;
  if (overlaySubEl) overlaySubEl.textContent = sub;
  overlayEl.classList.remove('overlay-hidden');
  overlayEl.removeAttribute('aria-hidden');
}

/**
 * Hide the canvas overlay with a smooth fade.
 */
function hideOverlay() {
  overlayEl.classList.add('overlay-hidden');
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
  toast.className   = `toast toast-${type}`;
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
  const size  = Math.min(brushSize, 22);
  const color = isEraser ? '#aaa' : currentColor;
  brushPreviewEl.style.width      = `${size}px`;
  brushPreviewEl.style.height     = `${size}px`;
  brushPreviewEl.style.background = color;
  brushPreviewEl.style.border     = isEraser ? '1.5px dashed #666' : 'none';
}

// ── Poll Gateway /health for leader info + queue depth ────────────────────────
function startHealthPolling() {
  const HEALTH_URL = `http://${location.hostname}:3000/health`;

  setInterval(async () => {
    try {
      const res  = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(2000) });
      const data = await res.json();

      // Update leader badge (unless failover is in progress — badge will be
      // updated from the leader-restored WS message instead)
      if (!data.failoverActive) {
        updateLeaderBadge(data.leader);
      }

      if (data.clients !== undefined) {
        countValueEl.textContent = data.clients;
      }

      // Sync failover indicator in case we missed the WS push
      if (data.failoverActive) {
        setFailoverIndicator(true);
      } else if (statusEl.classList.contains('reconnecting') && ws && ws.readyState === WebSocket.OPEN) {
        setFailoverIndicator(false);
        updateLeaderBadge(data.leader);
      }

      // Queue depth badge — hidden when queue is empty
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

// Clear button — local canvas only
btnClear.addEventListener('click', () => {
  committedStrokes.length = 0;
  pendingStrokes.length   = 0;
  const cssW = canvas.width  / window.devicePixelRatio;
  const cssH = canvas.height / window.devicePixelRatio;
  ctx.clearRect(0, 0, cssW, cssH);
  showToast('Canvas cleared locally', 'info', 2000);
});

// ══════════════════════════════════════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════════════════════════════════════

resizeCanvas();       // Set correct pixel dimensions + scale immediately
updateBrushPreview(); // Sync brush preview with initial values
connect();            // Open WebSocket to Gateway (triggers full-sync)
startHealthPolling(); // Poll /health every 3 s for leader info + queue depth

console.log('[Frontend] Mini-RAFT Drawing Board initialised');
