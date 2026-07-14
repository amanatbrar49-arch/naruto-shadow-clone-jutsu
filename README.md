/* ============================================================
   Naruto Shadow Clone Jutsu — gesture-triggered clone effect
   Uses MediaPipe Holistic for hand landmarks. No trained model
   needed: the "Ram" seal is detected with a landmark-distance
   heuristic (wrists together, fingertips interlocked, hands
   raised), so this works the moment you open the page.
   ============================================================ */

const videoElement = document.getElementById('input_video');
const canvasElement = document.getElementById('output_canvas');
const ctx = canvasElement.getContext('2d');
const statusCard = document.getElementById('statusCard');
const confidenceValueEl = document.getElementById('confidenceValue');
const loadingCard = document.getElementById('loadingCard');
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
let latestFrame = null;

/* ---------- gesture scoring ---------- */

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0));
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

// Landmark indices (MediaPipe hand model): 0 = wrist, 4/8/12/16/20 = fingertips
function computeSealScore(left, right) {
  if (!left || !right) return 0;

  const wristDist = dist(left[0], right[0]);

  const tipIdx = [4, 8, 12, 16, 20];
  let tipTotal = 0;
  tipIdx.forEach((i) => { tipTotal += dist(left[i], right[i]); });
  const avgTipDist = tipTotal / tipIdx.length;

  // How far the middle fingertip is above the wrist (hands raised, fingers up)
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
  snap.getContext('2d').drawImage(latestFrame, 0, 0, CANVAS_W, CANVAS_H);
  cloneSnapshot = snap;

  // Fan-out formation, staggered so clones "pop" in one after another
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

/* ---------- main MediaPipe callback ---------- */

function onResults(results) {
  loadingCard.style.display = 'none';

  ctx.save();
  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
  ctx.drawImage(results.image, 0, 0, CANVAS_W, CANVAS_H);
  latestFrame = results.image;

  const score = computeSealScore(results.leftHandLandmarks, results.rightHandLandmarks);
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

  const now = performance.now();
  drawClones(now);
  drawSmoke(now);

  ctx.restore();
}

/* ---------- bootstrap MediaPipe Holistic + camera ---------- */

const holistic = new Holistic({
  locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/holistic/${file}`,
});

holistic.setOptions({
  modelComplexity: 1,
  smoothLandmarks: true,
  refineFaceLandmarks: false,
  minDetectionConfidence: 0.6,
  minTrackingConfidence: 0.6,
});

holistic.onResults(onResults);

const camera = new Camera(videoElement, {
  onFrame: async () => {
    await holistic.send({ image: videoElement });
  },
  width: CANVAS_W,
  height: CANVAS_H,
});

camera.start().catch((err) => {
  loadingCard.innerHTML = `<p>Camera access failed: ${err.message}. Please allow camera permissions and reload.</p>`;
});
