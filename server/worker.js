/* ============================================================
   PRIMORDIA on Cloudflare — Worker entry + Soup Durable Object
   One DO instance holds the one shared soup; clients attach
   over WebSockets and receive 15 Hz world snapshots.
   ============================================================ */

import {
  Cell, World, PARTS, PART_KEYS, FOOD_TYPES,
  randomGenome, partCost, randomSpeciesName, growthNeedFor,
  rand, randInt, pick, clamp, dist, TAU
} from './sim.gen.mjs';

const WORLD_R = 2200;
const FOOD_TARGET = 360;
const PLAYER_HUES = [158, 205, 262, 95, 45, 305, 180, 335, 20, 120];

export default {
  async fetch(req, env){
    const url = new URL(req.url);
    if (url.pathname === '/ws'){
      if (req.headers.get('Upgrade') !== 'websocket'){
        return new Response('expected websocket', { status: 426 });
      }
      return env.SOUP.get(env.SOUP.idFromName('the-one-soup')).fetch(req);
    }
    if (url.pathname === '/' || url.pathname === '/index.html'){
      /* stamp the real origin into og: meta tags so share links unfurl */
      const res = await env.ASSETS.fetch(req);
      const html = await res.text();
      return new Response(html.replaceAll('__ORIGIN__', url.origin), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }
    return env.ASSETS.fetch(req);
  }
};

export class Soup {
  constructor(state, env){
    this.state = state;
    this.debug = env.PRIMORDIA_DEBUG === '1' || env.PRIMORDIA_DEBUG === 'true';
    this.world = new World(WORLD_R);
    this.clients = new Map();   // ws -> client
    this.events = [];
    this.nextId = 1;
    this.tickN = 0;
    this.hueCursor = 0;
    this.timer = null;
    /* the chronicle: persistent all-time world stats */
    this.stats = { joins: 0, deaths: 0, ashore: 0, pvp: 0, fastest: null, deadliest: null };
    state.blockConcurrencyWhile(async () => {
      const saved = await state.storage.get('stats');
      if (saved) this.stats = { ...this.stats, ...saved };
    });
    this.seedWorld();
  }

  saveStats(){
    this.state.storage.put('stats', this.stats);
  }

  worldStats(){
    return { ...this.stats, online: this.alivePlayers().length };
  }

  /* -------------------- connections -------------------- */

  fetch(){
    const pair = new WebSocketPair();
    const [clientEnd, serverEnd] = Object.values(pair);
    this.accept(serverEnd);
    return new Response(null, { status: 101, webSocket: clientEnd });
  }

  accept(ws){
    ws.accept();
    const cl = {
      ws, id: this.nextId++, name: null, cell: null, run: null,
      genome: null, alive: false, ashore: false,
      hue: PLAYER_HUES[this.hueCursor++ % PLAYER_HUES.length],
      input: { tx: 0, ty: 0, th: 0 }
    };
    this.clients.set(ws, cl);
    this.send(cl, { t: 'welcome', id: cl.id, radius: WORLD_R, hazards: this.world.hazards, world: this.worldStats() });

    ws.addEventListener('message', ev => {
      let m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      try { this.handleMessage(cl, m); } catch (e) { console.error('msg error', e); }
    });
    const bye = () => this.dropClient(ws);
    ws.addEventListener('close', bye);
    ws.addEventListener('error', bye);

    if (this.timer == null) this.timer = setInterval(() => this.tick(), 33);
  }

  dropClient(ws){
    const cl = this.clients.get(ws);
    if (!cl) return;
    this.clients.delete(ws);
    if (cl.cell){ cl.cell.alive = false; cl.cell.processed = true; cl.cell = null; }
    if (cl.name){
      this.events.push({ e: 'left', name: cl.name });
      console.log(`[left] ${cl.name} (#${cl.id})`);
    }
    if (this.clients.size === 0 && this.timer != null){
      clearInterval(this.timer);   // let the soup rest (and the DO sleep)
      this.timer = null;
    }
  }

  send(cl, obj){
    try { cl.ws.send(JSON.stringify(obj)); } catch (e) { /* peer gone */ }
  }

  /* -------------------- world seeding -------------------- */

  seedWorld(){
    const w = this.world;
    for (let i = 0; i < FOOD_TARGET; i++){
      const [x, y] = w.randomFoodSpot(0, 0, 0);
      w.spawnFood(Math.random() < 0.5 ? 'mote' : 'algae', x, y);
    }
    for (let i = 0; i < 9; i++) w.spawnHazard(rand(28, 46));
    for (let i = 0; i < 26; i++){
      const a = rand(0, TAU), d = Math.sqrt(Math.random()) * WORLD_R * 0.9;
      this.spawnAICell(Math.cos(a) * d, Math.sin(a) * d);
    }
  }

  spawnAICell(x, y){
    /* the shallows near the center stay gentle; monsters live at the rim */
    const band = Math.hypot(x, y) / WORLD_R;
    const r = band < 0.35 ? rand(13, 24)
      : band < 0.65 ? rand(18, 44)
      : rand(30, 72);
    const genome = randomGenome(Math.min(6, 1 + Math.floor(r / 16)));
    const c = new Cell({ x, y, r, genome });
    c.id = this.nextId++;
    this.world.cells.push(c);
    return c;
  }

  alivePlayers(){
    const out = [];
    for (const cl of this.clients.values()) if (cl.alive && cl.cell) out.push(cl);
    return out;
  }

  safeSpot(r){
    /* small creatures respawn in the gentle center; big ones range wider */
    const reach = clamp(0.3 + (r - 26) / 100, 0.3, 0.7);
    for (let i = 0; i < 20; i++){
      const a = rand(0, TAU), d = Math.sqrt(Math.random()) * WORLD_R * reach;
      const x = Math.cos(a) * d, y = Math.sin(a) * d;
      let ok = true;
      for (const c of this.world.cells){
        if (c.alive && c.genome.aggro && c.r > r * 1.1 && dist(x, y, c.x, c.y) < 600){ ok = false; break; }
      }
      if (ok) for (const h of this.world.hazards){
        if (dist(x, y, h.x, h.y) < 300){ ok = false; break; }
      }
      if (ok) return [x, y];
    }
    return [rand(-300, 300), rand(-300, 300)];
  }

  /* -------------------- game rules -------------------- */

  consume(cell, f){
    f.dead = true;
    const herb = f.type === 'algae' || f.type === 'mote';
    const cl = cell.client;
    cell.mouthT = 0.35;
    if (cl){
      const run = cl.run, st = cell.stats;
      run.growth += f.mass * (herb ? st.algaeMul : st.meatMul);
      run.dna += f.dna;
      run.dnaTotal += f.dna;
      run.eaten++;
      cell.r = run.baseR * (1 + 0.16 * clamp(run.growth / run.need, 0, 1));
      cell.recalc();
    }
    this.events.push({ e: 'eat', x: Math.round(f.x), y: Math.round(f.y), ft: f.type, who: cl ? cl.id : 0 });
  }

  tryAttack(att, def){
    if (att.attackCd > 0 || !att.alive || !def.alive) return;
    const armed = att.stats.dmg - 3;
    const bulk = att.r > def.r * 1.15 ? 2 + att.r * 0.05 : 0;
    const dmg = armed + bulk;
    if (dmg <= 0) return;
    if (!att.isPlayer && !att.genome.aggro && !bulk) return;
    att.attackCd = 0.55;
    att.biteT = 0.25;
    const dealt = def.takeDamage(dmg, att.x, att.y);
    if (dealt > 0){
      def.lastHitBy = att;
      this.events.push({
        e: 'hit', x: Math.round(def.x), y: Math.round(def.y),
        hue: Math.round(def.genome.hue), att: att.id, tgt: def.id
      });
    }
    if (!def.alive) this.killCell(def, att);
  }

  killCell(c, killer){
    if (c.processed) return;
    c.processed = true;
    c.alive = false;
    this.events.push({
      e: 'die', x: Math.round(c.x), y: Math.round(c.y),
      hue: Math.round(c.genome.hue), r: Math.round(c.r),
      who: c.client ? c.client.id : 0, name: c.client ? c.client.name : undefined
    });
    this.world.scatterFood('meat', c.x, c.y, 2 + Math.floor(c.r / 22), c.r * 1.3);
    const orbs = randInt(1, 2 + Math.floor(c.r / 30));
    for (let i = 0; i < orbs; i++){
      const f = this.world.spawnFood('dna', c.x + rand(-c.r, c.r), c.y + rand(-c.r, c.r));
      f.vx = rand(-60, 60); f.vy = rand(-60, 60);
    }
    if (killer && killer.client){
      killer.client.run.kills++;
      if (c.client){ this.stats.pvp++; this.saveStats(); }
    }
    if (c.client){
      let by;
      if (killer && killer.client) by = killer.client.name;
      else if (killer) by = killer.genome.carn ? 'a wild predator' : 'a territorial grazer';
      else by = 'an urchin';
      this.playerDied(c.client, by);
    }
  }

  runStats(cl){
    return {
      survived: Math.round((Date.now() - cl.run.joinT) / 1000),
      gen: cl.run.gen, dnaTotal: cl.run.dnaTotal,
      kills: cl.run.kills, deaths: cl.run.deaths, name: cl.name
    };
  }

  playerDied(cl, by){
    cl.alive = false;
    cl.cell = null;
    cl.run.deaths++;
    cl.run.dna = Math.floor(cl.run.dna * 0.7);
    cl.run.growth *= 0.85;
    this.stats.deaths++;
    if (cl.run.kills > (this.stats.deadliest ? this.stats.deadliest.n : 0)){
      this.stats.deadliest = { name: cl.name, n: cl.run.kills };
    }
    this.saveStats();
    this.send(cl, { t: 'dead', stats: this.runStats(cl), by });
  }

  spawnPlayerCell(cl){
    const [x, y] = this.safeSpot(cl.run.baseR);
    const c = new Cell({ x, y, r: cl.run.baseR, genome: cl.genome, isPlayer: true });
    c.id = cl.id;
    c.client = cl;
    c.iframes = 3;
    c.r = cl.run.baseR * (1 + 0.16 * clamp(cl.run.growth / cl.run.need, 0, 1));
    c.recalc();
    c.hp = c.stats.maxHp;
    this.world.cells.push(c);
    cl.cell = c;
    cl.alive = true;
    cl.input = { tx: x, ty: y, th: 0 };
  }

  freshRun(cl, name){
    if (cl.cell){ cl.cell.alive = false; cl.cell.processed = true; cl.cell = null; }
    if (name) cl.name = name;
    cl.genome = { parts: {}, hue: cl.hue, carn: false, aggro: false };
    cl.run = {
      gen: 1, baseR: 26, dna: 10, growth: 0, need: growthNeedFor(1),
      joinT: Date.now(), eaten: 0, kills: 0, deaths: 0, dnaTotal: 10
    };
    cl.ashore = false;
    this.spawnPlayerCell(cl);
    this.send(cl, { t: 'joined', name: cl.name });
  }

  /* -------------------- messages -------------------- */

  handleMessage(cl, m){
    switch (m.t){
      case 'join': {
        const name = sanitizeName(m.name);
        this.freshRun(cl, name);
        this.events.push({ e: 'join', name });
        this.stats.joins++;
        this.saveStats();
        console.log(`[join] ${name} (#${cl.id}) — ${this.alivePlayers().length} adrift`);
        break;
      }
      case 'input': {
        if (!cl.alive || !cl.cell) break;
        const tx = +m.tx, ty = +m.ty, th = +m.th;
        if (!Number.isFinite(tx) || !Number.isFinite(ty) || !Number.isFinite(th)) break;
        cl.input = { tx, ty, th: clamp(th, 0, 1) };
        if (m.dash && cl.cell.dash()) this.events.push({ e: 'dash', id: cl.id });
        break;
      }
      case 'buy': {
        if (!cl.alive || !cl.cell || !PARTS[m.key]) break;
        const lvl = cl.genome.parts[m.key] || 0;
        const cost = partCost(m.key, lvl);
        if (cost === null || cost > cl.run.dna) break;
        cl.run.dna -= cost;
        cl.genome.parts[m.key] = lvl + 1;
        if (m.key === 'jaw' || m.key === 'spike') cl.genome.aggro = true;
        const oldMax = cl.cell.stats.maxHp;
        cl.cell.recalc();
        cl.cell.hp += Math.max(0, cl.cell.stats.maxHp - oldMax);
        this.send(cl, { t: 'buyok', key: m.key, lvl: lvl + 1, dna: cl.run.dna });
        break;
      }
      case 'respawn': {
        if (cl.alive) break;
        if (cl.ashore || !cl.run) this.freshRun(cl);
        else { this.spawnPlayerCell(cl); this.send(cl, { t: 'joined', name: cl.name }); }
        break;
      }
      case 'debug': {
        if (!this.debug || !cl.run) break;
        if (m.dna !== undefined) cl.run.dna = +m.dna | 0;
        if (m.growth !== undefined) cl.run.growth = +m.growth;
        if (m.hp !== undefined && cl.cell){
          cl.cell.hp = +m.hp;
          if (cl.cell.hp <= 0){ cl.cell.alive = false; this.killCell(cl.cell, null); }
        }
        break;
      }
    }
  }

  /* -------------------- the tick -------------------- */

  tick(){
    const dt = 1 / 30;
    const world = this.world;

    for (const cl of this.clients.values()){
      if (cl.alive && cl.cell) cl.cell.steer(cl.input.tx, cl.input.ty, dt, cl.input.th);
    }

    for (const c of world.cells) if (!c.isPlayer) c.aiUpdate(dt, world);
    for (const c of world.cells) c.physics(dt, world);

    /* eating */
    for (const f of world.food){
      if (f.dead) continue;
      let eaten = false;
      for (const cl of this.clients.values()){
        const p = cl.cell;
        if (!cl.alive || !p) continue;
        const d = dist(p.x, p.y, f.x, f.y);
        if (f.type === 'dna'){
          const pull = p.stats.pickup + 80;
          if (d < pull && d > 1){
            const sp = 260 * (1 - d / pull) + 60;
            f.vx += (p.x - f.x) / d * sp * dt * 4;
            f.vy += (p.y - f.y) / d * sp * dt * 4;
          }
        }
        if (d < p.r * 3) p.mouthT = Math.max(p.mouthT, 0.2);
        if (d < p.r * 0.9 + f.r + 6){ this.consume(p, f); eaten = true; break; }
      }
      if (eaten) continue;
      for (const c of world.cells){
        if (c.isPlayer || !c.alive) continue;
        const edible = c.genome.carn ? f.type === 'meat' : (f.type === 'algae' || f.type === 'mote');
        if (!edible) continue;
        if (dist(c.x, c.y, f.x, f.y) < c.r + f.r){ this.consume(c, f); break; }
      }
    }

    /* combat */
    const cells = world.cells;
    for (let i = 0; i < cells.length; i++){
      const a = cells[i];
      if (!a.alive) continue;
      for (let j = i + 1; j < cells.length; j++){
        const b = cells[j];
        if (!b.alive) continue;
        const d = dist(a.x, a.y, b.x, b.y);
        const minD = (a.r + b.r) * 0.85;
        if (d >= minD) continue;
        const nx = (b.x - a.x) / (d || 1), ny = (b.y - a.y) / (d || 1);
        const push = (minD - d) * 2;
        a.x -= nx * push * 0.5; a.y -= ny * push * 0.5;
        b.x += nx * push * 0.5; b.y += ny * push * 0.5;
        this.tryAttack(a, b);
        this.tryAttack(b, a);
      }
    }

    /* hazards */
    for (const c of cells){
      if (!c.alive || c.iframes > 0) continue;
      for (const h of world.hazards){
        if (dist(c.x, c.y, h.x, h.y) < c.r + h.r * 1.1){
          c.takeDamage(11, h.x, h.y);
          c.iframes = Math.max(c.iframes, 0.6);
          this.events.push({
            e: 'hit', x: Math.round(c.x), y: Math.round(c.y),
            hue: Math.round(c.genome.hue), att: 0, tgt: c.id
          });
          if (!c.alive) this.killCell(c, null);
          break;
        }
      }
    }

    /* deaths */
    for (const c of cells) if (!c.alive && !c.processed) this.killCell(c, c.lastHitBy || null);
    world.cells = cells.filter(c => c.alive);

    /* growth: molt or crawl ashore */
    for (const cl of this.clients.values()){
      if (!cl.alive || !cl.cell) continue;
      const run = cl.run;
      if (run.growth < run.need) continue;
      if (run.gen >= 5){
        this.events.push({ e: 'ashore', id: cl.id, name: cl.name });
        cl.cell.alive = false;
        cl.cell.processed = true;
        cl.cell = null;
        cl.alive = false;
        cl.ashore = true;
        const rs = this.runStats(cl);
        this.stats.ashore++;
        if (!this.stats.fastest || rs.survived < this.stats.fastest.s){
          this.stats.fastest = { name: cl.name, s: rs.survived };
        }
        if (rs.kills > (this.stats.deadliest ? this.stats.deadliest.n : 0)){
          this.stats.deadliest = { name: cl.name, n: rs.kills };
        }
        this.saveStats();
        this.send(cl, { t: 'ashore', stats: rs });
      } else {
        run.gen++;
        run.baseR *= 1.30;
        run.growth = 0;
        run.need = growthNeedFor(run.gen);
        const c = cl.cell;
        c.r = run.baseR;
        c.recalc();
        c.hp = c.stats.maxHp;
        this.events.push({ e: 'molt', id: cl.id, gen: run.gen, x: Math.round(c.x), y: Math.round(c.y) });
      }
    }

    /* keep the soup populated */
    const players = this.alivePlayers();
    const targetFauna = 26 + 8 * players.length;
    if (world.cells.filter(c => !c.isPlayer).length < targetFauna){
      for (let tries = 0; tries < 6; tries++){
        const a = rand(0, TAU), d = Math.sqrt(Math.random()) * WORLD_R * 0.92;
        const x = Math.cos(a) * d, y = Math.sin(a) * d;
        let ok = true;
        for (const cl of players){
          if (dist(x, y, cl.cell.x, cl.cell.y) < 1200){ ok = false; break; }
        }
        if (ok){ this.spawnAICell(x, y); break; }
      }
    }

    let fSpawns = 3;
    while (world.food.length < FOOD_TARGET && fSpawns-- > 0){
      let x, y;
      const near = players.length && Math.random() < 0.55 ? pick(players) : null;
      if (near){
        const a = rand(0, TAU), d = rand(280, 1300);
        x = near.cell.x + Math.cos(a) * d;
        y = near.cell.y + Math.sin(a) * d;
        const wd = Math.hypot(x, y);
        if (wd > WORLD_R * 0.94){ x *= WORLD_R * 0.94 / wd; y *= WORLD_R * 0.94 / wd; }
      } else {
        [x, y] = world.randomFoodSpot(0, 0, 0);
      }
      world.spawnFood(Math.random() < 0.5 ? 'mote' : 'algae', x, y);
    }

    world.update(dt);

    this.tickN++;
    if (this.tickN % 2 === 0) this.broadcast();
  }

  /* -------------------- snapshots -------------------- */

  broadcast(){
    const world = this.world;
    for (const f of world.food) if (f.id === undefined) f.id = this.nextId++;

    const cellsArr = world.cells.map(c => {
      const row = [
        c.id, Math.round(c.x), Math.round(c.y),
        Math.round(c.vx), Math.round(c.vy),
        +c.dir.toFixed(2), +c.r.toFixed(1),
        Math.ceil(c.hp), Math.round(c.stats.maxHp),
        Math.round(c.genome.hue), partsStr(c.genome.parts),
        (c.genome.carn ? 1 : 0) | (c.genome.aggro ? 2 : 0) | (c.isPlayer ? 4 : 0)
      ];
      if (c.client) row.push(c.client.name, c.client.run.gen, c.client.run.dnaTotal);
      return row;
    });
    const foodArr = world.food.map(f =>
      [f.id, FOOD_TYPES.indexOf(f.type), Math.round(f.x), Math.round(f.y), Math.round(f.r)]);

    const snapObj = {
      t: 'snap', ts: Date.now(), cells: cellsArr, food: foodArr, ev: this.events.splice(0)
    };
    /* piggyback the chronicle every ~2s */
    if (this.tickN % 30 === 0) snapObj.world = this.worldStats();
    const snap = JSON.stringify(snapObj);

    for (const cl of this.clients.values()){
      try {
        cl.ws.send(snap);
        if (cl.run){
          cl.ws.send(JSON.stringify({
            t: 'you', dna: cl.run.dna, growth: +cl.run.growth.toFixed(1),
            need: cl.run.need, gen: cl.run.gen
          }));
        }
      } catch (e) { /* dropped mid-send; close handler cleans up */ }
    }
  }
}

function partsStr(parts){
  let s = '';
  for (const k of PART_KEYS) s += (parts[k] || 0);
  return s;
}

function sanitizeName(raw){
  const s = String(raw || '').replace(/[^\x20-\x7E]/g, '').trim().slice(0, 28);
  return s || randomSpeciesName();
}
