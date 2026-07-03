/* ============================================================
   SOUPLINGS — networked client: interpolation, input, UI.
   The server owns the simulation; this file renders it.
   ============================================================ */

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
let W = 0, H = 0, DPR = 1;

const $ = id => document.getElementById(id);
const ui = {
  hud: $('hud'), title: $('title'), editor: $('editor'), death: $('death'), win: $('win'),
  specName: $('specName'), genTitle: $('genTitle'),
  hpFill: $('hpFill'), growthFill: $('growthFill'),
  dnaCount: $('dnaCount'), dnaCount2: $('dnaCount2'),
  evolveBtn: $('evolveBtn'), toasts: $('toasts'), hint: $('hint'),
  nameInput: $('nameInput'), rerollBtn: $('rerollBtn'), beginBtn: $('beginBtn'),
  partsGrid: $('partsGrid'), preview: $('preview'), previewCaption: $('previewCaption'),
  resumeBtn: $('resumeBtn'), deathStats: $('deathStats'), winStats: $('winStats'),
  continueBtn: $('continueBtn'), restartBtn: $('restartBtn'), winRestartBtn: $('winRestartBtn'),
  board: $('board'), boardList: $('boardList'), connStatus: $('connStatus'),
  chronicle: $('chronicle'), deathBy: $('deathBy'),
  shareDeathBtn: $('shareDeathBtn'), shareWinBtn: $('shareWinBtn'), controlsNote: $('controlsNote'),
  editorSafety: $('editorSafety')
};

const INTERP_MS = 140;

const Game = {
  state: 'title',            // title | play | editor | dead | win
  world: null,
  puppets: new Map(),        // id -> render puppet
  foodCache: new Map(),      // id -> render food
  mePuppet: null,
  pred: null,                // locally-predicted own cell
  clockOff: undefined,       // client-clock minus server-clock estimate
  inputMode: 'mouse',        // 'mouse' | 'keys' — last input wins
  cam: { x: 0, y: 0, zoom: 1 },
  shake: 0,
  mouse: { x: 0, y: 0 },
  time: 0,
  last: null,
  playT: 0,
  inputT: 0,
  bubbleT: 0,
  boardT: 0
};

/* ============================================================
   setup & connection
   ============================================================ */

function resize(){
  DPR = Math.min(2, window.devicePixelRatio || 1);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = Math.floor(W * DPR);
  canvas.height = Math.floor(H * DPR);
}
window.addEventListener('resize', resize);
if (window.visualViewport) window.visualViewport.addEventListener('resize', resize);
resize();

Net.onWelcome = () => {
  Game.world = new World(Net.radius);
  Game.world.hazards = Net.hazards;
  Game.puppets.clear();
  Game.foodCache.clear();
};

Net.onJoined = m => {
  Game.myName = m.name;
  try { localStorage.setItem('soup_name', m.name); } catch (e) {}
  ui.specName.textContent = m.name;
  ui.previewCaption.textContent = m.name;
  ui.title.classList.add('hidden');
  ui.death.classList.add('hidden');
  ui.win.classList.add('hidden');
  ui.hud.classList.remove('hidden');
  ui.hint.classList.remove('faded');
  Game.state = 'play';
  Game.playT = 0;
  hudCache.dna = -1; hudCache.gen = -1; hudCache.hp = -1; hudCache.gr = -1;
};

Net.onDead = m => {
  if (Game.state === 'editor') closeEditor();
  Game.state = 'dead';
  AudioSys.death();
  const s = m.stats;
  ui.deathBy.textContent = m.by ? `undone by ${m.by}` : '';
  ui.deathStats.textContent =
    `survived ${fmtTime(s.survived)} · generation ${ROMAN[s.gen - 1]} · ` +
    `${s.dnaTotal} DNA gathered · ${s.kills} kills`;
  ui.death.classList.remove('hidden');
};

Net.onAshore = m => {
  if (Game.state === 'editor') closeEditor();
  Game.state = 'win';
  AudioSys.win();
  const s = m.stats;
  const stars = '★'.repeat(Math.min(5, s.lineage || 1));
  ui.winStats.innerHTML =
    `${esc(s.name)} · dynasty <span class="gold">${stars}${(s.lineage || 1) > 5 ? '×' + s.lineage : ''}</span><br>` +
    `${fmtTime(s.survived)} in the soup · ${s.dnaTotal} DNA · ${s.kills} kills · ${s.deaths} setbacks`;
  ui.winRestartBtn.innerHTML = `Continue the dynasty <span>${stars}</span>`;
  ui.win.classList.remove('hidden');
  ui.hud.classList.add('hidden');
};

Net.onBuyok = m => {
  AudioSys.buy();
  const meP = Game.puppets.get(Net.myId);
  if (meP){
    meP.genome.parts[m.key] = m.lvl;
    meP.partsStr = '';           // force stat rebuild on next sample
  }
  refreshEditor();
  hudCache.dna = -1;
};

Net.onStatus = state => {
  Game.connState = state;
  updateConnStatus();
};

/* tutorial nudges: each hint key is shown once ever per device */
const seenHints = new Set();   // fallback when localStorage is unavailable
Net.onHint = m => {
  const key = 'soup_hint_' + (m.key || m.msg);
  try {
    if (localStorage.getItem(key)) return;
    localStorage.setItem(key, '1');
  } catch (e) {
    if (seenHints.has(key)) return;
    seenHints.add(key);
  }
  toast(m.msg, false);
};

function updateConnStatus(){
  if (!ui.connStatus) return;
  let msg, ok = false;
  if (location.protocol === 'file:'){
    msg = 'multiplayer needs the server — run “npm start”, then open http://localhost:8787';
  } else if (Net.connected){
    const n = countDrifters();
    msg = `connected · ${n} drifter${n === 1 ? '' : 's'} adrift`;
    ok = true;
  } else {
    msg = Game.connState === 'lost' ? 'connection lost — reconnecting…' : 'connecting to the soup…';
  }
  ui.connStatus.textContent = msg;
  ui.beginBtn.disabled = !ok;
}

function countDrifters(){
  const s = Net.snaps[Net.snaps.length - 1];
  if (!s) return 0;
  let n = 0;
  for (const c of s.cells) if (c[11] & 4) n++;
  return n;
}

/* ---- the chronicle: all-time world stats on the title screen ---- */
function updateChronicle(){
  const w = Net.world;
  if (!w || !ui.chronicle){ return; }
  const lines = [
    `<div class="chronTitle">the chronicle</div>`,
    `${w.online} adrift now · ${w.joins} specks have lived`,
    `${w.ashore} crawled ashore · ${w.deaths} were reabsorbed`
  ];
  if (w.pvp) lines.push(`${w.pvp} drifters ate each other`);
  if (w.fastest) lines.push(`<span class="rec">fastest emergence — ${esc(w.fastest.name)}, ${fmtTime(w.fastest.s)}</span>`);
  if (w.deadliest && w.deadliest.n > 0) lines.push(`<span class="rec">deadliest — ${esc(w.deadliest.name)}, ${w.deadliest.n} kills</span>`);
  if (w.dynasty && w.dynasty.n > 1) lines.push(`<span class="rec">greatest dynasty — ${esc(w.dynasty.name)}, ${w.dynasty.n} emergences</span>`);
  ui.chronicle.innerHTML = lines.join('<br>');
  ui.chronicle.classList.remove('hidden');
}

/* ---- share cards ---- */
async function shareText(text){
  const payload = `${text}\n${location.origin}`;
  try {
    if (navigator.share){ await navigator.share({ text: payload }); return; }
    throw new Error('no web share');
  } catch (e) {
    try {
      await navigator.clipboard.writeText(payload);
      toast('copied — go spread the spores', true);
    } catch (e2) {
      toast('could not share', false);
    }
  }
}

function shareDeath(){
  const m = Net.lastDead;
  if (!m) return;
  const s = m.stats;
  shareText(`My speck ${s.name} survived ${fmtTime(s.survived)} in SOUPLINGS before being undone by ${m.by || 'the soup'}. Avenge ${s.name}:`);
}

function shareWin(){
  const m = Net.lastAshore;
  if (!m) return;
  const s = m.stats;
  const stars = s.lineage > 1 ? ` My dynasty: ${'★'.repeat(Math.min(5, s.lineage))}.` : '';
  shareText(`${s.name} crawled ashore after ${fmtTime(s.survived)} in the primordial soup${s.kills ? ` (${s.kills} kills)` : ''}.${stars} Evolve faster than me:`);
}

/* ============================================================
   input
   ============================================================ */

/* ---- pointer: mouse steers & clicks dash; touch holds to swim, double-taps to dash ---- */

window.addEventListener('pointermove', e => {
  Game.mouse.x = e.clientX;
  Game.mouse.y = e.clientY;
  Game.inputMode = 'mouse';
});
window.addEventListener('pointerdown', e => {
  /* runtime touch detection — belt for devices the media query misses */
  if (e.pointerType !== 'mouse'){
    ui.hint.textContent = 'hold to swim · double-tap to dash';
  }
}, { capture: true });

let lastTap = 0, lastTapX = 0, lastTapY = 0;
canvas.addEventListener('pointerdown', e => {
  Game.mouse.x = e.clientX;
  Game.mouse.y = e.clientY;
  Game.inputMode = 'mouse';
  if (Game.state !== 'play') return;
  if (e.pointerType === 'mouse'){
    tryDash();
  } else {
    const now = performance.now();
    if (now - lastTap < 320 && dist(e.clientX, e.clientY, lastTapX, lastTapY) < 60) tryDash();
    lastTap = now; lastTapX = e.clientX; lastTapY = e.clientY;
  }
});

/* ---- keyboard: arrows / WASD steer, space dashes ---- */

const Keys = new Set();
const KEY_DIRS = {
  ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0],
  w: [0, -1], s: [0, 1], a: [-1, 0], d: [1, 0]
};

function keyboardDir(){
  let x = 0, y = 0;
  for (const k of Keys){ const v = KEY_DIRS[k]; x += v[0]; y += v[1]; }
  if (!x && !y) return null;
  const m = Math.hypot(x, y);
  return [x / m, y / m];
}

window.addEventListener('keydown', e => {
  if (e.target === ui.nameInput){
    if (e.key === 'Enter') beginFromTitle();
    return;
  }
  if (KEY_DIRS[e.key.length === 1 ? e.key.toLowerCase() : e.key]){
    Keys.add(e.key.length === 1 ? e.key.toLowerCase() : e.key);
    Game.inputMode = 'keys';
    e.preventDefault();
  } else if (e.key === ' '){
    if (Game.state === 'play'){ tryDash(); e.preventDefault(); }
  } else if (e.key === 'e' || e.key === 'E'){
    if (Game.state === 'play') openEditor();
    else if (Game.state === 'editor') closeEditor();
  } else if (e.key === 'Escape'){
    if (Game.state === 'editor') closeEditor();
    $('about').classList.add('hidden');
  } else if (e.key === 'm' || e.key === 'M'){
    if (AudioSys.ctx) toast(AudioSys.toggleMute() ? 'sound off' : 'sound on', false);
  } else if (e.key === 'Enter' && Game.state === 'title'){
    beginFromTitle();
  }
});
window.addEventListener('keyup', e => {
  Keys.delete(e.key.length === 1 ? e.key.toLowerCase() : e.key);
});
window.addEventListener('blur', () => Keys.clear());

function steerTargetFrom(x, y, r){
  if (Game.inputMode === 'keys'){
    const kd = keyboardDir();
    if (kd) return [x + kd[0] * r * 8, y + kd[1] * r * 8, 1];
    return [x, y, 0];   // keys released: coast to a stop, ignore the parked cursor
  }
  const [tx, ty] = screenToWorld(Game.mouse.x, Game.mouse.y);
  const d = dist(x, y, tx, ty);
  return [tx, ty, clamp((d - r * 0.4) / (r * 3), 0, 1)];
}

function steerTarget(){
  const P = Game.pred || Game.mePuppet;
  return steerTargetFrom(P.x, P.y, Game.mePuppet.r);
}

function tryDash(){
  if (!Net.joined || !Game.mePuppet) return;
  const [tx, ty, th] = steerTarget();
  if (Game.pred) Game.pred.dashT = 0.22;   // optimistic — the server echo confirms
  Net.input(tx, ty, Math.max(th, 0.5), true);
}

/* run the same steering math the server runs, on our own cell, every frame —
   then softly reconcile toward the authoritative position. Kills the
   round-trip lag on your own movement. */
function predictSelf(dt){
  const meP = Game.mePuppet;
  if (!meP || !Net.joined || !meP.stats){ Game.pred = null; return; }
  const st = meP.stats;
  let P = Game.pred;
  if (!P) P = Game.pred = { x: meP.x, y: meP.y, vx: meP.vx, vy: meP.vy, dashT: 0 };
  P.dashT = Math.max(0, P.dashT - dt);

  let tx, ty, th;
  if (Game.state === 'editor'){ tx = P.x; ty = P.y; th = 0; }
  else [tx, ty, th] = steerTargetFrom(P.x, P.y, meP.r);

  const dx = tx - P.x, dy = ty - P.y;
  const d = Math.hypot(dx, dy);
  const sp = st.speed * (P.dashT > 0 ? 2.8 : 1) * th;
  const k = st.steerK * (P.dashT > 0 ? 2.2 : 1);
  P.vx = damp(P.vx, d > 1 ? dx / d * sp : 0, k, dt);
  P.vy = damp(P.vy, d > 1 ? dy / d * sp : 0, k, dt);
  P.x += P.vx * dt;
  P.y += P.vy * dt;

  /* pool edge */
  const dd = Math.hypot(P.x, P.y);
  const limit = Net.radius - meP.r * 1.5;
  if (dd > limit && dd > 1){
    const push = (dd - limit) * 12 * dt;
    P.vx -= P.x / dd * push;
    P.vy -= P.y / dd * push;
  }

  /* reconcile toward the server's truth */
  const ex = meP.x - P.x, ey = meP.y - P.y;
  const err = Math.hypot(ex, ey);
  if (err > 200){ P.x = meP.x; P.y = meP.y; P.vx = meP.vx; P.vy = meP.vy; }
  else {
    const g = 1 - Math.exp(-2.5 * dt);
    P.x += ex * g;
    P.y += ey * g;
  }

  /* the puppet renders at the predicted pose */
  meP.x = P.x; meP.y = P.y;
  meP.vx = P.vx; meP.vy = P.vy;
  const spd = Math.hypot(P.vx, P.vy);
  if (spd > 12) meP.dir = angleLerp(meP.dir, Math.atan2(P.vy, P.vx), 1 - Math.exp(-8 * dt));
}

function screenToWorld(sx, sy){
  return [
    (sx - W / 2) / Game.cam.zoom + Game.cam.x,
    (sy - H / 2) / Game.cam.zoom + Game.cam.y
  ];
}

/* ============================================================
   snapshot interpolation
   ============================================================ */

function getPuppet(id){
  let p = Game.puppets.get(id);
  if (!p){
    p = {
      id, x: 0, y: 0, vx: 0, vy: 0, dir: 0, r: 26,
      hp: 1, maxHp: 1, alive: true,
      genome: { parts: {}, hue: 158, carn: false, aggro: false },
      stats: null, partsStr: '', statsR: 0,
      wobbleSeed: rand(0, 100),
      mouthT: 0, biteT: 0, hurtT: 0, dashT: 0, iframes: 0,
      name: null, gen: 0, dnaTotal: 0, isPlayer: false
    };
    Game.puppets.set(id, p);
  }
  return p;
}

function getFoodPuppet(id, e1){
  let f = Game.foodCache.get(id);
  if (!f){
    f = {
      id, type: FOOD_TYPES[e1[1]], x: e1[2], y: e1[3], r: e1[4],
      vx: 0, vy: 0, seed: rand(0, 100), decay: Infinity, dead: false, dna: 0, mass: 0
    };
    Game.foodCache.set(id, f);
  }
  return f;
}

function cellMapOf(s){
  if (!s.cellMap) s.cellMap = new Map(s.cells.map(c => [c[0], c]));
  return s.cellMap;
}
function foodMapOf(s){
  if (!s.foodMap) s.foodMap = new Map(s.food.map(f => [f[0], f]));
  return s.foodMap;
}

function sample(){
  const snaps = Net.snaps;
  Game.mePuppet = null;
  if (!snaps.length || !Game.world) return;

  /* interpolate on the SERVER-time axis: network jitter in arrival times
     stops mattering. Track the smallest observed (receive − server) clock
     offset, drifting slowly upward so it can re-adapt. */
  const newest = snaps[snaps.length - 1];
  const rawOff = newest.rt - newest.ts;
  if (Game.clockOff === undefined) Game.clockOff = rawOff;
  Game.clockOff = Math.min(Game.clockOff + 0.5, rawOff);

  const t = performance.now() - Game.clockOff - INTERP_MS;

  let s0 = snaps[0], s1 = snaps[0];
  for (let i = 0; i < snaps.length - 1; i++){
    if (snaps[i].ts <= t){ s0 = snaps[i]; s1 = snaps[i + 1]; }
  }
  let f = 0, extra = 0;
  if (t >= newest.ts){
    /* buffer ran dry — glide on velocity instead of freezing */
    s0 = s1 = newest;
    extra = Math.min(200, t - newest.ts) / 1000;
  } else if (s1 !== s0){
    f = clamp((t - s0.ts) / (s1.ts - s0.ts || 1), 0, 1);
  }

  /* ---- cells ---- */
  const m0 = cellMapOf(s0);
  const live = [];
  for (const e1 of s1.cells){
    const p = getPuppet(e1[0]);
    const e0 = m0.get(e1[0]) || e1;
    p.x = lerp(e0[1], e1[1], f) + e1[3] * extra;
    p.y = lerp(e0[2], e1[2], f) + e1[4] * extra;
    p.vx = e1[3]; p.vy = e1[4];
    p.dir = angleLerp(e0[5], e1[5], f);
    p.r = lerp(e0[6], e1[6], f);
    const newHp = e1[7];
    if (newHp < p.hp - 0.5){
      p.hurtT = 0.3;
      if (p.id === Net.myId){ AudioSys.hurt(); Game.shake = Math.max(Game.shake, 8); }
    }
    p.hp = newHp;
    p.maxHp = e1[8];
    p.genome.hue = e1[9];
    p.isPlayer = !!(e1[11] & 4);
    if (e1[10] !== p.partsStr || Math.abs(p.r - p.statsR) > 0.5){
      for (let i = 0; i < PART_KEYS.length; i++) p.genome.parts[PART_KEYS[i]] = +e1[10][i] || 0;
      p.stats = deriveStats(p.genome, p.r, p.isPlayer);
      p.partsStr = e1[10];
      p.statsR = p.r;
    }
    if (e1.length > 12){ p.name = e1[12]; p.gen = e1[13]; p.dnaTotal = e1[14]; p.lineage = e1[15] || 0; }
    live.push(p);
    if (p.id === Net.myId) Game.mePuppet = p;
  }
  Game.world.cells = live;

  if (Game.puppets.size > s1.cells.length){
    const ids = cellMapOf(s1);
    for (const id of [...Game.puppets.keys()]) if (!ids.has(id)) Game.puppets.delete(id);
  }

  /* ---- food ---- */
  const fm0 = foodMapOf(s0);
  const foodLive = [];
  for (const e1 of s1.food){
    const fp = getFoodPuppet(e1[0], e1);
    const e0 = fm0.get(e1[0]);
    fp.x = e0 ? lerp(e0[2], e1[2], f) : e1[2];
    fp.y = e0 ? lerp(e0[3], e1[3], f) : e1[3];
    foodLive.push(fp);
  }
  Game.world.food = foodLive;

  if (Game.foodCache.size > s1.food.length){
    const ids = foodMapOf(s1);
    for (const id of [...Game.foodCache.keys()]) if (!ids.has(id)) Game.foodCache.delete(id);
  }
}

/* ============================================================
   world events → local juice
   ============================================================ */

function processEvents(){
  if (!Game.world) { Net.events.length = 0; return; }
  const evs = Net.events.splice(0);
  const world = Game.world;
  for (const ev of evs){
    switch (ev.e){
      case 'eat': {
        const color = ev.ft === 'dna' ? 'rgba(255,220,120,0.9)'
          : ev.ft === 'meat' ? 'rgba(255,160,90,0.8)' : 'rgba(160,255,190,0.8)';
        world.burst(ev.x, ev.y, color, 6, 90, 0.5, 2);
        if (ev.who === Net.myId){
          if (ev.ft === 'dna') AudioSys.dna();
          else if (ev.ft === 'meat') AudioSys.meat();
          else AudioSys.eat();
        }
        break;
      }
      case 'hit': {
        world.burst(ev.x, ev.y, `hsla(${ev.hue},80%,70%,0.8)`, 7, 130, 0.5);
        const att = Game.puppets.get(ev.att);
        if (att) att.biteT = 0.25;
        if (ev.att === Net.myId){ AudioSys.hit(); Game.shake = Math.max(Game.shake, 3); }
        break;
      }
      case 'die': {
        world.burst(ev.x, ev.y, `hsla(${ev.hue},85%,70%,0.9)`, 16, 180, 0.9, 3);
        if (ev.name && ev.who !== Net.myId) toast(`${ev.name} was reabsorbed`, false);
        if (ev.who === Net.myId) world.burst(ev.x, ev.y, 'rgba(125,255,212,0.9)', 40, 300, 1.4, 4);
        break;
      }
      case 'dash': {
        const p = Game.puppets.get(ev.id);
        if (p){
          p.dashT = 0.22;
          const back = p.dir + Math.PI;
          world.burst(
            p.x + Math.cos(back) * p.r, p.y + Math.sin(back) * p.r,
            'rgba(180,255,230,0.8)', 10, 150, 0.5, 2.5
          );
        }
        if (ev.id === Net.myId) AudioSys.dash();
        break;
      }
      case 'molt': {
        world.burst(ev.x, ev.y, 'rgba(125,255,212,0.9)', 30, 260, 1.2, 4);
        if (ev.id === Net.myId){
          AudioSys.molt();
          Game.shake = 10;
          genSplash(ev.gen);
          const unlocked = PART_KEYS.filter(k => (PARTS[k].gen || 1) === ev.gen);
          for (const k of unlocked) toast(`the chamber grows — ${PARTS[k].name} unlocked`, true);
          refreshEditor();
          if (ev.gen === 5) toast('final generation — fill the bar once more to leave the water', true);
        }
        break;
      }
      case 'ink':
        world.inkCloud(ev.x, ev.y);
        break;
      case 'zap': {
        world.burst(ev.x, ev.y, 'rgba(190,225,255,0.95)', 10, 170, 0.4, 2.5);
        if (ev.tgt === Net.myId) AudioSys.zap();
        break;
      }
      case 'ashore':
        toast(`★ ${ev.name} crawled ashore`, true);
        break;
      case 'join':
        toast(`${ev.name} drifts into being`, false);
        break;
      case 'left':
        toast(`${ev.name} drifted away`, false);
        break;
    }
  }
}

/* ============================================================
   update
   ============================================================ */

function update(dt){
  Game.time += dt;

  if (Game.world){
    sample();
    predictSelf(dt);
    processEvents();
    for (const p of Game.puppets.values()){
      p.mouthT = Math.max(0, p.mouthT - dt);
      p.biteT = Math.max(0, p.biteT - dt);
      p.hurtT = Math.max(0, p.hurtT - dt);
      p.dashT = Math.max(0, p.dashT - dt);
    }
    Game.world.update(dt);   // particles + hazard spin (food is overwritten by snapshots)

    Game.bubbleT -= dt;
    if (Game.bubbleT <= 0){
      Game.bubbleT = rand(0.15, 0.4);
      const visR = (Math.max(W, H) / 2) / Game.cam.zoom;
      const fx = Game.mePuppet ? Game.mePuppet.x : Game.cam.x;
      const fy = Game.mePuppet ? Game.mePuppet.y : Game.cam.y;
      Game.world.bubble(fx + rand(-visR, visR), fy + rand(-visR, visR), rand(1, 3) / Math.sqrt(Game.cam.zoom));
    }
  }

  /* input stream to the server */
  if (Net.joined && (Game.state === 'play' || Game.state === 'editor')){
    Game.playT += dt;
    Game.inputT -= dt;
    if (Game.inputT <= 0 && Game.mePuppet){
      Game.inputT = 0.05;
      const meP = Game.mePuppet;
      let tx, ty, th;
      if (Game.state === 'editor'){
        tx = meP.x; ty = meP.y; th = 0;   // coast while mutating
      } else {
        [tx, ty, th] = steerTarget();
      }
      Net.input(tx, ty, th, false);
    }
    if (Game.playT > 12) ui.hint.classList.add('faded');

    /* first time leaving the safe shallows: one warning, ever */
    if (Game.mePuppet && Net.radius &&
        Math.hypot(Game.mePuppet.x, Game.mePuppet.y) > Net.radius * 0.33){
      Net.onHint({ key: 'shallows', msg: 'you have left the shallows — out here, things hunt' });
    }
  }

  updateCamera(dt);
  Game.shake *= Math.exp(-6 * dt);
  updateHUD();

  Game.boardT -= dt;
  if (Game.boardT <= 0){
    Game.boardT = 0.5;
    updateBoard();
    updateEditorSafety();
    if (Game.state === 'title'){ updateConnStatus(); updateChronicle(); }
  }
}

/* ============================================================
   camera, HUD, leaderboard
   ============================================================ */

function updateCamera(dt){
  const meP = Game.mePuppet;
  let tx, ty, tz;
  if (meP && Net.joined){
    tx = meP.x + meP.vx * 0.22;
    ty = meP.y + meP.vy * 0.22;
    tz = H / (meP.r * 26 * (meP.stats ? meP.stats.zoomOut : 1));
  } else {
    tx = Math.cos(Game.time * 0.04) * 420;
    ty = Math.sin(Game.time * 0.03) * 420;
    tz = H / 1500;
  }
  Game.cam.x = damp(Game.cam.x, tx, 3.5, dt);
  Game.cam.y = damp(Game.cam.y, ty, 3.5, dt);
  Game.cam.zoom = damp(Game.cam.zoom, tz, 2.2, dt);
}

const hudCache = { hp: -1, gr: -1, dna: -1, gen: -1, lin: -1 };
function updateHUD(){
  if (!Net.joined) return;
  const meP = Game.mePuppet;
  const me = Net.me;
  if (meP && meP.maxHp > 0){
    const hp = Math.round(clamp(meP.hp / meP.maxHp, 0, 1) * 100);
    if (hp !== hudCache.hp){ ui.hpFill.style.width = hp + '%'; hudCache.hp = hp; }
  }
  const gr = Math.round(clamp(me.growth / me.need, 0, 1) * 100);
  if (gr !== hudCache.gr){ ui.growthFill.style.width = gr + '%'; hudCache.gr = gr; }
  if (me.dna !== hudCache.dna){
    ui.dnaCount.textContent = me.dna;
    ui.dnaCount2.textContent = me.dna;
    hudCache.dna = me.dna;
    const parts = meP ? meP.genome.parts : {};
    const affordable = PART_KEYS.some(k => {
      const cost = partCost(k, parts[k] || 0);
      return cost !== null && cost <= me.dna;
    });
    ui.evolveBtn.classList.toggle('afford', affordable);
  }
  if (me.gen !== hudCache.gen){
    ui.genTitle.innerHTML = ROMAN.map((r, i) =>
      `<span class="gp${i < me.gen ? ' on' : ''}${i === me.gen - 1 ? ' cur' : ''}">${r}</span>`
    ).join('') + `· ${GEN_TITLES[me.gen - 1]}`;
    hudCache.gen = me.gen;
  }
  const lin = meP ? (meP.lineage || 0) : 0;
  if (lin !== hudCache.lin){
    if (hudCache.lin === 0 && lin === 1) toast('a royal organ awaits — Ancestral Helix unlocked', true);
    if (hudCache.lin === 2 && lin === 3) toast('Crown Jelly unlocked — royalty of the soup', true);
    ui.specName.textContent = `${Game.myName || ''} ${'★'.repeat(Math.min(3, lin))}`.trim();
    hudCache.lin = lin;
  }
}

function esc(s){
  return String(s).replace(/[<>&]/g, ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[ch]));
}

function updateBoard(){
  if (!Game.world || !Net.joined){
    ui.board.classList.add('hidden');
    return;
  }
  const players = Game.world.cells.filter(c => c.name);
  if (!players.length){ ui.board.classList.add('hidden'); return; }
  players.sort((a, b) => (b.lineage - a.lineage) || (b.gen - a.gen) || (b.dnaTotal - a.dnaTotal));
  ui.boardList.innerHTML = players.slice(0, 8).map(p =>
    `<li class="${p.id === Net.myId ? 'me' : ''}"><span>${esc(p.name)}${p.lineage ? ' ' + '★'.repeat(Math.min(3, p.lineage)) : ''}</span><span>Gen ${ROMAN[p.gen - 1] || 'I'}</span></li>`
  ).join('');
  ui.board.classList.remove('hidden');
}

function drawCrown(g, x, y, s){
  g.save();
  g.translate(x, y);
  g.fillStyle = 'rgba(255,214,107,0.95)';
  g.shadowColor = 'rgba(255,214,107,0.7)';
  g.shadowBlur = 6;
  g.beginPath();
  g.moveTo(-s, 0);
  g.lineTo(-s, -s * 0.55);
  g.lineTo(-s * 0.45, -s * 0.22);
  g.lineTo(0, -s);
  g.lineTo(s * 0.45, -s * 0.22);
  g.lineTo(s, -s * 0.55);
  g.lineTo(s, 0);
  g.closePath();
  g.fill();
  g.restore();
}

/* full-screen level-up banner */
function genSplash(gen){
  const el = $('genSplash');
  el.querySelector('.gsRoman').textContent = `GEN ${ROMAN[gen - 1]}`;
  el.querySelector('.gsTitle').textContent = GEN_TITLES[gen - 1];
  el.classList.remove('play');
  void el.offsetWidth;   // restart the animation
  el.classList.add('play');
}

function toast(msg, gold){
  const el = document.createElement('div');
  el.className = 'toast' + (gold ? ' gold' : '');
  el.textContent = msg;
  ui.toasts.appendChild(el);
  setTimeout(() => el.remove(), 3900);
}

function fmtTime(s){
  const m = Math.floor(s / 60), ss = Math.floor(s % 60);
  return `${m}:${String(ss).padStart(2, '0')}`;
}

/* ============================================================
   evolution chamber (buys are server-validated)
   ============================================================ */

let previewCell = null;

function myParts(){
  const meP = Game.puppets.get(Net.myId);
  return meP ? meP.genome.parts : {};
}

function buildEditor(){
  for (const key of PART_KEYS){
    const def = PARTS[key];
    const card = document.createElement('div');
    card.className = 'partCard';
    card.dataset.key = key;

    const icon = document.createElement('canvas');
    icon.width = icon.height = 104;
    drawPartIcon(icon.getContext('2d'), key);

    const name = document.createElement('div');
    name.className = 'partName';
    name.innerHTML = `${def.name} <span class="pips"></span>`;

    const desc = document.createElement('div');
    desc.className = 'partDesc';
    desc.textContent = def.desc;

    const btn = document.createElement('button');
    btn.className = 'buyBtn';
    btn.addEventListener('click', () => Net.buy(key));

    card.append(icon, name, btn, desc);
    ui.partsGrid.appendChild(card);
  }
}

function refreshEditor(){
  const parts = myParts();
  const lin = Game.mePuppet ? (Game.mePuppet.lineage || 0) : 0;
  for (const card of ui.partsGrid.children){
    const key = card.dataset.key;
    const def = PARTS[key];
    const lvl = parts[key] || 0;
    const cost = partCost(key, lvl);
    const genLocked = (def.gen || 1) > Net.me.gen;
    const dynLocked = (def.dyn || 0) > lin;
    const locked = genLocked || dynLocked;
    card.classList.toggle('locked', locked);
    card.classList.toggle('royal', !!def.dyn);
    const pips = card.querySelector('.pips');
    pips.innerHTML = Array.from({ length: def.max }, (_, i) =>
      `<span class="${i < lvl ? '' : 'off'}">●</span>`).join('');
    const btn = card.querySelector('.buyBtn');
    if (dynLocked){
      btn.textContent = `dynasty ${'★'.repeat(def.dyn)}`;
      btn.disabled = true;
      btn.classList.remove('maxed');
    } else if (genLocked){
      btn.textContent = `Gen ${ROMAN[(def.gen || 1) - 1]}`;
      btn.disabled = true;
      btn.classList.remove('maxed');
    } else if (cost === null){
      btn.textContent = 'MAX';
      btn.disabled = true;
      btn.classList.add('maxed');
    } else {
      btn.textContent = `${cost} DNA`;
      btn.disabled = cost > Net.me.dna;
      btn.classList.remove('maxed');
    }
  }
  ui.dnaCount2.textContent = Net.me.dna;
}

function openEditor(){
  if (Game.state !== 'play' || !Game.mePuppet) return;
  Game.state = 'editor';
  const meP = Game.mePuppet;
  previewCell = {
    x: 0, y: 0, r: 60, dir: -0.35,
    vx: 26, vy: 0,
    genome: meP.genome,
    stats: deriveStats(meP.genome, 60, true),
    wobbleSeed: meP.wobbleSeed,
    mouthT: 0, biteT: 0, hurtT: 0, iframes: 0, dashT: 0
  };
  refreshEditor();
  ui.editor.classList.remove('hidden');
  Net.send({ t: 'editor', open: true });
}

function closeEditor(){
  ui.editor.classList.add('hidden');
  previewCell = null;
  if (Game.state === 'editor') Game.state = 'play';
  Net.send({ t: 'editor', open: false });
}

function updateEditorSafety(){
  if (Game.state !== 'editor' || !ui.editorSafety) return;
  const cyst = Net.me.cyst || 0;
  ui.editorSafety.textContent = cyst === 2
    ? 'encysted — nothing can harm you while you mutate'
    : 'too agitated to encyst — recently attacked, the soup can still bite';
  ui.editorSafety.classList.toggle('danger', cyst !== 2);
}

function renderPreview(){
  if (!previewCell) return;
  previewCell.stats = deriveStats(previewCell.genome, 60, true);
  const pctx = ui.preview.getContext('2d');
  pctx.setTransform(1, 0, 0, 1, 0, 0);
  pctx.clearRect(0, 0, 360, 360);
  pctx.translate(180, 180 + Math.sin(Game.time * 1.2) * 8);
  previewCell.mouthT = (Math.sin(Game.time * 0.9) > 0.75) ? 0.3 : 0;
  drawCreature(pctx, previewCell, Game.time);
}

/* stylized mint glyphs for the part cards */
function drawPartIcon(g, key){
  g.setTransform(2, 0, 0, 2, 0, 0);
  g.clearRect(0, 0, 52, 52);
  g.strokeStyle = '#7dffd4';
  g.fillStyle = '#7dffd4';
  g.lineWidth = 2.4;
  g.lineCap = 'round';
  const c = 26;
  switch (key){
    case 'flagellum':
      g.beginPath();
      g.moveTo(10, 26);
      g.bezierCurveTo(18, 14, 26, 38, 34, 24);
      g.bezierCurveTo(38, 18, 42, 22, 44, 18);
      g.stroke();
      break;
    case 'cilia':
      g.beginPath(); g.arc(c, c, 11, 0, TAU); g.stroke();
      for (let i = 0; i < 9; i++){
        const a = i / 9 * TAU;
        g.beginPath();
        g.moveTo(c + Math.cos(a) * 11, c + Math.sin(a) * 11);
        g.lineTo(c + Math.cos(a + 0.3) * 17, c + Math.sin(a + 0.3) * 17);
        g.stroke();
      }
      break;
    case 'spike':
      for (let i = 0; i < 3; i++){
        const x = 12 + i * 14;
        g.beginPath();
        g.moveTo(x - 5, 36); g.lineTo(x, 14 + i * 3); g.lineTo(x + 5, 36);
        g.closePath(); g.fill();
      }
      break;
    case 'jaw':
      for (const s of [-1, 1]){
        g.beginPath();
        g.moveTo(14, 26 + s * 4);
        g.quadraticCurveTo(30, 26 + s * 16, 42, 26 + s * 7);
        g.stroke();
      }
      break;
    case 'filter':
      g.beginPath(); g.ellipse(c, c, 15, 10, 0, 0, TAU); g.stroke();
      for (let i = -1; i <= 1; i++){
        g.beginPath();
        g.moveTo(c + i * 7, 18); g.lineTo(c + i * 7, 34);
        g.stroke();
      }
      break;
    case 'eye':
      g.beginPath(); g.ellipse(c, c, 15, 10, 0, 0, TAU); g.stroke();
      g.beginPath(); g.arc(c + 3, c, 4.5, 0, TAU); g.fill();
      break;
    case 'membrane':
      g.beginPath(); g.arc(c, c, 14, 0, TAU); g.stroke();
      g.globalAlpha = 0.45;
      g.beginPath(); g.arc(c, c, 9, 0, TAU); g.stroke();
      g.globalAlpha = 1;
      break;
    case 'gland':
      g.beginPath(); g.arc(c, c, 5, 0, TAU); g.fill();
      for (let i = 0; i < 8; i++){
        const a = i / 8 * TAU;
        g.beginPath();
        g.moveTo(c + Math.cos(a) * 9, c + Math.sin(a) * 9);
        g.lineTo(c + Math.cos(a) * 14, c + Math.sin(a) * 14);
        g.stroke();
      }
      break;
    case 'ink':
      g.beginPath();
      g.moveTo(c, 13);
      g.bezierCurveTo(35, 24, 35, 34, c, 38);
      g.bezierCurveTo(17, 34, 17, 24, c, 13);
      g.closePath();
      g.fill();
      break;
    case 'volt':
      g.beginPath();
      g.moveTo(30, 12); g.lineTo(20, 27); g.lineTo(26, 28); g.lineTo(21, 40); g.lineTo(33, 25); g.lineTo(27, 24);
      g.closePath();
      g.fill();
      break;
    case 'osmo':
      g.beginPath(); g.arc(c, c, 14, 0, TAU); g.stroke();
      g.setLineDash([4, 3]);
      g.beginPath(); g.arc(c, c, 9, 0, TAU); g.stroke();
      g.setLineDash([]);
      g.beginPath(); g.arc(c, c, 3, 0, TAU); g.fill();
      break;
    case 'helix':
      g.strokeStyle = '#ffd66b';
      for (const ph of [0, Math.PI]){
        g.beginPath();
        for (let i = 0; i <= 8; i++){
          const y = 14 + i * 3;
          const x = c + Math.sin(i / 8 * TAU + ph) * 7;
          i ? g.lineTo(x, y) : g.moveTo(x, y);
        }
        g.stroke();
      }
      break;
    case 'jelly':
      g.fillStyle = '#ffd66b';
      g.beginPath();
      g.moveTo(14, 34); g.lineTo(14, 22); g.lineTo(20, 28); g.lineTo(26, 16);
      g.lineTo(32, 28); g.lineTo(38, 22); g.lineTo(38, 34);
      g.closePath();
      g.fill();
      break;
  }
}

/* ============================================================
   render
   ============================================================ */

function render(){
  const t = Game.time;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  Backdrop.draw(ctx, W, H, Game.cam, t);

  const world = Game.world;
  if (world){
    const z = Game.cam.zoom;
    const sx = (Math.random() - 0.5) * Game.shake;
    const sy = (Math.random() - 0.5) * Game.shake;
    ctx.setTransform(DPR * z, 0, 0, DPR * z,
      DPR * (W / 2 + sx - Game.cam.x * z),
      DPR * (H / 2 + sy - Game.cam.y * z));

    world.drawEdge(ctx, t);
    world.drawHazards(ctx, t);
    world.drawFood(ctx, t);

    const sorted = [...world.cells].sort((a, b) => a.r - b.r);
    for (const c of sorted) drawCreature(ctx, c, t);

    world.drawParticles(ctx);

    /* name labels + off-screen human indicators, in screen space */
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.textAlign = 'center';
    for (const c of world.cells){
      if (!c.name) continue;
      const isMe = c.id === Net.myId;
      const label = (isMe ? '' : '◆ ') + c.name +
        (c.lineage ? ' ' + '★'.repeat(Math.min(3, c.lineage)) : '');
      const sx2 = (c.x - Game.cam.x) * z + W / 2;
      const sy2 = (c.y - Game.cam.y) * z + H / 2;

      if (sx2 > -60 && sx2 < W + 60 && sy2 > -60 && sy2 < H + 60){
        let ly = sy2 - c.r * z - 13;
        if (c.lineage){
          /* the crown of an emerged line — visible to everyone */
          drawCrown(ctx, sx2, ly + 2, 9);
          ly -= 15;
        }
        ctx.font = '12px "Fragment Mono", monospace';
        ctx.fillStyle = 'rgba(3,12,18,0.8)';
        ctx.fillText(label, sx2 + 1, ly + 1);
        ctx.fillStyle = isMe ? 'rgba(125,255,212,0.9)' : 'rgba(234,255,245,0.85)';
        ctx.fillText(label, sx2, ly);
      } else if (!isMe){
        /* another human, somewhere out there — point the way */
        const m = 30;
        const cx2 = clamp(sx2, m, W - m), cy2 = clamp(sy2, m, H - m);
        ctx.save();
        ctx.translate(cx2, cy2);
        ctx.rotate(Math.PI / 4);
        ctx.fillStyle = 'rgba(125,255,212,0.85)';
        ctx.fillRect(-5, -5, 10, 10);
        ctx.restore();
        ctx.font = '10px "Fragment Mono", monospace';
        ctx.fillStyle = 'rgba(125,255,212,0.7)';
        ctx.fillText(c.name, clamp(cx2, 80, W - 80), cy2 + (sy2 > cy2 ? -14 : 22));
      }
    }
  }

  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  Backdrop.vignette(ctx, W, H);

  if (Game.state === 'editor') renderPreview();
}

/* ============================================================
   flow & boot
   ============================================================ */

function beginFromTitle(){
  if (!Net.connected || ui.beginBtn.disabled) return;
  AudioSys.init();
  Net.join(ui.nameInput.value.trim());
}

function savedName(){
  try { return localStorage.getItem('soup_name'); } catch (e) { return null; }
}

function backToTitle(){
  ui.death.classList.add('hidden');
  ui.win.classList.add('hidden');
  ui.hud.classList.add('hidden');
  ui.title.classList.remove('hidden');
  ui.nameInput.value = savedName() || randomSpeciesName();
  Game.state = 'title';
  updateConnStatus();
}

ui.rerollBtn.addEventListener('click', () => { ui.nameInput.value = randomSpeciesName(); });
ui.nameInput.addEventListener('click', () => { ui.nameInput.value = randomSpeciesName(); });
$('aboutBtn').addEventListener('click', () => $('about').classList.remove('hidden'));
$('aboutCloseBtn').addEventListener('click', () => $('about').classList.add('hidden'));
ui.beginBtn.addEventListener('click', beginFromTitle);
ui.evolveBtn.addEventListener('click', openEditor);
ui.resumeBtn.addEventListener('click', closeEditor);
ui.continueBtn.addEventListener('click', () => Net.respawn());
ui.restartBtn.addEventListener('click', backToTitle);
ui.winRestartBtn.addEventListener('click', () => Net.respawn());
ui.shareDeathBtn.addEventListener('click', shareDeath);
ui.shareWinBtn.addEventListener('click', shareWin);

document.addEventListener('visibilitychange', () => { Game.last = null; });

/* touch-first copy for touch-first devices */
if (window.matchMedia && matchMedia('(pointer: coarse)').matches){
  ui.hint.textContent = 'hold to swim · double-tap to dash';
  ui.controlsNote.textContent = 'touch to swim · double-tap to dash';
}

ui.nameInput.value = savedName() || randomSpeciesName();
buildEditor();
updateConnStatus();
Net.connect();

function frame(ts){
  if (Game.last === null) Game.last = ts;
  const dt = Math.min(0.05, (ts - Game.last) / 1000);
  Game.last = ts;
  update(dt);
  render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
