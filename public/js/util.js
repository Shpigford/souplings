/* ============================================================
   PRIMORDIA — util: math helpers & glow sprite cache
   ============================================================ */

const TAU = Math.PI * 2;

function clamp(v, a, b){ return v < a ? a : (v > b ? b : v); }
function lerp(a, b, t){ return a + (b - a) * t; }
function rand(a, b){ return a + Math.random() * (b - a); }
function randInt(a, b){ return Math.floor(rand(a, b + 1)); }
function pick(arr){ return arr[Math.floor(Math.random() * arr.length)]; }
function dist(x1, y1, x2, y2){ const dx = x2 - x1, dy = y2 - y1; return Math.hypot(dx, dy); }

/* exponential smoothing that is framerate-independent */
function damp(cur, target, k, dt){ return lerp(cur, target, 1 - Math.exp(-k * dt)); }

function angleLerp(a, b, t){
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return a + d * t;
}

/* ---- pre-rendered radial glow sprites (shadowBlur is too slow per-frame) ---- */
const Glow = {
  cache: new Map(),
  get(color){
    let c = this.cache.get(color);
    if (c) return c;
    const S = 128;
    c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(S/2, S/2, 0, S/2, S/2, S/2);
    grad.addColorStop(0, color);
    grad.addColorStop(0.35, color.replace(/[\d.]+\)$/, '0.28)'));
    grad.addColorStop(1, color.replace(/[\d.]+\)$/, '0)'));
    g.fillStyle = grad;
    g.fillRect(0, 0, S, S);
    this.cache.set(color, c);
    return c;
  }
};

/* draw a glow sprite centered at x,y with given radius; expects hsla/rgba color w/ alpha */
function drawGlow(ctx, x, y, r, color, alpha){
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = alpha;
  ctx.drawImage(Glow.get(color), x - r, y - r, r * 2, r * 2);
  ctx.restore();
}

/* smooth closed blob path through a set of points (quadratic through midpoints) */
function blobPath(ctx, pts){
  const n = pts.length;
  ctx.beginPath();
  let mx = (pts[0][0] + pts[n-1][0]) / 2;
  let my = (pts[0][1] + pts[n-1][1]) / 2;
  ctx.moveTo(mx, my);
  for (let i = 0; i < n; i++){
    const p = pts[i], q = pts[(i + 1) % n];
    ctx.quadraticCurveTo(p[0], p[1], (p[0] + q[0]) / 2, (p[1] + q[1]) / 2);
  }
  ctx.closePath();
}
