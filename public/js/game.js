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
  Game.shore = Net.shore || { total: 0, list: [] };
  Game.world.hazards = Net.hazards;
  Game.puppets.clear();
  Game.foodCache.clear();
  Game.pred = null;
  /* reconnected mid-run (deploy, eviction, network blip): the old cell is
     gone — rejoin immediately instead of stranding the player in a
     spectator camera with no working buttons */
  if (!Net.joined && (Game.state === 'play' || Game.state === 'editor' || Game.menuOpen)){
    if (Game.state === 'editor') closeEditor();
    if (Game.menuOpen) closeMenu();
    Game.sweptHope = true;   // the server may still have our run parked
    Net.join(Game.myName || savedName() || randomSpeciesName());
  }
};

Net.onJoined = m => {
  Game.myName = m.name;
  Game.spectateId = 0;
  Clips.start();
  if (Game.sweptHope){
    Game.sweptHope = false;
    Game.camSnap = true;   // don't slew across the world to the new spawn
    if (m.resumed) showBanner('the current parts', 'your run continues');
    else toast('the current swept you away — your line begins anew', false);
  }
  $('currentShift').classList.add('hidden');
  try {
    localStorage.setItem('soup_name', m.name);
    localStorage.setItem('soup_lineage', String(m.lineage || 0));
    if (m.life) localStorage.setItem('soup_life', JSON.stringify(m.life));
    if (m.streak) localStorage.setItem('soup_streak', String(m.streak));
  } catch (e) {}
  if (!Game.tideToasted && Net.world && Net.world.tide){
    Game.tideToasted = true;
    const T = Net.world.tide;
    toast(`\u{1F30A} tide ${T.n} \u00b7 ${T.name} \u2014 ${T.desc}`, false);
  }
  buildHueRow();
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

function statRow(cells){
  return `<div class="statRow">` + cells.map(([v, l, cls]) =>
    `<div class="statCell${cls ? ' ' + cls : ''}"><b>${v}</b><i>${l}</i></div>`).join('') + `</div>`;
}

function dynStrip(stars, facts){
  return `<div class="dynStrip"><div class="dynHead">` +
    (stars ? `<span class="dynStars">${stars}</span>` : '') +
    `<span class="dynT">your dynasty</span></div>` +
    `<div class="dynRow">` + facts.map(([v, l]) => `<span><b>${v}</b> ${l}</span>`).join('') + `</div></div>`;
}

Net.onDead = m => {
  Clips.capture('demise');
  if (Game.state === 'editor') closeEditor();
  if (Game.menuOpen) closeMenu();
  Game.state = 'dead';
  AudioSys.death();
  const s = m.stats;
  let by = m.by || '';
  if (by === 'an urchin'){
    try {
      const n = (+localStorage.getItem('soup_urchin_deaths') || 0) + 1;
      localStorage.setItem('soup_urchin_deaths', String(n));
      if (n >= 2) by = 'an urchin. possibly the same one';
    } catch (e) {}
  }
  Game.spectateId = m.killerId || 0;
  if (m.nemesis && by === m.nemesis) by = `${by} — they are still out there`;
  ui.deathBy.textContent = by ? `undone by ${by}` : '';
  const b = loadBests();
  let newBest = false;
  if (s.survived > (b.survived || 0)){ b.survived = s.survived; newBest = true; }
  if (s.gen > (b.gen || 0)){ b.gen = s.gen; newBest = true; }
  if (s.kills > (b.kills || 0)){ b.kills = s.kills; newBest = true; }
  saveBests(b);
  const L = m.life;
  const lin = cachedLineage();
  const stars = lin ? (lin > 5 ? `★×${lin}` : '★'.repeat(lin)) : '';
  Game.lastArtifact = { gen: s.gen, survived: s.survived, kills: s.kills, ashore: false };
  ui.deathStats.innerHTML =
    statRow([
      [fmtTime(s.survived), 'survived'],
      [ROMAN[s.gen - 1], 'generation'],
      [s.dnaTotal, 'dna', 'gold'],
      [s.kills, 'kills']
    ]) +
    (L ? dynStrip(stars, [
      [L.runs, `speck${L.runs === 1 ? '' : 's'} lived`],
      [fmtLong(L.time), 'in the soup'],
      [L.dna, 'DNA'],
      [L.kills, 'kills']
    ]) : '') +
    `<span class="dim mono">your bests — ${fmtTime(b.survived || 0)} · gen ${ROMAN[(b.gen || 1) - 1]} · ${b.kills || 0} kills</span>` +
    (newBest ? '<span class="bestBadge">new best</span>' : '');
  ui.death.classList.remove('hidden');
  ui.continueBtn.focus();
};

Net.onAshore = m => {
  Clips.capture('emergence');
  if (Game.state === 'editor') closeEditor();
  if (Game.menuOpen) closeMenu();
  Game.state = 'win';
  AudioSys.win();
  const s = m.stats;
  const stars = '★'.repeat(Math.min(5, s.lineage || 1));
  try {
    localStorage.setItem('soup_lineage', String(s.lineage || 1));
    localStorage.removeItem('soup_menu_seen');   // new unlocks: draw the eye again
  } catch (e) {}
  $('menuBtn').classList.add('pulse');
  buildHueRow();
  const b = loadBests();
  const fastest = !b.fastest || s.survived < b.fastest;
  if (fastest) b.fastest = s.survived;
  if (5 > (b.gen || 0)) b.gen = 5;
  if (s.kills > (b.kills || 0)) b.kills = s.kills;
  saveBests(b);
  const L2 = m.life;
  const winStars = (s.lineage || 1) > 5 ? `★×${s.lineage}` : stars;
  Game.lastArtifact = { gen: 5, survived: s.survived, kills: s.kills, ashore: true };
  ui.winStats.innerHTML =
    statRow([
      [fmtTime(s.survived), 'this run'],
      [s.dnaTotal, 'dna', 'gold'],
      [s.kills, 'kills'],
      [s.deaths, 'setbacks']
    ]) +
    (L2 ? dynStrip(winStars, [
      [L2.runs, `speck${L2.runs === 1 ? '' : 's'} lived`],
      [fmtLong(L2.time), 'in the soup'],
      [L2.kills, 'kills']
    ]) : '') +
    `<span class="dim mono">personal fastest — ${fmtTime(b.fastest)}</span>` +
    (fastest ? '<span class="bestBadge">new best</span>' : '');
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

Net.onSellok = m => {
  AudioSys.buy();
  const meP = Game.puppets.get(Net.myId);
  if (meP){
    if (m.lvl > 0) meP.genome.parts[m.key] = m.lvl;
    else delete meP.genome.parts[m.key];
    meP.partsStr = '';
  }
  if (!(m.reab > 0)) Game.reabMode = false;
  refreshEditor();
  hudCache.dna = -1;
};

Net.onStatus = state => {
  Game.connState = state;
  updateConnStatus();
  const midRun = Game.state === 'play' || Game.state === 'editor' || Game.menuOpen;
  $('currentShift').classList.toggle('hidden', !(state === 'lost' && midRun));
};

/* tutorial nudges: each hint key is shown once ever per device */
const seenHints = new Set();   // fallback when localStorage is unavailable
Net.onToast = m => toast(m.msg, false);

Net.onRenamed = m => {
  if (m.name && m.name !== Game.myName){
    Game.myName = m.name;
    try { localStorage.setItem('soup_name', m.name); } catch (e) {}
    ui.specName.textContent = m.name;
    ui.previewCaption.textContent = m.name;
    hudCache.lin = -1;
    toast(`the taxonomists record you as ${m.name}`, false);
  }
};

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

function cachedLife(){
  try { return JSON.parse(localStorage.getItem('soup_life') || 'null'); } catch (e) { return null; }
}

/* the title screen greets a returning dynasty like one */
function updateTitleDynasty(){
  const el = $('dynastyLine');
  if (!el) return;
  const lin = cachedLineage();
  const life = cachedLife();
  if (!lin && !(life && life.runs)){
    el.classList.add('hidden');
    ui.beginBtn.textContent = Game.calledBy ? 'Answer the call' : 'Begin as a speck';
    return;
  }
  const stars = lin ? (lin > 5 ? `★×${lin}` : '★'.repeat(lin)) : '';
  let line = stars ? `${stars} dynasty` : 'a returning drifter';
  if (life && life.runs) line += ` · ${life.runs} speck${life.runs === 1 ? '' : 's'} lived · ${fmtLong(life.time || 0)} in the soup`;
  let stk = 0;
  try { stk = +localStorage.getItem('soup_streak') || 0; } catch (e) {}
  if (stk > 1) line += ` · ${stk}-day streak`;
  el.textContent = line;
  el.classList.remove('hidden');
  ui.beginBtn.textContent = Game.calledBy ? 'Answer the call' : lin ? 'Rejoin the soup' : 'Begin as a speck';
}

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
  if (!w.joins){
    ui.chronicle.innerHTML =
      `<div class="chronTitle">the chronicle</div>` +
      `no specks have lived. no specks have died.<br>the soup is holding its breath.`;
    ui.chronicle.classList.remove('hidden');
    return;
  }
  let html = `<div class="chronTitle">the chronicle</div>`;
  if (w.order){
    const o = w.order;
    const pct = Math.min(100, Math.round(o.n / o.target * 100));
    html += `<div class="orderBox">` +
      `<div class="orderHead"><span>tide order</span><span>${o.done ? 'complete' : `ends in ${o.daysLeft} day${o.daysLeft === 1 ? '' : 's'}`}</span></div>` +
      `<div class="orderText">${o.done ? `the soup prevailed \u2014 ${o.label}` : `${o.label} \u00b7 ${o.n}/${o.target} ${o.unit}`}</div>` +
      `<div class="orderBar"><i style="width:${pct}%"></i></div></div>`;
  }
  if (w.tide) html += `<div class="tideLine">\u{1F30A} tide ${w.tide.n} \u00b7 <b>${w.tide.name}</b> \u2014 ${w.tide.desc}</div>`;
  html += `<div class="counts">${w.online} adrift · ${w.joins} lived · ${w.ashore} ashore · ${w.deaths} reabsorbed${w.pvp ? ` · ${w.pvp} eaten` : ''}</div>`;
  const recs = [];
  if (w.fastest) recs.push(['fastest', `${fmtTime(w.fastest.s)} · ${esc(w.fastest.name)}`]);
  if (w.deadliest && w.deadliest.n > 0) recs.push(['deadliest', `${w.deadliest.n} kills · ${esc(w.deadliest.name)}`]);
  if (w.dynasty && w.dynasty.n > 1) recs.push(['dynasty', `★${w.dynasty.n} · ${esc(w.dynasty.name)}`]);
  if (recs.length){
    html += `<div class="recGrid">` +
      recs.map(([l, v]) => `<span class="lbl">${l}</span><span class="val">${v}</span>`).join('') +
      `</div>`;
  }
  if (w.daily && (w.daily.ashore || w.daily.deaths)){
    html += `<span class="today">today's tide · ${w.daily.ashore} emerged · ${w.daily.deaths} lost</span>`;
    const top = (w.daily.top || []).slice(0, 5);
    if (top.length){
      const meName = Game.myName || savedName();
      html += `<div class="todayBoard">` + top.map((r, i) =>
        `<span class="tbR">${i + 1}</span><span class="tbT">${fmtTime(r.s)}</span>` +
        `<span class="tbN${r.name === meName ? ' me' : ''}">${esc(r.name)}</span>`).join('') + `</div>`;
    }
  }
  ui.chronicle.innerHTML = html;
  ui.chronicle.classList.remove('hidden');
  const mc = $('menuChronicle');
  if (mc){ mc.innerHTML = html; mc.classList.remove('hidden'); }
}

/* ---- share cards ---- */
async function shareText(text){
  markShared();
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
  shareWithCard('death',
    `survived ${fmtTime(s.survived)} · gen ${ROMAN[s.gen - 1]} · ${s.kills} kills`,
    `My speck ${s.name} survived ${fmtTime(s.survived)} in SOUPLINGS before being undone by ${m.by || 'the soup'}. Avenge ${s.name}:`);
}

function shareWin(){
  const m = Net.lastAshore;
  if (!m) return;
  const s = m.stats;
  const stars = s.lineage > 1 ? ` My dynasty: ${'★'.repeat(Math.min(5, s.lineage))}.` : '';
  shareWithCard('win',
    `${fmtTime(s.survived)} in the soup · ${s.dnaTotal} DNA · dynasty ${'★'.repeat(Math.min(5, s.lineage || 1))}`,
    `${s.name} crawled ashore after ${fmtTime(s.survived)} in the primordial soup${s.kills ? ` (${s.kills} kills)` : ''}.${stars} Evolve faster than me:`);
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

function pokeSelf(p){
  p.pokeT = 0.6;
  p.mouthT = Math.max(p.mouthT, 0.6);
  AudioSys.poke();
  if (Game.world) Game.world.burst(p.x, p.y - p.r, 'rgba(190,235,255,0.5)', 3, 40, 0.4, 1.5);
}

let lastTap = 0, lastTapX = 0, lastTapY = 0;
canvas.addEventListener('pointerdown', e => {
  Game.mouse.x = e.clientX;
  Game.mouse.y = e.clientY;
  Game.inputMode = 'mouse';
  if (Game.state !== 'play') return;
  /* tapping directly on your own speck pokes it instead of dashing */
  const meP = Game.mePuppet;
  if (meP){
    const sx = (meP.x - Game.cam.x) * Game.cam.zoom + W / 2;
    const sy = (meP.y - Game.cam.y) * Game.cam.zoom + H / 2;
    if (dist(e.clientX, e.clientY, sx, sy) < meP.r * Game.cam.zoom + 6){
      pokeSelf(meP);
      return;
    }
  }
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

const KONAMI = ['ArrowUp','ArrowUp','ArrowDown','ArrowDown','ArrowLeft','ArrowRight','ArrowLeft','ArrowRight','b','a'];
let konamiIdx = 0;

window.addEventListener('keydown', e => {
  if (e.target === ui.nameInput){
    if (e.key === 'Enter') beginFromTitle();
    return;
  }
  const kk = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  konamiIdx = kk === KONAMI[konamiIdx] ? konamiIdx + 1 : (kk === KONAMI[0] ? 1 : 0);
  if (konamiIdx === KONAMI.length){
    konamiIdx = 0;
    for (const p of Game.puppets.values()) p.pokeT = 0.8;
    toast('the soup remembers', true);
  }
  if (KEY_DIRS[kk]){
    Keys.add(kk);
    Game.inputMode = 'keys';
    e.preventDefault();
  } else if (e.key === ' '){
    if (Game.state === 'play' && !Game.menuOpen){ tryDash(); e.preventDefault(); }
  } else if (e.key === 'e' || e.key === 'E'){
    if (Game.menuOpen) return;
    if (Game.state === 'play') openEditor();
    else if (Game.state === 'editor') closeEditor();
  } else if (e.key === 'Escape'){
    if (Game.menuOpen) closeMenu();
    else if (Game.state === 'editor') closeEditor();
    else if (Game.state === 'play') openMenu();
  } else if (e.key >= '1' && e.key <= '8' && e.target.tagName !== 'INPUT'){
    if (Game.state === 'play' && !Game.menuOpen) Net.emote(+e.key - 1);
  } else if (e.key === 'm' || e.key === 'M'){
    if (AudioSys.ctx) toast(AudioSys.toggleMute() ? 'the soup falls silent' : 'the soup burbles again', false);
  } else if (e.key === 'Enter'){
    if (Game.state === 'title') beginFromTitle();
    else if (Game.state === 'dead' || Game.state === 'win') Net.respawn();
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
  /* only predict dashes the server will accept — an optimistic boost the
     server rejects (cooldown) diverges the ghost and causes rubber-banding */
  const P = Game.pred;
  if (P && (P.dashCdT || 0) <= 0.05){
    P.dashT = 0.22;
    P.dashCdT = Game.mePuppet.stats ? Game.mePuppet.stats.dashCd : 2.6;
  }
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
  if (!P) P = Game.pred = { x: meP.x, y: meP.y, vx: meP.vx, vy: meP.vy, dashT: 0, dashCdT: 0 };
  P.dashT = Math.max(0, P.dashT - dt);
  P.dashCdT = Math.max(0, (P.dashCdT || 0) - dt);

  let tx, ty, th;
  if (Game.state === 'editor' || Game.menuOpen){ tx = P.x; ty = P.y; th = 0; }
  else [tx, ty, th] = steerTargetFrom(P.x, P.y, meP.r);

  const dx = tx - P.x, dy = ty - P.y;
  const d = Math.hypot(dx, dy);
  const sp = st.speed * (P.dashT > 0 ? 2.8 : 1) * (Net.me.frenzy ? 1.15 : 1) * th;
  const k = st.steerK * (P.dashT > 0 ? 2.2 : 1);
  P.vx = damp(P.vx, d > 1 ? dx / d * sp : 0, k, dt);
  P.vy = damp(P.vy, d > 1 ? dy / d * sp : 0, k, dt);
  if (Net.me.slow){
    /* wading through someone's ink — the server is sludging us too */
    P.vx *= Math.exp(-3 * dt);
    P.vy *= Math.exp(-3 * dt);
  }
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

  /* reconcile toward the server's truth — gently during dash windows,
     where honest divergence is largest and a hard snap reads as a glitch */
  const dashing = P.dashT > 0 || (st.dashCd - P.dashCdT) < 0.7;
  const ex = meP.x - P.x, ey = meP.y - P.y;
  const err = Math.hypot(ex, ey);
  if (err > (dashing ? 420 : 200)){ P.x = meP.x; P.y = meP.y; P.vx = meP.vx; P.vy = meP.vy; }
  else {
    const g = 1 - Math.exp(-(dashing ? 1.1 : 2.5) * dt);
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
      mouthT: 0, biteT: 0, hurtT: 0, dashT: 0, pokeT: 0, iframes: 0,
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
    p.frenzied = !!(e1[11] & 8);
    if (e1[10] !== p.partsStr || Math.abs(p.r - p.statsR) > 0.5){
      for (let i = 0; i < PART_KEYS.length; i++) p.genome.parts[PART_KEYS[i]] = +e1[10][i] || 0;
      p.stats = deriveStats(p.genome, p.r, p.isPlayer);
      p.partsStr = e1[10];
      p.statsR = p.r;
    }
    if (e1.length > 12){ p.name = e1[12]; p.gen = e1[13]; p.dnaTotal = e1[14]; p.lineage = e1[15] || 0; p.trail = e1[16] || 0; p.shape = e1[17] || 0; }
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

  /* vaults: few, static — taken straight from the newest snapshot */
  Game.world.vaults = (s1.vaults || []).map(v =>
    ({ id: v[0], x: v[1], y: v[2], r: v[3], hp: v[4], maxHp: v[5], tier: v[6] }));

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
        if (ev.name && ev.who !== Net.myId && !ev.byName) toast(`${ev.name} was reabsorbed`, false);
        if (ev.who === Net.myId) world.burst(ev.x, ev.y, 'rgba(125,255,212,0.9)', 40, 300, 1.4, 4);
        if (ev.name && ev.byName) killFeedLine(`${ev.byName} devoured ${ev.name}`);
        if (ev.by === Net.myId && ev.name){
          showBanner('DEVOURED', ev.name);
          Clips.capture('kill');
          showClipChip();
          AudioSys.devour();
          Game.punch = 0.88;
        }
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
        if (ev.id === Net.myId){
          AudioSys.dash();
          /* authoritative confirmation — keep the local cooldown mirror honest */
          if (Game.pred && Game.mePuppet && Game.mePuppet.stats){
            Game.pred.dashCdT = Math.max(Game.pred.dashCdT || 0, Game.mePuppet.stats.dashCd - 0.2);
          }
        }
        break;
      }
      case 'molt': {
        world.burst(ev.x, ev.y, 'rgba(125,255,212,0.9)', 30, 260, 1.2, 4);
        if (ev.id === Net.myId){
          AudioSys.molt();
          Game.shake = 10;
          genSplash(ev.gen);
          toast(`your body grows — room for ${capacityFor(ev.gen)} organ levels · +1 reabsorb`, false);
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
      case 'shoreadd': {
        if (Game.shore && ev.mon){
          Game.shore.list.push(ev.mon);
          Game.shore.total++;
          const mx = Math.cos(ev.mon.a) * (Game.world.radius + ev.mon.d);
          const my = Math.sin(ev.mon.a) * (Game.world.radius + ev.mon.d);
          world.burst(mx, my, 'rgba(255,214,107,0.9)', 18, 160, 1.1, 3);
          killFeedLine(`\u{1F33F} ${esc(ev.mon.n)} stands ashore`, true);
        }
        break;
      }
      case 'orderdone': {
        showBanner('THE SOUP PREVAILS', ev.label);
        AudioSys.win && AudioSys.win();
        break;
      }
      case 'emote': {
        const p = Game.puppets.get(ev.id);
        if (p){ p.emoteI = ev.i; p.emoteUntil = performance.now() + 2600; }
        break;
      }
      case 'apex': {
        if (ev.id !== Net.myId){
          toast(`${ev.name} nears the shore — a Sovereign swims among you`, false);
          killFeedLine(`\u{1F451} ${ev.name} \u00b7 Gen V \u00b7 hunt the Sovereign`, true);
        }
        break;
      }
      case 'zap': {
        world.burst(ev.x, ev.y, 'rgba(190,225,255,0.95)', 10, 170, 0.4, 2.5);
        if (ev.tgt === Net.myId) AudioSys.zap();
        break;
      }
      case 'frenzy': {
        const p = Game.puppets.get(ev.id);
        if (p) world.burst(p.x, p.y, 'rgba(255,220,120,0.9)', 14, 160, 0.7, 3);
        if (ev.id === Net.myId){
          AudioSys.frenzy();
          toast('feeding frenzy — DNA counts double while you burn', true);
        }
        break;
      }
      case 'vaultSpawn':
        toast(`a dna vault crusts over in the deep ${'★'.repeat(ev.tier || 1)}`, true);
        break;
      case 'vhit': {
        world.burst(ev.x, ev.y, 'rgba(255,232,150,0.9)', 5, 110, 0.35, 2);
        if (ev.who === Net.myId && AudioSys.ctx) AudioSys.crack();
        break;
      }
      case 'vbreak': {
        world.burst(ev.x, ev.y, 'rgba(255,214,107,0.95)', 30, 260, 1.1, 3.5);
        if (ev.id === Net.myId){
          showBanner('CRACKED', `+${ev.cut} DNA and the hoard spills out`);
          AudioSys.gold();
          Game.punch = 0.9;
        } else if (ev.name){
          toast(`${ev.name} cracked a dna vault`, true);
        }
        break;
      }
      case 'goldSpawn':
        toast('a golden mote glimmers somewhere in the soup', true);
        if (AudioSys.ctx) AudioSys.gold();
        break;
      case 'goldgone':
        if (ev.id === Net.myId){
          showBanner('+60 DNA', 'the golden mote is yours');
          AudioSys.gold();
        } else if (ev.name){
          toast(`${ev.name} devoured the golden mote`, true);
        }
        break;
      case 'vengeance': {
        killFeedLine(`⚔ ${ev.a} repaid ${ev.t}`, true);
        toast(`⚔ ${ev.a} repaid ${ev.t}`, true);
        if (ev.id === Net.myId){
          showBanner('VENGEANCE', `${ev.t} has answered for it`);
          AudioSys.devour();
          Game.punch = 0.88;
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
    predictSelf(dt);
    processEvents();
    for (const p of Game.puppets.values()){
      p.mouthT = Math.max(0, p.mouthT - dt);
      p.biteT = Math.max(0, p.biteT - dt);
      p.hurtT = Math.max(0, p.hurtT - dt);
      p.dashT = Math.max(0, p.dashT - dt);
      p.pokeT = Math.max(0, (p.pokeT || 0) - dt);
      /* earned wake trails, visible to everyone */
      if (p.trail && Math.hypot(p.vx, p.vy) > 70){
        p.trailT = (p.trailT || 0) + dt;
        if (p.trailT > 0.09){
          p.trailT = 0;
          const bx = p.x - Math.cos(p.dir) * p.r;
          const by = p.y - Math.sin(p.dir) * p.r;
          if (p.trail === 1) Game.world.bubble(bx, by, rand(1.5, 3));
          else if (p.trail === 2) Game.world.particles.push({
            x: bx, y: by, vx: rand(-12, 12), vy: rand(-12, 12),
            life: rand(0.4, 0.8), maxLife: 0.8, r: rand(1.5, 2.6),
            color: 'rgba(255,214,107,0.8)', rise: 0
          });
          else if (p.trail === 3) Game.world.particles.push({
            x: bx, y: by, vx: rand(-8, 8), vy: rand(-8, 8),
            life: rand(0.6, 1.1), maxLife: 1.1, r: rand(5, 10),
            color: 'rgba(6,10,18,0.75)', rise: 0, dark: true
          });
        }
      }
    }
    Game.world.update(dt);   // particles + hazard spin (food is overwritten by snapshots)
    if (Game.clockOff !== undefined){
      Game.world.updateHazardOrbits((performance.now() - Game.clockOff) / 1000);
    }

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
      if (Game.state === 'editor' || Game.menuOpen){
        tx = meP.x; ty = meP.y; th = 0;   // coast while mutating or paused
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

  /* stranded watchdog: playing but not joined for too long means every
     recovery path failed — return to the title rather than trap the player */
  if ((Game.state === 'play' || Game.state === 'editor') && !Net.joined){
    Game.strandedT = (Game.strandedT || 0) + dt;
    if (Game.strandedT > 8){
      Game.strandedT = 0;
      if (Game.state === 'editor') closeEditor();
      if (Game.menuOpen) closeMenu();
      backToTitle();
    }
  } else {
    Game.strandedT = 0;
  }

  /* low-health heartbeat */
  const meHp = Game.mePuppet && Game.mePuppet.maxHp ? Game.mePuppet.hp / Game.mePuppet.maxHp : 1;
  if (Net.joined && meHp < 0.25){
    Game.heartT = (Game.heartT || 0) - dt;
    if (Game.heartT <= 0){
      Game.heartT = 0.85;
      if (AudioSys.ctx) AudioSys.heart();
    }
  } else {
    Game.heartT = 0.2;
  }

  updateCamera(dt);
  Game.shake *= Math.exp(-6 * dt);
  updateHUD();

  Game.boardT -= dt;
  if (Game.boardT <= 0){
    Game.boardT = 0.5;
    updateBoard();
    updateEditorSafety();
    cacheOwnGenome();
    if (Game.state === 'title' || Game.menuOpen){ updateConnStatus(); updateChronicle(); }
  }
}

/* ============================================================
   camera, HUD, leaderboard
   ============================================================ */

function updateCamera(dt){
  const meP = Game.mePuppet;
  let tx, ty, tz;
  const killer = Game.state === 'dead' && Game.spectateId ? Game.puppets.get(Game.spectateId) : null;
  if (meP && Net.joined){
    tx = meP.x + meP.vx * 0.22;
    ty = meP.y + meP.vy * 0.22;
    tz = H / (meP.r * 26 * (meP.stats ? meP.stats.zoomOut : 1));
  } else if (killer && Game.world && Game.world.cells.includes(killer)){
    /* watch your killer swim away, fat with your DNA */
    tx = killer.x;
    ty = killer.y;
    tz = H / (killer.r * 30);
  } else if (Game.state === 'play' || Game.state === 'editor'){
    /* mid-run without a cell (reconnecting): hold still, don't fly away */
    tx = Game.cam.x;
    ty = Game.cam.y;
    tz = Game.cam.zoom;
  } else {
    tx = Math.cos(Game.time * 0.04) * 420;
    ty = Math.sin(Game.time * 0.03) * 420;
    tz = H / 1500;
  }
  Game.punch = damp(Game.punch || 1, 1, 5, dt);
  if (Game.camSnap && meP && Net.joined){
    Game.camSnap = false;
    Game.cam.x = tx; Game.cam.y = ty; Game.cam.zoom = tz;
    return;
  }
  Game.cam.x = damp(Game.cam.x, tx, 3.5, dt);
  Game.cam.y = damp(Game.cam.y, ty, 3.5, dt);
  Game.cam.zoom = damp(Game.cam.zoom, tz * Game.punch, 2.2, dt);
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

/* cache own genome for share cards (the puppet dies before the screen shows) */
function cacheOwnGenome(){
  const meP = Game.mePuppet;
  if (meP) Game.lastOwnGenome = { hue: meP.genome.hue, parts: { ...meP.genome.parts } };
}

/* a proper share image: your creature, your legend, the url */
function buildShareCard(kind, statsLine){
  return new Promise(resolve => {
    const c = document.createElement('canvas');
    c.width = 1200; c.height = 630;
    const g = c.getContext('2d');
    Backdrop.draw(g, 1200, 630, { x: 0, y: 0 }, 2.3);
    const genome = Game.lastOwnGenome || { hue: 158, parts: {} };
    const mock = {
      x: 300, y: 330, r: 150, dir: -0.4,
      vx: 40, vy: 0, genome: { ...genome, carn: false, aggro: false },
      stats: deriveStats(genome, 150, true),
      wobbleSeed: 7, mouthT: 0, biteT: 0, hurtT: 0, iframes: 0, dashT: 0
    };
    drawCreature(g, mock, 2.3);
    g.textAlign = 'left';
    g.font = 'italic 900 84px Fraunces, Georgia, serif';
    g.fillStyle = kind === 'win' ? '#ffd66b' : kind === 'saga' ? '#7dffd4' : '#ff7a5c';
    g.fillText(kind === 'win' ? 'EMERGENCE' : kind === 'saga' ? 'THE SAGA' : 'REABSORBED', 560, 260);
    g.font = 'italic 600 34px Fraunces, Georgia, serif';
    g.fillStyle = '#eafff5';
    const lin = cachedLineage();
    g.fillText(`${Game.myName || 'a speck'} ${lin ? '★'.repeat(Math.min(5, lin)) : ''}`, 562, 320);
    g.font = '20px "Fragment Mono", monospace';
    g.fillStyle = 'rgba(234,255,245,0.75)';
    const lines = Array.isArray(statsLine) ? statsLine : [statsLine || ''];
    lines.forEach((ln, i) => g.fillText(ln, 562, 368 + i * 36));
    g.font = '16px "Fragment Mono", monospace';
    g.fillStyle = 'rgba(125,255,212,0.6)';
    g.fillText('SOUPLINGS.FUN — A MULTIPLAYER TIDE-POOL EVOLUTION', 562, 560);
    Backdrop.vignette(g, 1200, 630);
    c.toBlob(b => resolve(b), 'image/png');
  });
}

function markShared(){
  try {
    if (!localStorage.getItem('soup_shared')){
      localStorage.setItem('soup_shared', '1');
      toast('a secret color surfaces in your palette', true);
      buildHueRow();
    }
  } catch (e) {}
}

async function shareWithCard(kind, statsLine, text){
  markShared();
  try {
    const blob = await buildShareCard(kind, statsLine);
    const file = new File([blob], 'souplings.png', { type: 'image/png' });
    if (blob && navigator.canShare && navigator.canShare({ files: [file] })){
      await navigator.share({ files: [file], text: `${text}\n${location.origin}` });
      return;
    }
  } catch (e) { /* fall through to text */ }
  shareText(text);
}

function updateBoard(){
  if (!Game.world || !Net.joined){
    ui.board.classList.add('hidden');
    return;
  }
  const players = Game.world.cells.filter(c => c.name);
  if (!players.length){ ui.board.classList.add('hidden'); return; }
  players.sort((a, b) => (b.lineage - a.lineage) || (b.gen - a.gen) || (b.dnaTotal - a.dnaTotal));
  document.querySelector('.boardTitle').textContent =
    players.length > 1 ? `drifters · ${players.length} adrift` : 'drifters';
  const starsFor = n => !n ? '' : (n > 3 ? ` ★×${n}` : ' ' + '★'.repeat(n));
  ui.boardList.innerHTML = players.slice(0, 10).map(p =>
    `<li class="${p.id === Net.myId ? 'me' : ''}">` +
    `<span class="bn" style="color:hsl(${Math.round(p.genome.hue)},75%,66%)">${esc(p.name)}<span class="bstar">${starsFor(p.lineage)}</span></span>` +
    `<span class="bg">Gen ${ROMAN[p.gen - 1] || 'I'} · <span class="bdna">${p.dnaTotal || 0}</span></span></li>`
  ).join('');
  const myIdx = players.findIndex(p => p.id === Net.myId);
  $('boardMe').textContent = myIdx >= 0 ? `you — #${myIdx + 1} of ${players.length} adrift` : '';
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

/* full-screen banner: level-ups, devourings, vengeance */
function showBanner(main, sub){
  const el = $('genSplash');
  el.querySelector('.gsRoman').textContent = main;
  el.querySelector('.gsTitle').textContent = sub || '';
  el.classList.remove('play');
  void el.offsetWidth;   // restart the animation
  el.classList.add('play');
}
function genSplash(gen){
  showBanner(`GEN ${ROMAN[gen - 1]}`, GEN_TITLES[gen - 1]);
}

function killFeedLine(text, gold){
  const feed = $('killFeed');
  if (!feed) return;
  const el = document.createElement('div');
  el.className = 'kf';
  if (gold) el.innerHTML = `<span class="gold">${esc(text)}</span>`;
  else el.textContent = text;
  feed.appendChild(el);
  while (feed.children.length > 4) feed.firstChild.remove();
  setTimeout(() => el.remove(), 6200);
}

let lastToastMsg = '', lastToastAt = 0;
function toast(msg, gold){
  /* rapid identical clicks should not stack four copies of the same nudge */
  const now = performance.now();
  if (msg === lastToastMsg && now - lastToastAt < 1500) return;
  lastToastMsg = msg; lastToastAt = now;
  while (ui.toasts.children.length >= 4) ui.toasts.firstChild.remove();
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

/* lifetime totals outgrow M:SS fast */
function fmtLong(s){
  const h = Math.floor(s / 3600);
  return h > 0 ? `${h}h ${Math.floor((s % 3600) / 60)}m` : fmtTime(s);
}

/* ============================================================
   evolution chamber (buys are server-validated)
   ============================================================ */

let previewCell = null;

function myParts(){
  const meP = Game.puppets.get(Net.myId);
  return meP ? meP.genome.parts : {};
}

function makePartCard(key){
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
  btn.addEventListener('click', () => Game.reabMode ? Net.sell(key) : Net.buy(key));

  card.append(icon, name, btn, desc);
  return card;
}

function buildEditor(){
  /* body budget: how much creature you're allowed to be */
  const capRow = document.createElement('div');
  capRow.className = 'capRow';
  capRow.innerHTML =
    `<span class="capLabel mono">body</span>` +
    `<div class="capBar" id="capBar"></div>` +
    `<span class="capText mono" id="capText"></span>` +
    `<button id="reabsorbBtn" class="ghost mono reabBtn" title="shed one organ level for half its cost"></button>`;
  ui.partsGrid.appendChild(capRow);
  capRow.querySelector('#reabsorbBtn').addEventListener('click', () => {
    if (!(Net.me.reab > 0)) return;
    Game.reabMode = !Game.reabMode;
    refreshEditor();
  });

  for (const [sys, keys] of ORGAN_SYSTEMS){
    const group = document.createElement('div');
    group.className = 'sysGroup';
    group.innerHTML = `<div class="sysLabel mono">${sys}</div>`;
    if (sys === 'metabolism'){
      /* the mouth fork: one or the other, never both */
      const fork = document.createElement('div');
      fork.className = 'mouthFork';
      fork.append(makePartCard('jaw'));
      const or = document.createElement('div');
      or.className = 'forkOr mono';
      or.textContent = 'one mouth — choose';
      fork.append(or, makePartCard('filter'));
      group.appendChild(fork);
      for (const key of keys) if (!MOUTH_KEYS.includes(key)) group.appendChild(makePartCard(key));
    } else {
      for (const key of keys) group.appendChild(makePartCard(key));
    }
    ui.partsGrid.appendChild(group);
  }
}

function refreshEditor(){
  const parts = myParts();
  const lin = Game.mePuppet ? (Game.mePuppet.lineage || 0) : 0;
  const used = genomeLevels(parts);
  const cap = capacityFor(Net.me.gen);
  const atCap = used >= cap;
  const reab = Net.me.reab || 0;
  if (!reab) Game.reabMode = false;

  /* capacity bar */
  const bar = $('capBar');
  if (bar){
    bar.innerHTML = Array.from({ length: cap }, (_, i) =>
      `<span class="capSeg${i < used ? ' on' : ''}"></span>`).join('');
    $('capText').textContent = `${used}/${cap}`;
    bar.parentElement.classList.toggle('full', atCap);
    const rb = $('reabsorbBtn');
    rb.textContent = Game.reabMode ? 'done shedding' : `reabsorb${reab ? ' · ' + reab : ''}`;
    rb.disabled = !reab;
    rb.title = reab ? 'shed one organ level for half its cost' : 'molting grants a reabsorb';
    rb.classList.toggle('active', Game.reabMode);
  }
  ui.partsGrid.classList.toggle('reabMode', Game.reabMode);

  for (const card of ui.partsGrid.querySelectorAll('.partCard')){
    const key = card.dataset.key;
    const def = PARTS[key];
    const lvl = parts[key] || 0;
    const cost = partCost(key, lvl);
    const genLocked = (def.gen || 1) > Net.me.gen;
    const dynLocked = (def.dyn || 0) > lin;
    const rival = MOUTH_KEYS.includes(key) ? MOUTH_KEYS.find(k => k !== key) : null;
    const foreclosed = rival && (parts[rival] || 0) > 0;
    const locked = genLocked || dynLocked;
    card.classList.toggle('locked', locked && !Game.reabMode);
    card.classList.toggle('foreclosed', !!foreclosed && !Game.reabMode);
    card.classList.toggle('royal', !!def.dyn);
    card.classList.toggle('owned', lvl > 0);
    const pips = card.querySelector('.pips');
    pips.innerHTML = Array.from({ length: def.max }, (_, i) =>
      `<span class="${i < lvl ? '' : 'off'}">●</span>`).join('');
    const btn = card.querySelector('.buyBtn');
    btn.classList.remove('maxed', 'sell');
    if (Game.reabMode){
      if (lvl > 0){
        btn.textContent = `shed · +${Math.floor(def.cost[lvl - 1] * 0.5)} DNA`;
        btn.disabled = false;
        btn.classList.add('sell');
      } else {
        btn.textContent = '—';
        btn.disabled = true;
      }
    } else if (dynLocked){
      btn.textContent = `dynasty ${'★'.repeat(def.dyn)}`;
      btn.disabled = true;
    } else if (genLocked){
      btn.textContent = `Gen ${ROMAN[(def.gen || 1) - 1]}`;
      btn.disabled = true;
    } else if (foreclosed){
      btn.textContent = 'one mouth';
      btn.disabled = true;
    } else if (cost === null){
      btn.textContent = 'MAX';
      btn.disabled = true;
      btn.classList.add('maxed');
    } else if (atCap){
      btn.textContent = 'no room';
      btn.disabled = true;
    } else {
      btn.textContent = `${cost} DNA`;
      btn.disabled = cost > Net.me.dna;
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
  if (Game.state === 'editor' && ui.editorSafety){
    const cyst = Net.me.cyst || 0;
    ui.editorSafety.textContent = cyst === 2
      ? 'encysted — nothing can harm you while you mutate'
      : 'too agitated to encyst — recently attacked, the soup can still bite';
    ui.editorSafety.classList.toggle('danger', cyst !== 2);
  }
  const ms = $('menuSafety');
  if (ms){
    if (Game.menuOpen && Net.joined){
      const cyst = Net.me.cyst || 0;
      ms.textContent = cyst === 2
        ? 'encysted — you are safe while this menu is open'
        : 'too agitated to encyst — recently attacked, the soup can still bite';
      ms.classList.toggle('danger', cyst !== 2);
    } else {
      ms.textContent = '';
    }
  }
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
    world.drawShore(ctx, t, Game.shore && Game.shore.list, {
      x: Game.cam.x, y: Game.cam.y,
      visR: (Math.max(W, H) / 2) / Game.cam.zoom + 140
    });
    world.drawHazards(ctx, t);
    world.drawVaults(ctx, t, world.vaults);
    world.drawFood(ctx, t);

    const sorted = [...world.cells].sort((a, b) => a.r - b.r);
    for (const c of sorted) drawCreature(ctx, c, t);

    world.drawParticles(ctx);

    /* name labels + off-screen human indicators, in screen space */
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.textAlign = 'center';
    if (Game.shore && Game.shore.list && z > 0.3){
      ctx.font = '10px "Fragment Mono", monospace';
      let drawn = 0;
      for (let mi = Game.shore.list.length - 1; mi >= 0 && drawn < 14; mi--){
        const mn = Game.shore.list[mi];
        const mx = Math.cos(mn.a) * (world.radius + mn.d);
        const my = Math.sin(mn.a) * (world.radius + mn.d);
        const sx3 = (mx - Game.cam.x) * z + W / 2;
        const sy3 = (my - Game.cam.y) * z + H / 2;
        if (sx3 < -40 || sx3 > W + 40 || sy3 < -40 || sy3 > H + 40) continue;
        drawn++;
        ctx.font = '11px "Fragment Mono", monospace';
        ctx.fillStyle = 'rgba(3,12,18,0.7)';
        ctx.fillText(mn.n, sx3 + 1, sy3 - 34 * Math.min(1, z) + 1);
        ctx.fillStyle = 'rgba(214,196,161,0.9)';
        ctx.fillText(mn.n, sx3, sy3 - 34 * Math.min(1, z));
      }
    }
    for (const c of world.cells){
      if (!c.name) continue;
      const isMe = c.id === Net.myId;
      const label = (isMe ? '' : '◆ ') + c.name +
        (c.lineage ? ' ' + '★'.repeat(Math.min(3, c.lineage)) : '');
      const sx2 = (c.x - Game.cam.x) * z + W / 2;
      const sy2 = (c.y - Game.cam.y) * z + H / 2;

      if (sx2 > -60 && sx2 < W + 60 && sy2 > -60 && sy2 < H + 60){
        let ly = sy2 - c.r * z - 13;
        const dt2 = c.lineage ? DYNASTY_TITLES.find(x => c.lineage >= x[0]) : null;
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
        if (c.emoteUntil > performance.now()){
          const alpha = Math.min(1, (c.emoteUntil - performance.now()) / 400);
          const txt = EMOTES[c.emoteI] || '';
          ctx.font = '13px "Fragment Mono", monospace';
          const tw = ctx.measureText(txt).width;
          const bx = sx2, by = ly - (dt2 ? 30 : 17);
          ctx.globalAlpha = alpha;
          ctx.fillStyle = 'rgba(4,18,29,0.88)';
          ctx.strokeStyle = 'rgba(125,255,212,0.5)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.roundRect(bx - tw / 2 - 9, by - 12, tw + 18, 22, 10);
          ctx.fill(); ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(bx - 4, by + 10); ctx.lineTo(bx + 4, by + 10); ctx.lineTo(bx, by + 16);
          ctx.closePath(); ctx.fill();
          ctx.fillStyle = 'rgba(234,255,245,0.95)';
          ctx.fillText(txt, bx, by + 4);
          ctx.globalAlpha = 1;
        }
        if (dt2){
          ctx.font = 'italic 10px Fraunces, Georgia, serif';
          ctx.fillStyle = 'rgba(255,214,107,0.85)';
          ctx.fillText(dt2[1], sx2, ly - 13);
        }
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

  /* red pulse when close to reabsorption */
  const hpFrac = Game.mePuppet && Game.mePuppet.maxHp ? Game.mePuppet.hp / Game.mePuppet.maxHp : 1;
  if (Net.joined && hpFrac < 0.25){
    const a = (0.25 - hpFrac) / 0.25 * (0.35 + 0.2 * Math.sin(t * 5.5));
    const rg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.32, W / 2, H / 2, Math.max(W, H) * 0.72);
    rg.addColorStop(0, 'rgba(255,60,40,0)');
    rg.addColorStop(1, `rgba(255,50,35,${clamp(a, 0, 0.5)})`);
    ctx.fillStyle = rg;
    ctx.fillRect(0, 0, W, H);
  }

  /* vaults call from beyond the screen edge too */
  if (Game.world && Game.world.vaults){
    const z3 = Game.cam.zoom;
    for (const v of Game.world.vaults){
      const sx3 = (v.x - Game.cam.x) * z3 + W / 2;
      const sy3 = (v.y - Game.cam.y) * z3 + H / 2;
      if (sx3 > -30 && sx3 < W + 30 && sy3 > -30 && sy3 < H + 30) continue;
      const m3 = 34;
      const cx3 = clamp(sx3, m3, W - m3), cy3 = clamp(sy3, m3, H - m3);
      ctx.save();
      ctx.translate(cx3, cy3);
      ctx.rotate(Math.PI / 4);
      ctx.strokeStyle = 'rgba(255,214,107,0.85)';
      ctx.lineWidth = 2.5;
      ctx.strokeRect(-6, -6, 12, 12);
      ctx.restore();
      ctx.font = '10px "Fragment Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(255,214,107,0.75)';
      ctx.fillText('dna vault ' + '★'.repeat(v.tier), clamp(cx3, 80, W - 80), cy3 + (sy3 > cy3 ? -14 : 24));
    }
  }

  /* the golden mote calls from beyond the screen edge */
  if (Game.world){
    const z2 = Game.cam.zoom;
    for (const f of Game.world.food){
      if (f.type !== 'gold') continue;
      const sx2 = (f.x - Game.cam.x) * z2 + W / 2;
      const sy2 = (f.y - Game.cam.y) * z2 + H / 2;
      if (sx2 > -30 && sx2 < W + 30 && sy2 > -30 && sy2 < H + 30) continue;
      const m = 34;
      const cx2 = clamp(sx2, m, W - m), cy2 = clamp(sy2, m, H - m);
      const pulse = 0.8 + 0.3 * Math.sin(t * 6);
      ctx.save();
      ctx.translate(cx2, cy2);
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = `rgba(255,214,107,${0.85 * pulse})`;
      ctx.fillRect(-6, -6, 12, 12);
      ctx.restore();
      ctx.font = '10px "Fragment Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(255,214,107,0.8)';
      ctx.fillText('golden mote', clamp(cx2, 80, W - 80), cy2 + (sy2 > cy2 ? -14 : 24));
    }
  }

  if (Game.state === 'editor') renderPreview();
}

/* ============================================================
   flow & boot
   ============================================================ */

function beginFromTitle(){
  if (!Net.connected || ui.beginBtn.disabled) return;
  AudioSys.init();
  Net.join(ui.nameInput.value.trim(), Game.buddyCode);
  Game.buddyCode = null;
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
  updateTitleDynasty();
}

let diceSpin = 0;
function rollName(){
  ui.nameInput.value = randomSpeciesName();
  diceSpin += 180;
  ui.rerollBtn.style.transform = `rotate(${diceSpin}deg)`;
}
ui.rerollBtn.addEventListener('click', rollName);

/* dynasty hue swatches: two free, the rest earned by emergences.
   Server enforces; the cached lineage only drives the UI. */
function cachedLineage(){
  try { return +localStorage.getItem('soup_lineage') || 0; } catch (e) { return 0; }
}
function buildHueRow(){
  const lin = cachedLineage();
  let sel = 158;
  try { sel = +localStorage.getItem('soup_hue') || 158; } catch (e) {}
  for (const id of ['hueRow', 'menuHueRow']){
    const row = $(id);
    if (!row) continue;
    row.innerHTML = '';
    for (const [h, req] of HUE_UNLOCKS){
      const dot = document.createElement('button');
      dot.className = 'hueDot' + (lin < req ? ' locked' : '') + (h === sel ? ' sel' : '');
      dot.style.background = `hsl(${h}, 78%, 58%)`;
      dot.title = lin < req ? `unlocks at dynasty ${'★'.repeat(req)}` : 'dynasty color';
      dot.addEventListener('click', () => {
        if (lin < req){ toast(`that color unlocks at dynasty ${'★'.repeat(req)}`, false); return; }
        try { localStorage.setItem('soup_hue', String(h)); } catch (e) {}
        buildHueRow();
        sendIdent();
      });
      row.appendChild(dot);
    }
    /* the share-surfaced color: one press of any share button reveals it */
    let shared = false;
    try { shared = !!localStorage.getItem('soup_shared'); } catch (e) {}
    const sd = document.createElement('button');
    sd.className = 'hueDot' + (shared ? '' : ' locked') + (sel === 335 ? ' sel' : '');
    sd.style.background = 'hsl(335, 78%, 58%)';
    sd.title = shared ? 'the shared color' : 'share the soup once to surface this color';
    sd.addEventListener('click', () => {
      if (!shared){ toast('share the soup once and this color surfaces', false); return; }
      try { localStorage.setItem('soup_hue', '335'); } catch (e) {}
      buildHueRow();
    });
    row.appendChild(sd);
  }
  buildTrailRow();
}

function buildTrailRow(){
  const lin = cachedLineage();
  let sel = 0;
  try { sel = +localStorage.getItem('soup_trail') || 0; } catch (e) {}
  for (const id of ['trailRow', 'menuTrailRow']){
    const row = $(id);
    if (!row) continue;
    row.innerHTML = '';
    for (const [idx, req] of TRAIL_UNLOCKS){
      const chip = document.createElement('button');
      chip.className = 'trailChip mono' + (lin < req ? ' locked' : '') + (idx === sel ? ' sel' : '');
      chip.textContent = TRAIL_NAMES[idx] + (lin < req ? ` ★${req}` : '');
      chip.title = lin < req ? `wake unlocks at dynasty ★${req}` : 'wake trail';
      chip.addEventListener('click', () => {
        if (lin < req){ toast(`that wake unlocks at dynasty ${'★'.repeat(req)}`, false); return; }
        try { localStorage.setItem('soup_trail', String(idx)); } catch (e) {}
        buildHueRow();
        sendIdent();
      });
      row.appendChild(chip);
    }
  }
  buildShapeRow();
}

function buildShapeRow(){
  const lin = cachedLineage();
  let sel = 0;
  try { sel = +localStorage.getItem('soup_shape') || 0; } catch (e) {}
  for (const id of ['shapeRow', 'menuShapeRow']){
    const row = $(id);
    if (!row) continue;
    row.innerHTML = '';
    for (const [idx, req] of SHAPE_UNLOCKS){
      const chip = document.createElement('button');
      chip.className = 'trailChip mono' + (lin < req ? ' locked' : '') + (idx === sel ? ' sel' : '');
      chip.textContent = SHAPE_NAMES[idx] + (lin < req ? ` ★${req}` : '');
      chip.title = lin < req ? `form unlocks at dynasty ★${req}` : 'body form';
      chip.addEventListener('click', () => {
        if (lin < req){ toast(`that form unlocks at dynasty ${'★'.repeat(req)}`, false); return; }
        try { localStorage.setItem('soup_shape', String(idx)); } catch (e) {}
        buildHueRow();
        sendIdent();
      });
      row.appendChild(chip);
    }
  }
}

/* personal bests, kept on this device */
function loadBests(){
  try { return JSON.parse(localStorage.getItem('soup_bests') || '{}'); } catch (e) { return {}; }
}
function saveBests(b){
  try { localStorage.setItem('soup_bests', JSON.stringify(b)); } catch (e) {}
}

/* ============ replay clips: the game hands you the file ============
   Two staggered recorders, each restarted every 30s, so at any moment
   one of them holds 15-30s of valid, playable footage. */
const Clips = {
  on: false, recs: [null, null], chunks: [[], []], t0: [0, 0], timers: [null, null],
  mime: null, stream: null,
  start(){
    if (this.on || !('MediaRecorder' in window) || !canvas.captureStream) return;
    this.mime = ['video/mp4', 'video/webm;codecs=vp9', 'video/webm']
      .find(m => { try { return MediaRecorder.isTypeSupported(m); } catch (e) { return false; } });
    if (!this.mime) return;
    try { this.stream = canvas.captureStream(24); } catch (e) { return; }
    this.on = true;
    this.cycle(0);
    this.timers[1] = setTimeout(() => { if (this.on) this.cycle(1); }, 15000);
  },
  cycle(i){
    const rec = new MediaRecorder(this.stream, { mimeType: this.mime, videoBitsPerSecond: 2200000 });
    this.chunks[i] = [];
    rec.ondataavailable = e => { if (e.data.size) this.chunks[i].push(e.data); };
    rec.start();
    this.recs[i] = rec;
    this.t0[i] = Date.now();
    clearTimeout(this.timers[i]);
    this.timers[i] = setTimeout(() => {
      if (this.on && this.recs[i] === rec && rec.state === 'recording'){ rec.stop(); this.cycle(i); }
    }, 30000);
  },
  /* freeze the moment the instant it happens — the death/kill lands at
     the END of the clip, and idling on the death screen can't scroll
     the window past it */
  capture(label){
    if (!this.on) return;
    let i = -1, best = -1;
    for (let k = 0; k < 2; k++){
      const r2 = this.recs[k];
      if (!r2 || r2.state !== 'recording') continue;
      const el = Date.now() - this.t0[k];
      if (el > best){ best = el; i = k; }
    }
    if (i < 0) return;
    const rec = this.recs[i];
    clearTimeout(this.timers[i]);
    rec.onstop = () => {
      this.pending = { blob: new Blob(this.chunks[i], { type: this.mime }), label };
      if (this.on) this.cycle(i);
    };
    rec.stop();
  },
  save(label){
    if (!this.on){ toast('clips are not supported in this browser', false); return; }
    const p = this.pending;
    if (!p){ toast('no footage yet', false); return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(p.blob);
    a.download = `souplings-${p.label || label}.${this.mime.includes('mp4') ? 'mp4' : 'webm'}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    toast('clip saved \u2014 post the carnage', true);
    markShared();
  }
};
$('clipDeathBtn').addEventListener('click', () => Clips.save('demise'));
$('clipWinBtn').addEventListener('click', () => Clips.save('emergence'));
$('clipChip').addEventListener('click', () => {
  $('clipChip').classList.add('hidden');
  Clips.save('kill');
});
function showClipChip(){
  if (!Clips.on) return;
  const chip = $('clipChip');
  chip.classList.remove('hidden');
  clearTimeout(chip._t);
  chip._t = setTimeout(() => chip.classList.add('hidden'), 8000);
}

/* the tide card: a text-native run story for the group chat */
function tideCardText(){
  const a = Game.lastArtifact;
  if (!a) return null;
  const T = (Net.world && Net.world.tide) || { n: '?', name: 'unknown waters' };
  const lin = cachedLineage();
  let streak = 0;
  try { streak = +localStorage.getItem('soup_streak') || 0; } catch (e) {}
  const path = Array.from({ length: a.gen }, () => '\u{1F9A0}').join('\u2192')
    + (a.ashore ? '\u2192\u{1F33F}' : '\u2192\u{1F480}');
  const line2 = a.ashore
    ? `${path} ashore in ${fmtTime(a.survived)}`
    : `${path} reabsorbed at gen ${ROMAN[a.gen - 1]} \u00b7 ${fmtTime(a.survived)}`;
  const bits = [];
  if (lin) bits.push(`${lin > 5 ? '\u2605\u00d7' + lin : '\u2605'.repeat(lin)} dynasty`);
  if (a.kills) bits.push(`${a.kills} kill${a.kills === 1 ? '' : 's'}`);
  if (streak > 1) bits.push(`${streak}-day streak`);
  const top = Net.world && Net.world.daily && (Net.world.daily.top || [])[0];
  let dare = '';
  if (top){
    dare = a.ashore && a.survived <= top.s
      ? `today's fastest \u2014 beat ${fmtTime(a.survived)}?\n`
      : `fastest today ${fmtTime(top.s)} \u2014 beat it\n`;
  }
  return `SOUPLINGS \u{1F30A} tide ${T.n} \u00b7 ${T.name}\n${line2}\n` +
    (bits.length ? bits.join(' \u00b7 ') + '\n' : '') + dare + 'souplings.fun';
}

async function shareTideCard(){
  const text = tideCardText();
  if (!text) return;
  try { localStorage.setItem('soup_shared', '1'); } catch (e) {}
  const touch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  if (navigator.share && touch){
    try { await navigator.share({ text }); return; } catch (e) { /* fall through */ }
  }
  try {
    await navigator.clipboard.writeText(text);
    toast('copied \u2014 drop it in the group chat', false);
  } catch (e) { toast('could not copy \u2014 long-press to select', false); }
}
$('tideCardBtn').addEventListener('click', shareTideCard);
$('winTideCardBtn').addEventListener('click', shareTideCard);

/* identity edits save themselves — no apply button */
function sendIdent(){
  if (!Net.joined) return;
  let hue = 158, trail = 0, shape = 0;
  try {
    hue = +localStorage.getItem('soup_hue') || 158;
    trail = +localStorage.getItem('soup_trail') || 0;
    shape = +localStorage.getItem('soup_shape') || 0;
  } catch (e) {}
  const nameEl = $('menuName');
  const name = Game.menuOpen && nameEl.value.trim() ? nameEl.value.trim() : (Game.myName || '');
  Net.ident(name, hue, trail, shape);
}

/* the about card doubles as the pause menu: while open in-game, you encyst */
function menuSafetyFlag(){
  Net.send({ t: 'editor', open: Game.state === 'editor' || !!Game.menuOpen });
}
function openMenu(){
  Game.menuOpen = true;
  try { localStorage.setItem('soup_menu_seen', '1'); } catch (e) {}
  $('menuBtn').classList.remove('pulse');
  $('about').classList.remove('hidden');
  $('identBlock').classList.toggle('hidden', !Net.joined);
  if (Net.joined){
    $('menuName').value = Game.myName || '';
    buildHueRow();
  }
  updateChronicle();
  menuSafetyFlag();
}
function closeMenu(){
  Game.menuOpen = false;
  $('about').classList.add('hidden');
  menuSafetyFlag();
}
$('menuRoll').addEventListener('click', () => {
  $('menuName').value = randomSpeciesName();
  sendIdent();
});
$('menuName').addEventListener('change', sendIdent);
$('menuName').addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });
$('sagaBtn').addEventListener('click', async () => {
  const lin = cachedLineage();
  const life = cachedLife() || { runs: 0, time: 0, dna: 0, kills: 0 };
  const b = loadBests();
  const ep = (DYNASTY_TITLES.find(([n]) => lin >= n) || [])[1];
  const stars = lin ? (lin > 5 ? `\u2605\u00d7${lin}` : '\u2605'.repeat(lin)) : 'unstarred';
  const lines = [
    `${stars} dynasty${ep ? ` \u00b7 ${ep}` : ''}`,
    `${life.runs || 0} specks lived \u00b7 ${fmtLong(life.time || 0)} in the soup`,
    `${life.dna || 0} DNA gathered \u00b7 ${life.kills || 0} kills all-time`
  ];
  if (b.fastest) lines.push(`fastest emergence \u00b7 ${fmtTime(b.fastest)}`);
  await shareWithCard('saga', lines, `the House of ${savedName() || 'a speck'} \u2014 ${stars} in the soup`);
});
$('aboutBtn').addEventListener('click', openMenu);
$('aboutCloseBtn').addEventListener('click', closeMenu);
$('menuBtn').addEventListener('click', openMenu);

/* full reset: dissolve the dynasty, two taps required */
let resetArmed = false;
$('resetBtn').addEventListener('click', () => {
  if (!resetArmed){
    resetArmed = true;
    $('resetBtn').textContent = 'tap again — this dissolves your dynasty forever';
    setTimeout(() => {
      resetArmed = false;
      $('resetBtn').textContent = 'dissolve everything (full reset)';
    }, 4000);
    return;
  }
  try { localStorage.clear(); } catch (e) {}
  location.reload();
});

/* the O in the wordmark is an eye. it blinks. tell no one. */
(function(){
  const eyes = document.querySelectorAll('#title .tilt, .aboutCard .tilt');
  if (!eyes.length) return;
  (function wink(){
    setTimeout(() => {
      eyes.forEach(o => o.classList.add('wink'));
      setTimeout(() => eyes.forEach(o => o.classList.remove('wink')), 140);
      wink();
    }, rand(20000, 40000));
  })();
})();

console.log(
  '%cSOUPLINGS%c\nfield notes from the shallows\n\nyou have peered beneath the membrane.\nnothing down here but soup.',
  'font-family: Georgia, serif; font-style: italic; font-weight: 900; font-size: 28px; color: #7dffd4;',
  'font-family: monospace; font-size: 12px; color: #3f8f77;'
);
ui.beginBtn.addEventListener('click', beginFromTitle);
ui.evolveBtn.addEventListener('click', openEditor);
ui.resumeBtn.addEventListener('click', closeEditor);
ui.continueBtn.addEventListener('click', () => Net.respawn());
ui.restartBtn.addEventListener('click', backToTitle);
ui.winRestartBtn.addEventListener('click', () => Net.respawn());
ui.shareDeathBtn.addEventListener('click', shareDeath);
ui.shareWinBtn.addEventListener('click', shareWin);

document.addEventListener('visibilitychange', () => {
  Game.last = null;
  document.title = document.hidden ? 'the soup simmers on…' : 'SOUPLINGS — a tide-pool evolution';
  if (!document.hidden){
    /* everything that happened while the tab slept is old news —
       don't dump a wall of stale toasts on re-focus */
    Net.events.length = 0;
  }
});

/* touch-first copy for touch-first devices */
if (window.matchMedia && matchMedia('(pointer: coarse)').matches){
  ui.hint.textContent = 'hold to swim · double-tap to dash';
  ui.controlsNote.textContent = 'touch to swim · double-tap to dash';
}

/* saved-state versioning: every localStorage read in this file is already
   defensive (try/catch + defaults), so old saves can never crash new code —
   they just lack fields that default sensibly. This stamp exists so any
   FUTURE breaking change has a hook to migrate or selectively clear. */
const SAVE_V = 1;
(function migrateLocalSave(){
  try {
    const v = +localStorage.getItem('soup_v') || 0;
    if (v < 1){
      /* v0 -> v1: no changes needed; all v0 keys remain valid */
    }
    localStorage.setItem('soup_v', String(SAVE_V));
  } catch (e) {}
})();

/* arrived through a friend's invite link? */
try {
  const qp = new URLSearchParams(location.search);
  const bp = qp.get('buddy');
  if (bp){
    Game.buddyCode = bp;
    Game.calledBy = (qp.get('from') || '').slice(0, 24);
    const avg = qp.get('avenge');
    history.replaceState(null, '', location.pathname);
    toast(Game.calledBy
      ? (avg ? `${Game.calledBy} has fallen — answer the call and avenge them`
             : `${Game.calledBy}'s line calls you — begin to surface beside them`)
      : 'a friend awaits — begin to surface beside them', true);
  }
} catch (e) {}

$('inviteBtn').addEventListener('click', () => { Game.inviteAvenge = false; Net.invite(); });
$('avengeBtn').addEventListener('click', () => { Game.inviteAvenge = true; Net.invite(true); });
Net.onInvite = async m => {
  let link = `${location.origin}/?buddy=${m.code}&from=${encodeURIComponent((m.from || '').slice(0, 24))}`;
  if (Game.inviteAvenge) link += '&avenge=1';
  try {
    await navigator.clipboard.writeText(link);
    toast(Game.inviteAvenge
      ? 'avenge link copied — send it to someone with teeth'
      : 'invite link copied — they will surface beside you', true);
  } catch (e) {
    toast(link, false);
  }
};

ui.nameInput.value = savedName() || randomSpeciesName();
updateTitleDynasty();
try { if (!localStorage.getItem('soup_menu_seen')) $('menuBtn').classList.add('pulse'); } catch (e) {}
buildHueRow();
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
