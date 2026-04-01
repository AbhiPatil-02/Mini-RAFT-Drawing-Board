'use strict';

/**
 * app.js – Mini-RAFT Drawing Board client
 *
 * Responsibilities:
 *  • Manage an HTML5 canvas for freehand drawing
 *  • Connect to the server via Socket.io
 *  • Send drawing strokes to the server (which routes them through RAFT)
 *  • Render strokes committed by the RAFT leader
 *  • Display live RAFT state in the sidebar
 */

// ---------------------------------------------------------------------------
// Canvas setup
// ---------------------------------------------------------------------------

const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d');

function resizeCanvas() {
  const container = document.getElementById('canvas-container');
  // Preserve existing drawing
  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  canvas.width = container.clientWidth;
  canvas.height = container.clientHeight;
  ctx.putImageData(imgData, 0, 0);
}

window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// ---------------------------------------------------------------------------
// Drawing state
// ---------------------------------------------------------------------------

let isDrawing = false;
let currentTool = 'pen';     // 'pen' | 'eraser'
let currentColor = '#1a1a2e';
let currentSize = 4;
let pendingPoints = [];       // Points accumulated for the current stroke

// ---------------------------------------------------------------------------
// Toolbar wiring
// ---------------------------------------------------------------------------

// Tool buttons
document.getElementById('btn-pen').addEventListener('click', () => setTool('pen'));
document.getElementById('btn-eraser').addEventListener('click', () => setTool('eraser'));

function setTool(tool) {
  currentTool = tool;
  document.querySelectorAll('.tool-btn').forEach((b) => b.classList.remove('active'));
  document.getElementById(tool === 'pen' ? 'btn-pen' : 'btn-eraser').classList.add('active');
  canvas.style.cursor = tool === 'eraser' ? 'cell' : 'crosshair';
}

// Colour swatches
document.querySelectorAll('.swatch').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.swatch').forEach((s) => s.classList.remove('active'));
    btn.classList.add('active');
    currentColor = btn.dataset.color;
    document.getElementById('custom-color').value = currentColor;
  });
});

// Custom colour picker
document.getElementById('custom-color').addEventListener('input', (e) => {
  currentColor = e.target.value;
  document.querySelectorAll('.swatch').forEach((s) => s.classList.remove('active'));
});

// Size slider
const sizeSlider = document.getElementById('size-slider');
const sizeLabel = document.getElementById('size-label');
sizeSlider.addEventListener('input', () => {
  currentSize = parseInt(sizeSlider.value, 10);
  sizeLabel.textContent = currentSize;
});

// Clear button
document.getElementById('btn-clear').addEventListener('click', () => {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  socket.emit('draw', { type: 'clear' });
});

// ---------------------------------------------------------------------------
// Canvas pointer events
// ---------------------------------------------------------------------------

function getPos(e) {
  const rect = canvas.getBoundingClientRect();
  const src = e.touches ? e.touches[0] : e;
  return {
    x: src.clientX - rect.left,
    y: src.clientY - rect.top,
  };
}

canvas.addEventListener('pointerdown', (e) => {
  isDrawing = true;
  pendingPoints = [];
  const pos = getPos(e);
  pendingPoints.push(pos);
  ctx.beginPath();
  ctx.moveTo(pos.x, pos.y);
  e.preventDefault();
});

canvas.addEventListener('pointermove', (e) => {
  if (!isDrawing) return;
  const pos = getPos(e);
  pendingPoints.push(pos);

  // Live local drawing for immediate feedback
  drawSegment(
    pendingPoints[pendingPoints.length - 2] || pos,
    pos,
    currentTool === 'eraser' ? '#ffffff' : currentColor,
    currentTool === 'eraser' ? currentSize * 3 : currentSize
  );
  e.preventDefault();
});

canvas.addEventListener('pointerup', (e) => {
  if (!isDrawing) return;
  isDrawing = false;
  if (pendingPoints.length < 2) return;

  // Package the stroke and send to server
  const stroke = {
    type: 'stroke',
    points: pendingPoints,
    color: currentTool === 'eraser' ? '#ffffff' : currentColor,
    size: currentTool === 'eraser' ? currentSize * 3 : currentSize,
  };
  socket.emit('draw', stroke);
  pendingPoints = [];
  e.preventDefault();
});

canvas.addEventListener('pointerleave', () => {
  if (isDrawing) {
    isDrawing = false;
    pendingPoints = [];
  }
});

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

function drawSegment(from, to, color, size) {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = color;
  ctx.lineWidth = size;
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
}

/**
 * Render a complete committed stroke (array of points).
 */
function renderStroke(stroke) {
  if (stroke.type === 'clear') {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }
  if (!stroke.points || stroke.points.length < 2) return;

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = stroke.color;
  ctx.lineWidth = stroke.size;
  ctx.beginPath();
  ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
  for (let i = 1; i < stroke.points.length; i++) {
    ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
  }
  ctx.stroke();
}

// ---------------------------------------------------------------------------
// Socket.io
// ---------------------------------------------------------------------------

const socket = io();

socket.on('connect', () => {
  showToast('Connected to server');
});

socket.on('disconnect', () => {
  showToast('Disconnected from server', true);
  updateRaftBadge({ state: 'follower', id: '?', term: '?', leaderId: '?', logLength: 0, commitIndex: -1 });
});

// Full history for new/reconnecting clients
socket.on('history', (strokes) => {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  strokes.forEach(renderStroke);
});

// A stroke was committed by the RAFT leader and broadcast to all clients
socket.on('stroke', (stroke) => {
  renderStroke(stroke);
});

// RAFT state update from the server
socket.on('raftState', (state) => {
  updateRaftBadge(state);
  updateRaftPanel(state);

  const overlay = document.getElementById('overlay-msg');
  if (state.state === 'leader' || state.leaderId) {
    overlay.classList.add('hidden');
  } else {
    overlay.classList.remove('hidden');
  }
});

socket.on('error', (err) => {
  showToast(err.message || 'Error', true);
});

// ---------------------------------------------------------------------------
// RAFT status UI
// ---------------------------------------------------------------------------

function updateRaftBadge(state) {
  const badge = document.getElementById('raft-badge');
  const icon = document.getElementById('badge-icon');
  const text = document.getElementById('badge-text');

  badge.className = 'badge ' + (state.state || 'follower');

  const icons = { leader: '👑', candidate: '🗳️', follower: '🔵' };
  icon.textContent = icons[state.state] || '🔵';

  const labels = { leader: 'LEADER', candidate: 'CANDIDATE', follower: 'Follower' };
  text.textContent = `${labels[state.state] || 'Follower'} · term ${state.term ?? '?'}`;
}

function updateRaftPanel(state) {
  document.getElementById('r-id').textContent = state.id ?? '–';
  document.getElementById('r-state').textContent = (state.state ?? '–').toUpperCase();
  document.getElementById('r-term').textContent = state.term ?? '–';
  document.getElementById('r-leader').textContent = state.leaderId ?? '–';
  document.getElementById('r-log').textContent = state.logLength ?? 0;
  document.getElementById('r-commit').textContent = state.commitIndex ?? -1;

  // Colour-code the state
  const stateEl = document.getElementById('r-state');
  stateEl.style.color =
    state.state === 'leader'    ? 'var(--leader)'    :
    state.state === 'candidate' ? 'var(--candidate)' :
    'var(--follower)';
}

// ---------------------------------------------------------------------------
// Toast helper
// ---------------------------------------------------------------------------

function showToast(message, isError = false) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = 'toast' + (isError ? ' error' : '');
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}
