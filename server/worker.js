/* ============================================================
   SOUPLINGS on Cloudflare — Worker entry + Soup Durable Object
   One DO instance holds the one shared soup; clients attach
   over WebSockets and receive 15 Hz world snapshots.
   ============================================================ */

import {
  Cell, World, PARTS, PART_KEYS, FOOD_TYPES, NEWBIE_R, HUE_UNLOCKS, TRAIL_UNLOCKS, SHAPE_UNLOCKS,
  randomGenome, partCost, randomSpeciesName, isValidSpeciesName, growthNeedFor,
  rand, randInt, pick, clamp, dist, TAU
} from './sim.gen.mjs';

const WORLD_R = 3000;
const FOOD_TARGET = 480;
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
    if (url.pathname === '/health'){
      /* DO vitals with a hard timeout: if this times out, the soup is wedged */
      try {
        const vitals = env.SOUP.get(env.SOUP.idFromName('the-one-soup')).fetch(new Request('https://soup/health'));
        const res = await Promise.race([
          vitals,
          new Promise((_, rej) => setTimeout(() => rej(new Error('DO timeout')), 3000))
        ]);
        return res;
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: String(e) }), {
          status: 503, headers: { 'Content-Type': 'application/json' }
        });
      }
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
    this.env = env;
    this.debug = env.SOUPLINGS_DEBUG === '1' || env.SOUPLINGS_DEBUG === 'true';
    this.world = new World(WORLD_R);
    this.clients = new Map();   // ws -> client
    this.events = [];
    this.nextId = 1;
    this.tickN = 0;
    this.hueCursor = 0;
    this.timer = null;
    /* the chronicle: persistent all-time world stats + today's records */
    this.stats = { joins: 0, deaths: 0, ashore: 0, pvp: 0, fastest: null, deadliest: null, dynasty: null };
    this.daily = null;
    this.goldT = 60 + Math.random() * 60;
    this.vaultT = 45 + Math.random() * 45;
    this.vaults = [];
    this.inkZones = [];
    this.invites = new Map();
    state.blockConcurrencyWhile(async () => {
      const saved = await state.storage.get('stats');
      if (saved) this.stats = { ...this.stats, ...saved };
      const day = await state.storage.get('daily');
      if (day) this.daily = day;
    });
    this.seedWorld();
  }

  saveStats(){
    this.state.storage.put('stats', this.stats);
  }

  dayKey(){ return new Date().toISOString().slice(0, 10); }

  ensureDaily(){
    const k = this.dayKey();
    if (!this.daily || this.daily.date !== k){
      this.daily = { date: k, ashore: 0, deaths: 0, fastest: null, deadliest: null };
    }
    return this.daily;
  }

  saveDaily(){ this.state.storage.put('daily', this.daily); }

  worldStats(){
    return { ...this.stats, online: this.alivePlayers().length, daily: this.ensureDaily() };
  }

  /* -------------------- connections -------------------- */

  fetch(req){
    if (req && new URL(req.url).pathname === '/health'){
      return new Response(JSON.stringify({
        ok: true,
        tickN: this.tickN,
        lastTickAt: this.lastTickAt || 0,
        tickAgeMs: this.lastTickAt ? Date.now() - this.lastTickAt : -1,
        tickErrors: this.tickErrors || 0,
        pendingEvents: this.events.length,
        clients: this.clients.size,
        cells: this.world.cells.length,
        food: this.world.food.length,
        timer: this.timer != null
      }), { headers: { 'Content-Type': 'application/json' } });
    }
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
      input: { tx: 0, ty: 0, th: 0 },
      lineage: 0, cyst: 0, editorOpen: false, lastDamageAt: 0, trail: 0, shape: 0
    };
    this.clients.set(ws, cl);
    this.send(cl, { t: 'welcome', id: cl.id, radius: WORLD_R, hazards: this.world.hazards, world: this.worldStats() });

    ws.addEventListener('message', ev => {
      let m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      Promise.resolve(this.handleMessage(cl, m)).catch(e => console.error('msg error', e));
    });
    const bye = () => this.dropClient(ws);
    ws.addEventListener('close', bye);
    ws.addEventListener('error', bye);

    if (this.timer == null) this.timer = setInterval(() => this.tick(), 33);
  }

  dropClient(ws){
    const cl = this.clients.get(ws);
    if (!cl) return;
    this.persistRun(cl);
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

  /* the shallows grow only crumbs — a full belly requires deeper water */
  foodTypeAt(x, y){
    if (Math.hypot(x, y) < WORLD_R * 0.33) return 'mote';
    return Math.random() < 0.5 ? 'mote' : 'algae';
  }

  seedWorld(){
    const w = this.world;
    for (let i = 0; i < FOOD_TARGET; i++){
      const [x, y] = w.randomFoodSpot(0, 0, 0);
      w.spawnFood(this.foodTypeAt(x, y), x, y);
    }
    for (let i = 0; i < 12; i++) w.spawnHazard(rand(28, 46));
    for (let i = 0; i < 20; i++){
      const a = rand(0, TAU), d = Math.sqrt(Math.random()) * WORLD_R * 0.9;
      this.spawnAICell(Math.cos(a) * d, Math.sin(a) * d);
    }
  }

  spawnVault(){
    const tier = randInt(1, 3);
    const a = rand(0, TAU), d = WORLD_R * rand(0.4, 0.85);
    this.vaults.push({
      id: this.nextId++,
      x: Math.cos(a) * d, y: Math.sin(a) * d,
      r: 24 + tier * 8,
      hp: [0, 80, 200, 410][tier],
      maxHp: [0, 80, 200, 410][tier],
      tier, age: 0, broken: false
    });
    this.events.push({ e: 'vaultSpawn', tier });
  }

  spawnGoldenMote(){
    const a = rand(0, TAU), d = WORLD_R * rand(0.4, 0.75);
    const f = this.world.spawnFood('gold', Math.cos(a) * d, Math.sin(a) * d);
    f.decay = 50;
    this.events.push({ e: 'goldSpawn', x: Math.round(f.x), y: Math.round(f.y) });
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
      /* feeding frenzy: six meals in eight seconds ignites you */
      const now = Date.now();
      cl.eats = (cl.eats || []).filter(t2 => now - t2 < 7000);
      cl.eats.push(now);
      if (cl.frenzyUntil > now){
        cl.frenzyUntil = now + 3000;   // keep eating, keep burning
      } else if (cl.eats.length >= 8 && now - (cl.spawnAt || 0) > 10000){
        /* eight meals in seven seconds, and never in the first breaths
           after spawning (spawn points sit in a pile of crumbs) */
        cl.frenzyUntil = now + 5000;
        this.events.push({ e: 'frenzy', id: cl.id });
      }
      const fMul = cl.frenzyUntil > now ? 2 : 1;
      run.growth += f.mass * (herb ? st.algaeMul : st.meatMul) * (st.growthMul || 1);
      const dnaGain = Math.round(f.dna * (st.dnaMul || 1) * fMul);
      run.dna += dnaGain;
      run.dnaTotal += dnaGain;
      run.eaten++;
      cell.r = run.baseR * (1 + 0.16 * clamp(run.growth / run.need, 0, 1));
      cell.recalc();
      if (f.type === 'gold') this.events.push({ e: 'goldgone', name: cl.name, id: cl.id });
    }
    this.events.push({ e: 'eat', x: Math.round(f.x), y: Math.round(f.y), ft: f.type, who: cl ? cl.id : 0 });
  }

  tryAttack(att, def){
    if (att.attackCd > 0 || !att.alive || !def.alive) return;
    /* the wild ignores newborn players entirely — snake.io rule:
       early death should only ever come from your own choices */
    if (!att.isPlayer && def.isPlayer && def.r < NEWBIE_R){
      if (def.client && Date.now() - (def.client.lastGuardHint || 0) > 30000){
        def.client.lastGuardHint = Date.now();
        this.send(def.client, { t: 'hint', key: 'guarded', msg: 'the wild cannot be bothered with something your size — danger begins at Gen III' });
      }
      return;
    }
    const armed = att.stats.dmg - 3;
    /* body-checks scale with how badly you are outweighed — a giant
       shouldering you should hurt, not tickle */
    const bulk = att.r > def.r * 1.15 ? Math.min(22, 2 + (att.r / def.r - 1) * 12) : 0;
    const dmg = armed + bulk;
    if (dmg <= 0){
      /* a player harmlessly bonking something deserves an explanation, once in a while */
      if (att.isPlayer && att.client && Date.now() - (att.client.lastBumpHint || 0) > 20000){
        att.client.lastBumpHint = Date.now();
        this.send(att.client, { t: 'hint', key: 'bump', msg: 'ramming does nothing without Spines or a Jaw — press E to evolve' });
      }
      return;
    }
    if (!att.isPlayer && !att.genome.aggro && !bulk) return;
    if (att.isPlayer && att.iframes > 1.5) att.iframes = 0;   // spawn shields don't snipe
    att.attackCd = 0.55;
    att.biteT = 0.25;
    const dealt = def.takeDamage(dmg, att.x, att.y);
    if (dealt > 0){
      def.lastHitBy = att;
      if (def.client) def.client.lastDamageAt = Date.now();
      this.events.push({
        e: 'hit', x: Math.round(def.x), y: Math.round(def.y),
        hue: Math.round(def.genome.hue), att: att.id, tgt: def.id
      });
      /* volt organ: biting this one was a mistake */
      const volt = def.stats.volt || 0;
      if (volt && att.alive){
        att.takeDamage(volt, def.x, def.y);
        att.lastHitBy = def;
        if (att.client) att.client.lastDamageAt = Date.now();
        this.events.push({ e: 'zap', x: Math.round(att.x), y: Math.round(att.y), tgt: att.id });
        if (!att.alive) this.killCell(att, def);
      }
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
      who: c.client ? c.client.id : 0, name: c.client ? c.client.name : undefined,
      by: killer && killer.client ? killer.client.id : 0,
      byName: killer && killer.client ? killer.client.name : undefined
    });
    /* player deaths are gold rushes — the bigger the life, the bigger the feast */
    const isPlayerDeath = !!c.client;
    const meatN = isPlayerDeath ? 3 + c.client.run.gen * 2 : 2 + Math.floor(c.r / 22);
    this.world.scatterFood('meat', c.x, c.y, meatN, c.r * (isPlayerDeath ? 1.6 : 1.3));
    const orbs = isPlayerDeath
      ? 2 + c.client.run.gen + Math.min(3, c.client.lineage)
      : randInt(1, 2 + Math.floor(c.r / 30));
    for (let i = 0; i < orbs; i++){
      const f = this.world.spawnFood('dna', c.x + rand(-c.r, c.r), c.y + rand(-c.r, c.r));
      f.vx = rand(-60, 60); f.vy = rand(-60, 60);
    }
    if (killer && killer.client){
      killer.client.run.kills++;
      if (c.client){
        this.stats.pvp++;
        this.saveStats();
        /* vengeance: killing your nemesis pays, loudly */
        if (killer.client.nemesisId === c.client.id){
          killer.client.run.dna += 40;
          killer.client.run.dnaTotal += 40;
          killer.client.nemesisId = 0;
          this.events.push({ e: 'vengeance', a: killer.client.name, t: c.client.name, id: killer.client.id });
        }
        c.client.nemesisId = killer.client.id;
        c.client.nemesisName = killer.client.name;
      }
    }
    if (c.client){
      let by;
      if (killer && killer.client) by = killer.client.name;
      else if (killer) by = killer.genome.carn ? 'a wild predator' : 'a territorial grazer';
      else by = 'an urchin';
      this.playerDied(c.client, by, killer ? killer.id : 0);
    }
  }

  runStats(cl){
    return {
      survived: Math.round((Date.now() - cl.run.joinT) / 1000),
      gen: cl.run.gen, dnaTotal: cl.run.dnaTotal,
      kills: cl.run.kills, deaths: cl.run.deaths, name: cl.name
    };
  }

  playerDied(cl, by, killerId){
    cl.alive = false;
    cl.cell = null;
    cl.run.deaths++;
    cl.run.dna = Math.floor(cl.run.dna * 0.5);
    cl.run.growth *= 0.6;
    this.stats.deaths++;
    const day = this.ensureDaily();
    day.deaths++;
    if (cl.run.kills > (day.deadliest ? day.deadliest.n : 0)) day.deadliest = { name: cl.name, n: cl.run.kills };
    this.saveDaily();
    if (cl.run.kills > (this.stats.deadliest ? this.stats.deadliest.n : 0)){
      this.stats.deadliest = { name: cl.name, n: cl.run.kills };
    }
    this.saveStats();
    this.send(cl, {
      t: 'dead', stats: this.runStats(cl), by,
      killerId: killerId || 0,
      nemesis: cl.nemesisName || undefined,
      life: this.lifeView(cl)
    });
  }

  spawnPlayerCell(cl, near){
    const [x, y] = near
      ? [near.cell.x + rand(-180, 180), near.cell.y + rand(-180, 180)]
      : this.safeSpot(cl.run.baseR);
    const c = new Cell({ x, y, r: cl.run.baseR, genome: cl.genome, isPlayer: true });
    c.id = cl.id;
    c.client = cl;
    cl.eats = [];
    cl.frenzyUntil = 0;
    cl.spawnAt = Date.now();
    /* a real cooldown after death: nobody gets farmed at the spawn.
       aggression forfeits it early (see tryAttack) */
    c.iframes = Object.keys(cl.genome.parts).length ? 8 : 10;
    c.r = cl.run.baseR * (1 + 0.16 * clamp(cl.run.growth / cl.run.need, 0, 1));
    c.recalc();
    c.hp = c.stats.maxHp;
    this.world.cells.push(c);
    cl.cell = c;
    cl.alive = true;
    cl.input = { tx: x, ty: y, th: 0 };
  }

  freshRun(cl, name, near){
    this.bankRun(cl);
    if (cl.cell){ cl.cell.alive = false; cl.cell.processed = true; cl.cell = null; }
    if (name) cl.name = name;
    if (!cl.name) cl.name = randomSpeciesName();   // respawn on a fresh socket, no join first
    cl.genome = { parts: {}, hue: cl.hue, carn: false, aggro: false };
    /* heirloom: every emergence strengthens the next voyage */
    const heirloom = 10 + Math.min(90, 15 * cl.lineage);
    cl.run = {
      gen: 1, baseR: 26, dna: heirloom, growth: 0, need: growthNeedFor(1),
      joinT: Date.now(), eaten: 0, kills: 0, deaths: 0, dnaTotal: heirloom
    };
    cl.ashore = false;
    cl.runBanked = false;
    this.spawnPlayerCell(cl, near);
    this.send(cl, { t: 'joined', name: cl.name, lineage: cl.lineage, life: this.lifeView(cl) });
  }

  /* -------------------- messages -------------------- */

  /* custom names pass through Claude Haiku; verdicts are cached forever.
     No API key or any failure = fail closed = a generated name. */
  async moderateName(name){
    const key = 'mod:' + name.toLowerCase();
    const cached = await this.state.storage.get(key);
    if (cached !== undefined) return cached;
    if (!this.env.ANTHROPIC_API_KEY) return false;
    try {
      const res = await Promise.race([
        fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': this.env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 5,
            system: 'You moderate display names for a family-friendly multiplayer game. Reply with exactly ALLOW or DENY. DENY names containing profanity, slurs, sexual content, harassment, hate speech or symbols, drug references, or filter evasion via creative spelling or symbols. When unsure, DENY.',
            messages: [{ role: 'user', content: 'Name: "' + name + '"' }]
          })
        }),
        new Promise((resolve, reject) => setTimeout(() => reject(new Error('timeout')), 3000))
      ]);
      const data = await res.json();
      const ok = ((data.content && data.content[0] && data.content[0].text) || '').trim().toUpperCase().startsWith('ALLOW');
      this.state.storage.put(key, ok);
      return ok;
    } catch (e) {
      return false;
    }
  }

  saveProfile(cl){
    if (!cl.token) return;
    /* v stamps the schema; reads stay field-by-field defensive so old
       profiles never break new code */
    const life = cl.life || { time: 0, dna: 0, kills: 0, runs: 0 };
    this.state.storage.put('prof:' + cl.token, {
      v: 1, lineage: cl.lineage, name: cl.name, t: Date.now(),
      lifeTime: life.time, lifeDna: life.dna, lifeKills: life.kills, lifeRuns: life.runs
    });
  }

  /* park the live run in storage so a disconnect (or a deploy) can't
     erase it — the next join with this token resumes where it left off */
  persistRun(cl){
    if (!cl.token || !cl.run || cl.ashore) return;
    this.state.storage.put('run:' + cl.token, {
      at: Date.now(), run: cl.run, parts: cl.genome ? cl.genome.parts : {}
    });
  }

  /* bank a finished run into the dynasty's lifetime ledger — once */
  bankRun(cl){
    if (!cl.run || cl.runBanked) return;
    cl.runBanked = true;
    const life = cl.life = cl.life || { time: 0, dna: 0, kills: 0, runs: 0 };
    life.time += Math.round((Date.now() - cl.run.joinT) / 1000);
    life.dna += cl.run.dnaTotal;
    life.kills += cl.run.kills;
    life.runs += 1;
    this.saveProfile(cl);
  }

  /* the ledger as of right now, current run included */
  lifeView(cl){
    const life = cl.life || { time: 0, dna: 0, kills: 0, runs: 0 };
    if (cl.runBanked || !cl.run) return { ...life, emergences: cl.lineage };
    return {
      time: life.time + Math.round((Date.now() - cl.run.joinT) / 1000),
      dna: life.dna + cl.run.dnaTotal,
      kills: life.kills + cl.run.kills,
      runs: life.runs + 1,
      emergences: cl.lineage
    };
  }

  async handleMessage(cl, m){
    switch (m.t){
      case 'ping':
        /* no-op — the incoming message itself resets the DO's CPU allowance */
        break;
      case 'editor':
        cl.editorOpen = !!m.open;
        break;
      case 'invite': {
        if (!cl.inviteCode){
          cl.inviteCode = Math.random().toString(36).slice(2, 8);
          this.invites.set(cl.inviteCode, cl);
        }
        this.send(cl, { t: 'invite', code: cl.inviteCode });
        break;
      }
      case 'ident': {
        /* live identity update from the pause menu */
        if (!cl.run) break;
        const raw = String(m.name || '').trim();
        if (raw && raw !== cl.name){
          if (isValidSpeciesName(raw)){
            cl.name = raw;
          } else if (/^[A-Za-z0-9 '\-\.]{2,24}$/.test(raw) && await this.moderateName(raw)){
            cl.name = raw;
          } else {
            this.send(cl, { t: 'toast', msg: 'the taxonomists rejected that name' });
          }
        }
        const wHue = +m.hue;
        const hOpt = HUE_UNLOCKS.find(u => u[0] === wHue);
        if (wHue === 335){
          cl.hue = 335;
          if (cl.genome) cl.genome.hue = 335;
        } else if (hOpt && cl.lineage >= hOpt[1]){
          cl.hue = wHue;
          if (cl.genome) cl.genome.hue = wHue;
        }
        const wTrail = +m.trail;
        const tOpt = TRAIL_UNLOCKS.find(u => u[0] === wTrail);
        if (tOpt && cl.lineage >= tOpt[1]) cl.trail = wTrail;
        const wShape = +m.shape;
        const sOpt = SHAPE_UNLOCKS.find(u => u[0] === wShape);
        if (sOpt && cl.lineage >= sOpt[1]) cl.shape = wShape;
        this.saveProfile(cl);
        this.send(cl, { t: 'renamed', name: cl.name });
        break;
      }
      case 'join': {
        /* restore the dynasty first: lineage persists per anonymous device token */
        if (typeof m.token === 'string' && /^[0-9a-f]{16,64}$/.test(m.token)){
          cl.token = m.token;
          const prof = await this.state.storage.get('prof:' + m.token);
          if (prof){
            if (prof.lineage) cl.lineage = prof.lineage;
            cl.life = {
              time: prof.lifeTime || 0, dna: prof.lifeDna || 0,
              kills: prof.lifeKills || 0, runs: prof.lifeRuns || 0
            };
          }
        }
        /* names: generator grammar passes free; custom names face the taxonomists (Haiku) */
        const raw = String(m.name || '').trim();
        let name;
        if (isValidSpeciesName(raw)){
          name = raw;
        } else if (/^[A-Za-z0-9 '\-\.]{2,24}$/.test(raw) && await this.moderateName(raw)){
          name = raw;
        } else {
          name = randomSpeciesName();
          if (raw) this.send(cl, { t: 'toast', msg: 'the taxonomists rejected that name — you are ' + name });
        }
        /* dynasty hues + trails: only what the lineage has earned */
        const wantHue = +m.hue;
        const hueOpt = HUE_UNLOCKS.find(u => u[0] === wantHue);
        if (wantHue === 335) cl.hue = 335;   // the share-surfaced color
        else if (hueOpt && cl.lineage >= hueOpt[1]) cl.hue = wantHue;
        const wantTrail = +m.trail;
        const trailOpt = TRAIL_UNLOCKS.find(u => u[0] === wantTrail);
        if (trailOpt && cl.lineage >= trailOpt[1]) cl.trail = wantTrail;
        const wantShape = +m.shape;
        const shapeOpt = SHAPE_UNLOCKS.find(u => u[0] === wantShape);
        if (shapeOpt && cl.lineage >= shapeOpt[1]) cl.shape = wantShape;
        /* a run parked by a disconnect? resume it instead of resetting */
        let resumed = false;
        if (cl.token){
          const saved = await this.state.storage.get('run:' + cl.token);
          if (saved && saved.run){
            this.state.storage.delete('run:' + cl.token);
            if (Date.now() - saved.at < 300000){
              cl.name = name;
              cl.genome = { parts: saved.parts || {}, hue: cl.hue, carn: false, aggro: false };
              cl.run = saved.run;
              cl.ashore = false;
              cl.runBanked = false;
              this.spawnPlayerCell(cl);
              resumed = true;
            } else {
              /* expired unclaimed — bank it into the ledger */
              const life = cl.life = cl.life || { time: 0, dna: 0, kills: 0, runs: 0 };
              life.time += Math.max(0, Math.round((saved.at - saved.run.joinT) / 1000));
              life.dna += saved.run.dnaTotal;
              life.kills += saved.run.kills;
              life.runs += 1;
            }
          }
        }
        if (resumed){
          this.send(cl, { t: 'joined', name: cl.name, lineage: cl.lineage, life: this.lifeView(cl), resumed: 1 });
          this.saveProfile(cl);
          this.events.push({ e: 'join', name });
          console.log(`[resume] ${name} (#${cl.id}) — gen ${cl.run.gen}`);
          break;
        }
        /* buddy links: surface beside the friend who invited you */
        let near = null;
        if (typeof m.buddy === 'string' && this.invites.has(m.buddy)){
          const host = this.invites.get(m.buddy);
          if (host !== cl && host.alive && host.cell) near = host;
        }
        this.freshRun(cl, name, near);
        if (near){
          this.send(cl, { t: 'toast', msg: `you surface beside ${near.name}` });
          this.send(near, { t: 'toast', msg: `${cl.name} surfaces beside you` });
        }
        this.saveProfile(cl);
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
        if (m.dash && cl.cell.dash()){
          this.events.push({ e: 'dash', id: cl.id });
          /* ink sac: the dash vents a blinding cloud — wild hunters lose the trail */
          if (cl.genome.parts.ink){
            this.events.push({ e: 'ink', x: Math.round(cl.cell.x), y: Math.round(cl.cell.y) });
            this.inkZones.push({ x: cl.cell.x, y: cl.cell.y, r: 180, until: Date.now() + 4000, owner: cl.id });
            for (const c of this.world.cells){
              if (c.isPlayer || !c.alive || !c.think) continue;
              if (c.think.mode === 'hunt' && c.think.target === cl.cell){
                c.think.black = cl.cell;
                c.think.blackT = 8;
                c.think.huntT = 0;
                c.think.mode = 'wander';
              }
            }
          }
        }
        break;
      }
      case 'buy': {
        if (!cl.alive || !cl.cell || !PARTS[m.key]) break;
        if ((PARTS[m.key].gen || 1) > cl.run.gen) break;      // not yet unlocked
        if ((PARTS[m.key].dyn || 0) > cl.lineage) break;      // royal organs need an emerged dynasty
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
        else { this.spawnPlayerCell(cl); this.send(cl, { t: 'joined', name: cl.name, lineage: cl.lineage, life: this.lifeView(cl) }); }
        break;
      }
      case 'debug': {
        if (!this.debug || !cl.run) break;
        if (m.dna !== undefined) cl.run.dna = +m.dna | 0;
        if (m.lineage !== undefined) cl.lineage = +m.lineage | 0;
        if (m.growth !== undefined) cl.run.growth = +m.growth;
        if (m.hp !== undefined && cl.cell){
          cl.cell.hp = +m.hp;
          if (cl.cell.hp <= 0){ cl.cell.alive = false; this.killCell(cl.cell, null); }
        }
        if (m.frenzy){
          cl.frenzyUntil = Date.now() + 5000;
          this.events.push({ e: 'frenzy', id: cl.id });
        }
        if (m.gold) this.spawnGoldenMote();
        if (m.feed && cl.cell && FOOD_TYPES.includes(m.feed)){
          const f = this.world.spawnFood(m.feed, cl.cell.x, cl.cell.y);
          this.consume(cl.cell, f);
        }
        if (m.vault) this.spawnVault();
        if (Array.isArray(m.tp) && cl.cell){
          cl.cell.x = +m.tp[0] || 0;
          cl.cell.y = +m.tp[1] || 0;
          cl.input = { tx: cl.cell.x, ty: cl.cell.y, th: 0 };
        }
        break;
      }
    }
  }

  /* -------------------- the tick -------------------- */

  tick(){
    /* a sim bug must never crash-loop OR silently freeze the Durable Object */
    this.lastTickAt = Date.now();
    try {
      this.simulate();
      this.tickErrors = 0;
    } catch (e) {
      this.tickErrors = (this.tickErrors || 0) + 1;
      console.error('tick error #' + this.tickErrors, e && e.stack || e);
      /* backpressure: a broken simulate never broadcasts, so events pile up */
      if (this.events.length > 400) this.events.length = 0;
      if (this.tickErrors >= 90){
        /* three seconds of continuous failure: assume poisoned world state.
           Reseed the wildlife and keep the players — a rough molt beats a
           frozen soup. The chronicle and profiles live in storage, untouched. */
        console.error('SELF-HEAL: reseeding poisoned world');
        this.world = new World(WORLD_R);
        this.vaults = [];
        this.inkZones = [];
        this.seedWorld();
        for (const cl of this.clients.values()){
          if (cl.run && cl.alive){ cl.cell = null; this.spawnPlayerCell(cl); }
        }
        this.tickErrors = 0;
      }
    }
  }

  simulate(){
    const dt = 1 / 30;
    const world = this.world;

    for (const cl of this.clients.values()){
      if (!cl.alive || !cl.cell) continue;
      cl.cell.frenzy = cl.frenzyUntil > Date.now();
      /* encysted: safe & stationary while mutating — but only if calm */
      if (cl.editorOpen && Date.now() - (cl.lastDamageAt || 0) > 4000){
        cl.cyst = 2;
        cl.cell.iframes = Math.max(cl.cell.iframes, 1.2);
        cl.cell.vx *= 0.85;
        cl.cell.vy *= 0.85;
        continue;
      }
      cl.cyst = cl.editorOpen ? 1 : 0;
      cl.cell.steer(cl.input.tx, cl.input.ty, dt, cl.input.th);
    }

    world.updateHazardOrbits(Date.now() / 1000);

    /* ink zones: anything but the venter wading through gets sludged */
    const zoneNow = Date.now();
    this.inkZones = this.inkZones.filter(z => z.until > zoneNow);
    for (const cl of this.clients.values()) cl.slowed = false;
    for (const z of this.inkZones){
      for (const c of world.cells){
        if (!c.alive || c.id === z.owner) continue;
        if (dist(c.x, c.y, z.x, z.y) > z.r + c.r * 0.3) continue;
        c.inked = true;
        if (c.client) c.client.slowed = true;
      }
    }

    for (const c of world.cells) if (!c.isPlayer) c.aiUpdate(dt, world);
    for (const c of world.cells) c.physics(dt, world);

    /* ink is thick: anyone caught in it crawls, dashes included */
    for (const c of world.cells){
      if (!c.inked) continue;
      c.inked = false;
      const cap = c.stats.speed * 0.28;
      const v = Math.hypot(c.vx, c.vy);
      if (v > cap){ c.vx *= cap / v; c.vy *= cap / v; }
    }

    /* eating */
    for (const f of world.food){
      if (f.dead) continue;
      let eaten = false;
      for (const cl of this.clients.values()){
        const p = cl.cell;
        if (!cl.alive || !p) continue;
        if (cl.cyst === 2) continue;   // paused in the menu — the soup waits
        const d = dist(p.x, p.y, f.x, f.y);
        if (f.type === 'dna'){
          const pull = p.stats.pickup + 80;
          if (d < pull && d > 1){
            const sp = 260 * (1 - d / pull) + 60;
            f.vx += (p.x - f.x) / d * sp * dt * 4;
            f.vy += (p.y - f.y) / d * sp * dt * 4;
          }
        } else if (p.stats.lure > 0 && f.type !== 'gold'){
          /* the biolume gland actually lures now — it never did before */
          const lr = p.stats.lure + p.r;
          if (d < lr && d > 1){
            const sp = 110 * (1 - d / lr) + 25;
            f.vx += (p.x - f.x) / d * sp * dt * 3;
            f.vy += (p.y - f.y) / d * sp * dt * 3;
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
          if (c.client) c.client.lastDamageAt = Date.now();
          this.events.push({
            e: 'hit', x: Math.round(c.x), y: Math.round(c.y),
            hue: Math.round(c.genome.hue), att: 0, tgt: c.id
          });
          if (!c.alive){
            const wasHunting = !c.isPlayer && c.think && c.think.mode === 'hunt';
            this.killCell(c, null);
            if (wasHunting){
              /* lured to its death — kiting pays */
              for (let i = 0; i < 3; i++){
                const f = this.world.spawnFood('dna', c.x + rand(-c.r, c.r), c.y + rand(-c.r, c.r));
                f.vx = rand(-60, 60); f.vy = rand(-60, 60);
              }
            }
          }
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
        if (cl.token) this.state.storage.delete('run:' + cl.token);
        const rs = this.runStats(cl);
        this.stats.ashore++;
        cl.lineage++;
        const day = this.ensureDaily();
        day.ashore++;
        if (!day.fastest || rs.survived < day.fastest.s) day.fastest = { name: cl.name, s: rs.survived };
        this.saveDaily();
        if (!this.stats.fastest || rs.survived < this.stats.fastest.s){
          this.stats.fastest = { name: cl.name, s: rs.survived };
        }
        if (rs.kills > (this.stats.deadliest ? this.stats.deadliest.n : 0)){
          this.stats.deadliest = { name: cl.name, n: rs.kills };
        }
        if (cl.lineage > (this.stats.dynasty ? this.stats.dynasty.n : 0)){
          this.stats.dynasty = { name: cl.name, n: cl.lineage };
        }
        this.saveStats();
        this.bankRun(cl);
        this.saveProfile(cl);
        rs.lineage = cl.lineage;
        this.send(cl, { t: 'ashore', stats: rs, life: this.lifeView(cl) });
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

    const players = this.alivePlayers();

    /* the golden mote: rare, radiant, cowardly, announced to everyone */
    if (players.length > 0){
      this.goldT -= dt;
      if (this.goldT <= 0){
        this.goldT = 90 + Math.random() * 60;
        this.spawnGoldenMote();
      }
    }
    for (const f of world.food){
      if (f.type !== 'gold') continue;
      let near = null, nd = 320;
      for (const cl2 of players){
        const d2 = dist(f.x, f.y, cl2.cell.x, cl2.cell.y);
        if (d2 < nd){ nd = d2; near = cl2.cell; }
      }
      if (near){
        const dx = f.x - near.x, dy = f.y - near.y;
        const dd = Math.hypot(dx, dy) || 1;
        f.vx += dx / dd * 520 * dt;
        f.vy += dy / dd * 520 * dt;
        const sp2 = Math.hypot(f.vx, f.vy);
        if (sp2 > 235){ f.vx *= 235 / sp2; f.vy *= 235 / sp2; }
      }
      const wd2 = Math.hypot(f.x, f.y);
      if (wd2 > WORLD_R * 0.9){ f.vx -= f.x / wd2 * 300 * dt; f.vy -= f.y / wd2 * 300 * dt; }
    }

    /* DNA vaults: crusted hoards that must be cracked open. Tier sets
       toughness and payout; max damage opens the biggest in ~5 seconds. */
    if (players.length > 0){
      this.vaultT -= dt;
      if (this.vaultT <= 0 && this.vaults.length < 2){
        this.vaultT = 70 + Math.random() * 50;
        this.spawnVault();
      }
    }
    for (const v of this.vaults){
      v.age += dt;
      for (const cl2 of players){
        const p2 = cl2.cell;
        if (dist(p2.x, p2.y, v.x, v.y) > p2.r + v.r * 0.9) continue;
        if (p2.attackCd > 0) continue;
        p2.attackCd = 0.55;
        p2.biteT = 0.25;
        v.hp -= p2.stats.dmg;
        this.events.push({ e: 'vhit', id: v.id, x: Math.round(v.x), y: Math.round(v.y), who: cl2.id });
        if (v.hp <= 0 && !v.broken){
          v.broken = true;
          /* the hoard: an orb shower anyone can loot, plus a cut for the cracker */
          const orbs = 4 + v.tier * 4;
          for (let i = 0; i < orbs; i++){
            const f = world.spawnFood('dna', v.x + rand(-30, 30), v.y + rand(-30, 30));
            f.vx = rand(-140, 140); f.vy = rand(-140, 140);
          }
          const cut = 10 + v.tier * 15;
          cl2.run.dna += cut;
          cl2.run.dnaTotal += cut;
          this.events.push({ e: 'vbreak', x: Math.round(v.x), y: Math.round(v.y), tier: v.tier, name: cl2.name, id: cl2.id, cut });
        }
      }
    }
    this.vaults = this.vaults.filter(v => !v.broken && v.age < 120);

    /* wildlife backfills the soup when humans are scarce; as real players
       arrive, the wild thins out and the humans ARE the ecosystem */
    const targetFauna = Math.max(10, 22 - 5 * Math.max(0, players.length - 1));
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
      const near = players.length && Math.random() < 0.35 ? pick(players) : null;
      if (near){
        const a = rand(0, TAU), d = rand(400, 1600);
        x = near.cell.x + Math.cos(a) * d;
        y = near.cell.y + Math.sin(a) * d;
        const wd = Math.hypot(x, y);
        /* out-of-bounds spawns scatter into random deep water — never
           pile up along the rim circle (no edge-riding conveyor belts) */
        if (wd > WORLD_R * 0.92){
          const a2 = Math.atan2(y, x);
          const d2 = WORLD_R * rand(0.55, 0.9);
          x = Math.cos(a2) * d2;
          y = Math.sin(a2) * d2;
        }
        /* and the personal food stream never waters the nursery — no camping farms */
        if (Math.hypot(x, y) < WORLD_R * 0.35){
          const a2 = Math.atan2(y, x) || rand(0, TAU);
          const d2 = WORLD_R * rand(0.37, 0.6);
          x = Math.cos(a2) * d2;
          y = Math.sin(a2) * d2;
        }
      } else {
        [x, y] = world.randomFoodSpot(0, 0, 0);
      }
      world.spawnFood(this.foodTypeAt(x, y), x, y);
    }

    world.update(dt);

    this.tickN++;
    if (this.tickN % 300 === 0) for (const cl of this.clients.values()) this.persistRun(cl);
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
        (c.genome.carn ? 1 : 0) | (c.genome.aggro ? 2 : 0) | (c.isPlayer ? 4 : 0) | (c.frenzy ? 8 : 0)
      ];
      if (c.client) row.push(c.client.name, c.client.run.gen, c.client.run.dnaTotal, c.client.lineage, c.client.trail || 0, c.client.shape || 0);
      return row;
    });
    const foodArr = world.food.map(f =>
      [f.id, FOOD_TYPES.indexOf(f.type), Math.round(f.x), Math.round(f.y), Math.round(f.r)]);
    const vaultArr = this.vaults.map(v =>
      [v.id, Math.round(v.x), Math.round(v.y), Math.round(v.r), Math.ceil(v.hp), v.maxHp, v.tier]);

    const snapObj = {
      t: 'snap', ts: Date.now(), cells: cellsArr, food: foodArr, vaults: vaultArr, ev: this.events.splice(0)
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
            need: cl.run.need, gen: cl.run.gen, cyst: cl.cyst || 0,
            frenzy: cl.frenzyUntil > Date.now() ? 1 : 0,
            slow: cl.slowed ? 1 : 0
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

