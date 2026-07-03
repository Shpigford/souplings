/* ============================================================
   PRIMORDIA — networked client: interpolation, input, UI.
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
  chronicle: $('chronicle'), deathBy: $('deathBy'), dashBtn: $('dashBtn'),
  shareDeathBtn: $('shareDeathBtn'), shareWinBtn: $('shareWinBtn'), controlsNote: $('controlsNote')
};

const INTERP_MS = 120;

const Game = {
  state: 'title',            // title | play | editor | dead | win
  world: null,
  puppets: new Map(),        // id -> render puppet
  foodCache: new Map(),      // id -> render food
  mePuppet: null,
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
resize();

Net.onWelcome = () => {
  Game.world = new World(Net.radius);
  Game.world.hazards = Net.hazards;
  Game.puppets.clear();
  Game.foodCache.clear();
};

Net.onJoined = m => {
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
  ui.winStats.textContent =
    `${s.name} · ${fmtTime(s.survived)} in the soup · ` +
    `${s.dnaTotal} DNA · ${s.kills} kills · ${s.deaths} setbacks`;
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
  shareText(`My speck ${s.name} survived ${fmtTime(s.survived)} in PRIMORDIA before being undone by ${m.by || 'the soup'}. Avenge ${s.name}:`);
}

function shareWin(){
  const m = Net.lastAshore;
  if (!m) return;
  const s = m.stats;
  shareText(`${s.name} crawled ashore after ${fmtTime(s.survived)} in the primordial soup${s.kills ? ` (${s.kills} kills)` : ''}. Evolve faster than me:`);
}

/* ============================================================
   input
   ============================================================ */

/* ---- pointer: mouse steers & clicks dash; touch holds to swim, double-taps to dash ---- */

window.addEventListener('pointermove', e => { Game.mouse.x = e.clientX; Game.mouse.y = e.clientY; });
window.addEventListener('pointerdown', e => {
  /* runtime touch detection — belt for devices the media query misses */
  if (e.pointerType !== 'mouse' && !document.body.classList.contains('touchy')){
    document.body.classList.add('touchy');
    ui.hint.textContent = 'hold to swim · double-tap to dash';
  }
}, { capture: true });

let lastTap = 0, lastTapX = 0, lastTapY = 0;
canvas.addEventListener('pointerdown', e => {
  Game.mouse.x = e.clientX;
  Game.mouse.y = e.clientY;
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
    e.preventDefault();
  } else if (e.key === ' '){
    if (Game.state === 'play'){ tryDash(); e.preventDefault(); }
  } else if (e.key === 'e' || e.key === 'E'){
    if (Game.state === 'play') openEditor();
    else if (Game.state === 'editor') closeEditor();
  } else if (e.key === 'Escape'){
    if (Game.state === 'editor') closeEditor();
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

function steerTarget(){
  const meP = Game.mePuppet;
  const kd = keyboardDir();
  if (kd) return [meP.x + kd[0] * meP.r * 8, meP.y + kd[1] * meP.r * 8, 1];
  const [tx, ty] = screenToWorld(Game.mouse.x, Game.mouse.y);
  const d = dist(meP.x, meP.y, tx, ty);
  return [tx, ty, clamp((d - meP.r * 0.4) / (meP.r * 3), 0, 1)];
}

function tryDash(){
  if (!Net.joined || !Game.mePuppet) return;
  const [tx, ty, th] = steerTarget();
  Net.input(tx, ty, Math.max(th, 0.5), true);
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

  const rt = performance.now() - INTERP_MS;
  let s0 = snaps[0], s1 = snaps[0];
  for (let i = 0; i < snaps.length - 1; i++){
    if (snaps[i].rt <= rt){ s0 = snaps[i]; s1 = snaps[i + 1]; }
  }
  if (rt >= snaps[snaps.length - 1].rt) s0 = s1 = snaps[snaps.length - 1];
  const f = s0 === s1 ? 0 : clamp((rt - s0.rt) / (s1.rt - s0.rt || 1), 0, 1);

  /* ---- cells ---- */
  const m0 = cellMapOf(s0);
  const live = [];
  for (const e1 of s1.cells){
    const p = getPuppet(e1[0]);
    const e0 = m0.get(e1[0]) || e1;
    p.x = lerp(e0[1], e1[1], f);
    p.y = lerp(e0[2], e1[2], f);
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
    if (e1.length > 12){ p.name = e1[12]; p.gen = e1[13]; p.dnaTotal = e1[14]; }
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
          toast(`Generation ${ROMAN[ev.gen - 1]} — ${GEN_TITLES[ev.gen - 1]}`, true);
        }
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
  }

  updateCamera(dt);
  Game.shake *= Math.exp(-6 * dt);
  updateHUD();

  Game.boardT -= dt;
  if (Game.boardT <= 0){
    Game.boardT = 0.5;
    updateBoard();
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

const hudCache = { hp: -1, gr: -1, dna: -1, gen: -1 };
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
    ui.genTitle.textContent = `Generation ${ROMAN[me.gen - 1]} · ${GEN_TITLES[me.gen - 1]}`;
    hudCache.gen = me.gen;
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
  players.sort((a, b) => (b.gen - a.gen) || (b.dnaTotal - a.dnaTotal));
  ui.boardList.innerHTML = players.slice(0, 8).map(p =>
    `<li class="${p.id === Net.myId ? 'me' : ''}"><span>${esc(p.name)}</span><span>Gen ${ROMAN[p.gen - 1] || 'I'}</span></li>`
  ).join('');
  ui.board.classList.remove('hidden');
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
  for (const card of ui.partsGrid.children){
    const key = card.dataset.key;
    const def = PARTS[key];
    const lvl = parts[key] || 0;
    const cost = partCost(key, lvl);
    const pips = card.querySelector('.pips');
    pips.innerHTML = Array.from({ length: def.max }, (_, i) =>
      `<span class="${i < lvl ? '' : 'off'}">●</span>`).join('');
    const btn = card.querySelector('.buyBtn');
    if (cost === null){
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
}

function closeEditor(){
  ui.editor.classList.add('hidden');
  previewCell = null;
  if (Game.state === 'editor') Game.state = 'play';
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

    /* name labels in screen space */
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.font = '11px "Fragment Mono", monospace';
    ctx.textAlign = 'center';
    for (const c of world.cells){
      if (!c.name) continue;
      const lx = (c.x - Game.cam.x) * z + W / 2;
      const ly = (c.y - Game.cam.y) * z + H / 2 - c.r * z - 12;
      ctx.fillStyle = c.id === Net.myId ? 'rgba(125,255,212,0.85)' : 'rgba(234,255,245,0.7)';
      ctx.fillText(c.name, lx, ly);
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

function backToTitle(){
  ui.death.classList.add('hidden');
  ui.win.classList.add('hidden');
  ui.hud.classList.add('hidden');
  ui.title.classList.remove('hidden');
  ui.nameInput.value = randomSpeciesName();
  Game.state = 'title';
  updateConnStatus();
}

ui.rerollBtn.addEventListener('click', () => { ui.nameInput.value = randomSpeciesName(); });
ui.beginBtn.addEventListener('click', beginFromTitle);
ui.evolveBtn.addEventListener('click', openEditor);
ui.resumeBtn.addEventListener('click', closeEditor);
ui.continueBtn.addEventListener('click', () => Net.respawn());
ui.restartBtn.addEventListener('click', backToTitle);
ui.winRestartBtn.addEventListener('click', () => Net.respawn());
ui.shareDeathBtn.addEventListener('click', shareDeath);
ui.shareWinBtn.addEventListener('click', shareWin);
ui.dashBtn.addEventListener('pointerdown', e => { e.preventDefault(); tryDash(); });

document.addEventListener('visibilitychange', () => { Game.last = null; });

/* touch-first copy for touch-first devices */
if (window.matchMedia && matchMedia('(pointer: coarse)').matches){
  ui.hint.textContent = 'hold to swim · double-tap to dash';
  ui.controlsNote.textContent = 'touch to swim · double-tap or button to dash';
}

ui.nameInput.value = randomSpeciesName();
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
