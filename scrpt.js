/* ============================================================
   Naruto Shadow Clone Jutsu — gesture-triggered clone effect
   Uses MediaPipe Tasks Vision (HandLandmarker) — the actively
   maintained replacement for the old legacy Holistic solution.
   No trained model needed: the "Ram" seal is detected with a
   landmark-distance heuristic (wrists together, fingertips
   interlocked, hands raised).
   ============================================================ */

import {
  HandLandmarker,
  FilesetResolver,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";

const videoElement = document.getElementById('input_video');
const canvasElement = document.getElementById('output_canvas');
const ctx = canvasElement.getContext('2d');
const statusCard = document.getElementById('statusCard');
const confidenceValueEl = document.getElementById('confidenceValue');
const loadingCard = document.getElementById('loadingCard');
const loadingText = document.getElementById('loadingText');
const resetBtn = document.getElementById('resetBtn');
const cloneCountEl = document.getElementById('cloneCount');

const CANVAS_W = 640;
const CANVAS_H = 480;
canvasElement.width = CANVAS_W;
canvasElement.height = CANVAS_H;

const STREAK_NEEDED = 10;     // consecutive good-scoring frames before triggering
const JUTSU_DURATION = 4500;  // ms clones remain on screen
const SCORE_TRIGGER = 0.8;    // 0-1 score threshold counted as "seal held"

let gestureStreak = 0;
let jutsuActive = false;
let jutsuStartTime = 0;
let cloneSnapshot = null;
let cloneLayout = [];
let smokePuffs = [];
let handLandmarker = null;

/* ---------- gesture scoring ---------- */

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0));
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

// hands is an array of detected hands, each a list of 21 landmarks {x,y,z}
// Landmark indices: 0 = wrist, 4/8/12/16/20 = fingertips
function computeSealScore(hands) {
  if (!hands || hands.length < 2) return 0;

  const left = hands[0];
  const right = hands[1];

  const wristDist = dist(left[0], right[0]);

  const tipIdx = [4, 8, 12, 16, 20];
  let tipTotal = 0;
  tipIdx.forEach((i) => { tipTotal += dist(left[i], right[i]); });
  const avgTipDist = tipTotal / tipIdx.length;

  const leftLift = left[0].y - left[12].y;
  const rightLift = right[0].y - right[12].y;

  const wristScore = clamp01(1 - wristDist / 0.18);
  const tipScore = clamp01(1 - avgTipDist / 0.14);
  const liftScore = clamp01(((leftLift + rightLift) / 2) / 0.12);

  return wristScore * 0.4 + tipScore * 0.4 + liftScore * 0.2;
}

/* ---------- clone spawning ---------- */

function triggerJutsu() {
  jutsuActive = true;
  jutsuStartTime = performance.now();

  const snap = document.createElement('canvas');
  snap.width = CANVAS_W;
  snap.height = CANVAS_H;
  snap.getContext('2d').drawImage(videoElement, 0, 0, CANVAS_W, CANVAS_H);
  cloneSnapshot = snap;

  const positions = [
    { x: -0.30, y: -0.05, scale: 0.55, delay: 0 },
    { x: -0.22, y: 0.12,  scale: 0.50, delay: 90 },
    { x: -0.12, y: 0.24,  scale: 0.45, delay: 160 },
    { x: 0.30,  y: -0.05, scale: 0.55, delay: 40 },
    { x: 0.22,  y: 0.12,  scale: 0.50, delay: 130 },
    { x: 0.12,  y: 0.24,  scale: 0.45, delay: 200 },
  ];

  cloneLayout = positions.map((p) => ({
    x: CANVAS_W / 2 + p.x * CANVAS_W,
    y: CANVAS_H / 2 + p.y * CANVAS_H,
    scale: p.scale,
    delay: p.delay,
    spawned: false,
  }));

  cloneCountEl.textContent = `${cloneLayout.length} clones active`;
}

function resetJutsu() {
  jutsuActive = false;
  cloneSnapshot = null;
  cloneLayout = [];
  smokePuffs = [];
  gestureStreak = 0;
  cloneCountEl.textContent = '0 clones active';
}

resetBtn.addEventListener('click', resetJutsu);

/* ---------- smoke puffs ---------- */

function spawnSmoke(x, y) {
  for (let i = 0; i < 10; i++) {
    smokePuffs.push({
      x: x + (Math.random() - 0.5) * 40,
      y: y + (Math.random() - 0.5) * 40,
      r: 6 + Math.random() * 10,
      vx: (Math.random() - 0.5) * 0.6,
      vy: (Math.random() - 0.5) * 0.6 - 0.3,
      born: performance.now(),
      life: 500 + Math.random() * 300,
    });
  }
}

function drawSmoke(now) {
  smokePuffs = smokePuffs.filter((p) => now - p.born < p.life);
  smokePuffs.forEach((p) => {
    const t = (now - p.born) / p.life;
    p.x += p.vx;
    p.y += p.vy;
    ctx.globalAlpha = (1 - t) * 0.6;
    ctx.fillStyle = '#cfcfcf';
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r * (1 + t * 1.5), 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.globalAlpha = 1;
}

/* ---------- clone rendering ---------- */

function drawClones(now) {
  if (!jutsuActive || !cloneSnapshot) return;

  const elapsed = now - jutsuStartTime;
  if (elapsed > JUTSU_DURATION) {
    resetJutsu();
    return;
  }

  cloneLayout.forEach((c) => {
    if (elapsed < c.delay) return;
    if (!c.spawned) {
      c.spawned = true;
      spawnSmoke(c.x, c.y);
    }
    const localT = elapsed - c.delay;
    const fadeIn = clamp01(localT / 250);
    const w = CANVAS_W * c.scale;
    const h = CANVAS_H * c.scale;

    ctx.save();
    ctx.globalAlpha = 0.85 * fadeIn;
    ctx.drawImage(cloneSnapshot, c.x - w / 2, c.y - h / 2, w, h);
    ctx.restore();
  });
}

/* ---------- setup: model + camera ---------- */

async function setupHandLandmarker() {
  console.log('[setup] loading WASM fileset…');
  loadingText.textContent = 'Loading hand-tracking engine…';
  const vision = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
  );
  console.log('[setup] WASM fileset loaded, loading model…');
  loadingText.textContent = 'Loading hand-tracking model…';

  const modelUrl =
    "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

  try {
    handLandmarker = await HandLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: modelUrl, delegate: "GPU" },
      runningMode: "VIDEO",
      numHands: 2,
    });
    console.log('[setup] model loaded on GPU delegate');
  } catch (gpuErr) {
    console.warn('[setup] GPU delegate failed, retrying on CPU:', gpuErr);
    loadingText.textContent = 'Retrying model on CPU…';
    handLandmarker = await HandLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: modelUrl, delegate: "CPU" },
      runningMode: "VIDEO",
      numHands: 2,
    });
    console.log('[setup] model loaded on CPU delegate');
  }
}

async function setupCamera() {
  console.log('[setup] requesting camera permission…');
  loadingText.textContent = 'Requesting camera access…';
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: CANVAS_W, height: CANVAS_H },
    audio: false,
  });
  console.log('[setup] camera stream acquired');
  videoElement.srcObject = stream;
  await new Promise((resolve) => {
    videoElement.onloadeddata = () => {
      console.log('[setup] video frame data ready');
      resolve();
    };
  });
}

/* ---------- main render loop ---------- */

function renderLoop() {
  const now = performance.now();

  ctx.save();
  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
  ctx.drawImage(videoElement, 0, 0, CANVAS_W, CANVAS_H);

  if (handLandmarker && videoElement.readyState >= 2) {
    const result = handLandmarker.detectForVideo(videoElement, now);
    const hands = result.landmarks || [];

    const score = computeSealScore(hands);
    const confidencePct = Math.round(score * 100);

    statusCard.classList.toggle('hidden', score < 0.15);
    confidenceValueEl.textContent = `${confidencePct}%`;

    if (score > SCORE_TRIGGER) {
      gestureStreak++;
    } else {
      gestureStreak = Math.max(0, gestureStreak - 1);
    }

    if (gestureStreak >= STREAK_NEEDED && !jutsuActive) {
      triggerJutsu();
    }
  }

  drawClones(now);
  drawSmoke(now);
  ctx.restore();

  requestAnimationFrame(renderLoop);
}

/* ---------- bootstrap ---------- */

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms)
    ),
  ]);
}

async function init() {
  try {
    await withTimeout(setupCamera(), 15000, 'Camera setup');
    await withTimeout(setupHandLandmarker(), 20000, 'Model loading');
    loadingCard.style.display = 'none';
    await videoElement.play();
    console.log('[setup] all done, starting render loop');
    renderLoop();
  } catch (err) {
    loadingText.textContent = `Stuck on: ${err.message}`;
    console.error('[setup] failed:', err);
  }
}

init();5
