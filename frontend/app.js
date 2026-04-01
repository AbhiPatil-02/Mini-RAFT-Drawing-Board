/**
 * app.js — Frontend WebSocket client + Canvas drawing logic
 *
 * Responsibilities:
 *  - Connect to Gateway via WebSocket
 *  - Capture mouse/touch events and send stroke data
 *  - Receive committed strokes and render them on canvas
 *  - Handle reconnection with exponential backoff
 *  - Request full-sync on reconnect (type: "full-sync")
 *
 * TODO (Week 2):
 *  - Implement WebSocket connection to ws://localhost:3000
 *  - Implement canvas mouse event handlers (mousedown, mousemove, mouseup)
 *  - Send stroke data: { type: "stroke", data: { points, color, width } }
 *  - Handle incoming messages:
 *      "stroke-committed" → render stroke on canvas
 *      "full-sync"        → clear canvas and render all strokes
 *  - Update #status-indicator class: connected / reconnecting / disconnected
 *
 * TODO (Week 3):
 *  - Implement exponential backoff reconnection
 *  - Request full canvas state on reconnect
 */

const canvas = document.getElementById('drawing-canvas');
const ctx    = canvas.getContext('2d');
const status = document.getElementById('status-indicator');

// ── Canvas resize ────────────────────────────────────────────────────────────
function resizeCanvas() {
  canvas.width  = canvas.offsetWidth;
  canvas.height = canvas.offsetHeight;
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// ── Placeholder: WebSocket setup ─────────────────────────────────────────────
// TODO: Replace with actual Gateway WebSocket URL
// const GATEWAY_WS_URL = `ws://${location.hostname}:3000`;
// let ws;

// function connect() { ... }

console.log('[Frontend] app.js loaded — WebSocket logic pending (Week 2)');
