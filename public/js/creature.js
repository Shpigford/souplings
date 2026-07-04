/* ============================================================
   SOUPLINGS — Cell: physics, AI brain, procedural rendering
   ============================================================ */

class Cell {
  constructor({ x, y, r, genome, isPlayer }){
    this.x = x; this.y = y;
    this.vx = 0; this.vy = 0;
    this.r = r;
    this.dir = rand(0, TAU);
    this.genome = genome;
    this.isPlayer = !!isPlayer;
    this.recalc();
    this.hp = this.stats.maxHp;
    this.wobbleSeed = rand(0, 100);
    this.attackCd = 0;
    this.hurtT = 0;      // red flash after taking damage
    this.biteT = 0;      // jaw snap animation
    this.mouthT = 0;     // mouth-open animation
    this.dashT = 0;
    this.dashCdT = 0;
    this.iframes = 0;
    this.regenDelay = 0;
    this.alive = true;
    this.think = { t: rand(0, 0.4), mode: 'wander', tx: x, ty: y, target: null };
  }

  recalc(){ this.stats = deriveStats(this.genome, this.r, this.isPlayer); }

  steer(tx, ty, dt, throttle = 1){
    const dx = tx - this.x, dy = ty - this.y;
    const d = Math.hypot(dx, dy);
    const sp = this.stats.speed * (this.dashT > 0 ? 2.8 : 1) * (this.frenzy ? 1.15 : 1) * throttle;
    let dvx = 0, dvy = 0;
    if (d > 1){ dvx = dx / d * sp; dvy = dy / d * sp; }
    const k = this.stats.steerK * (this.dashT > 0 ? 2.2 : 1);
    this.vx = damp(this.vx, dvx, k, dt);
    this.vy = damp(this.vy, dvy, k, dt);
  }

  dash(){
    if (this.dashCdT > 0 || !this.alive) return false;
    this.dashT = 0.22;
    this.dashCdT = this.stats.dashCd;
    this.iframes = 0.3;
    return true;
  }

  takeDamage(amt, fromX, fromY){
    if (this.iframes > 0 || !this.alive) return 0;
    const dealt = amt * (1 - this.stats.armor);
    this.hp -= dealt;
    this.hurtT = 0.3;
    this.regenDelay = 4;
    /* short grace so pack attacks can't shred instantly */
    this.iframes = Math.max(this.iframes, 0.35);
    /* knockback away from attacker */
    const dx = this.x - fromX, dy = this.y - fromY;
    const d = Math.hypot(dx, dy) || 1;
    const kb = 180 * (dealt / this.stats.maxHp + 0.3);
    this.vx += dx / d * kb;
    this.vy += dy / d * kb;
    if (this.hp <= 0) this.alive = false;
    return dealt;
  }

  physics(dt, world){
    this.x += this.vx * dt;
    this.y += this.vy * dt;

    /* soft push back inside the tide pool */
    const d = Math.hypot(this.x, this.y);
    const limit = world.radius - this.r * 1.5;
    if (d > limit){
      const f = (d - limit) * 4;
      this.vx -= this.x / d * f * dt * 60 * 0.05;
      this.vy -= this.y / d * f * dt * 60 * 0.05;
    }

    /* big wild creatures prefer deep water — the central nursery stays gentle */
    if (!this.isPlayer && this.r > 30){
      const inner = world.radius * 0.38;
      if (d < inner && d > 1){
        const f = (1 - d / inner) * (this.r - 30) * 18;
        this.vx += this.x / d * f * dt;
        this.vy += this.y / d * f * dt;
      }
    }

    const sp = Math.hypot(this.vx, this.vy);
    if (sp > 12) this.dir = angleLerp(this.dir, Math.atan2(this.vy, this.vx), 1 - Math.exp(-8 * dt));

    this.attackCd  = Math.max(0, this.attackCd - dt);
    this.hurtT     = Math.max(0, this.hurtT - dt);
    this.biteT     = Math.max(0, this.biteT - dt);
    this.mouthT    = Math.max(0, this.mouthT - dt);
    this.dashT     = Math.max(0, this.dashT - dt);
    this.dashCdT   = Math.max(0, this.dashCdT - dt);
    this.iframes   = Math.max(0, this.iframes - dt);
    this.regenDelay = Math.max(0, this.regenDelay - dt);

    if (this.regenDelay <= 0 && this.hp < this.stats.maxHp){
      this.hp = Math.min(this.stats.maxHp, this.hp + (this.isPlayer ? 2.4 : 0.8) * dt);
    }
  }

  /* -------------------- AI -------------------- */

  aiUpdate(dt, world){
    this.think.t -= dt;
    if (this.think.t <= 0){
      this.think.t = rand(0.25, 0.45);
      this.plan(world);
    }
    const th = this.think;
    switch (th.mode){
      case 'flee':
        this.steer(th.tx, th.ty, dt, 1);
        break;
      case 'hunt': {
        const tgt = th.target;
        if (!tgt || !tgt.alive){ th.mode = 'wander'; break; }
        /* predators are lazy: a chase that drags on isn't worth it */
        th.huntT = (th.huntT || 0) + dt;
        /* big prey is worth the chase — and a starred line is never let go easily */
        const tlin = tgt.isPlayer && tgt.client ? Math.min(5, tgt.client.lineage || 0) : 0;
        const patience = (tgt.isPlayer && tgt.r > 60 ? 8 : 4.5) + 0.7 * tlin;
        if (th.huntT > patience){
          th.black = tgt;
          th.blackT = 9;
          th.huntT = 0;
          th.mode = 'wander';
          this.pickWanderPoint(world);
          break;
        }
        this.steer(tgt.x, tgt.y, dt, 0.85);
        break;
      }
      case 'seek': {
        const f = th.target;
        if (!f || f.dead){ th.mode = 'wander'; break; }
        this.steer(f.x, f.y, dt, 0.75);
        if (dist(this.x, this.y, f.x, f.y) < this.r * 2.5) this.mouthT = 0.3;
        break;
      }
      default: /* wander */
        if (dist(this.x, this.y, th.tx, th.ty) < this.r * 2) this.pickWanderPoint(world);
        this.steer(th.tx, th.ty, dt, 0.45);
    }
  }

  plan(world){
    const s = this.stats, th = this.think;
    th.blackT = Math.max(0, (th.blackT || 0) - 0.35);

    /* 1. flee anything big and mean */
    let threat = null, td = s.sense * 0.75;
    for (const c of world.cells){
      if (c === this || !c.alive) continue;
      if (c.r < this.r * 1.18) continue;
      const scary = c.genome.aggro ||
        (c.isPlayer && (c.genome.parts.jaw || c.genome.parts.spike || c.genome.parts.jelly));
      if (!scary) continue;
      const d = dist(this.x, this.y, c.x, c.y);
      if (d < td){ td = d; threat = c; }
    }
    if (threat){
      th.mode = 'flee';
      const dx = this.x - threat.x, dy = this.y - threat.y;
      const d = Math.hypot(dx, dy) || 1;
      th.tx = this.x + dx / d * 400;
      th.ty = this.y + dy / d * 400;
      return;
    }

    /* big wild creatures have no business in the central nursery */
    const nursery = this.r > 30 ? world.radius * 0.33 : 0;

    /* 2. hunt smaller cells if aggressive */
    if (this.genome.aggro){
      let prey = null, pd = Infinity;
      for (const c of world.cells){
        if (c === this || !c.alive) continue;
        /* the soup remembers a starred line: bolder against royalty,
           and gen IV+ drifters are scented from far beyond normal range */
        const lin = c.isPlayer && c.client ? Math.min(5, c.client.lineage || 0) : 0;
        const pgen = c.isPlayer && c.client && c.client.run ? c.client.run.gen : 0;
        const bold = Math.min(1.15, 0.85 + 0.06 * lin + (pgen >= 5 ? 0.15 : 0));
        if (c.r > this.r * bold) continue;
        if (c.isPlayer && c.r < NEWBIE_R) continue;        // newborn players are beneath notice
        if (c.iframes > 1) continue;                       // freshly spawned or encysted — not worth stalking
        if (th.blackT > 0 && c === th.black) continue;     // gave up on that one recently
        /* the nursery shelters only the small — grown campers are fair game */
        if (nursery && c.r < NEWBIE_R && Math.hypot(c.x, c.y) < nursery) continue;
        const d = dist(this.x, this.y, c.x, c.y);
        if (d > s.sense * (pgen >= 4 ? 1.5 : 1)) continue;
        if (d < pd){ pd = d; prey = c; }
      }
      if (prey){
        if (th.target !== prey) th.huntT = 0;
        th.mode = 'hunt';
        th.target = prey;
        return;
      }
    }

    /* 3. graze */
    let food = null, fd = s.sense;
    for (const f of world.food){
      if (f.dead) continue;
      const edible = this.genome.carn ? (f.type === 'meat') : (f.type === 'algae' || f.type === 'mote');
      if (!edible) continue;
      if (nursery && Math.hypot(f.x, f.y) < nursery) continue;
      const d = dist(this.x, this.y, f.x, f.y);
      if (d < fd){ fd = d; food = f; }
    }
    if (food){ th.mode = 'seek'; th.target = food; return; }

    if (th.mode !== 'wander') this.pickWanderPoint(world);
    th.mode = 'wander';
  }

  pickWanderPoint(world){
    const a = rand(0, TAU), d = rand(120, 420);
    let tx = this.x + Math.cos(a) * d;
    let ty = this.y + Math.sin(a) * d;
    const wd = Math.hypot(tx, ty);
    const lim = world.radius * 0.92;
    if (wd > lim){ tx *= lim / wd; ty *= lim / wd; }
    if (!this.isPlayer && this.r > 30){
      const min = world.radius * 0.4, dd = Math.hypot(tx, ty);
      if (dd < min){ const sc = min / (dd || 1); tx *= sc; ty *= sc; }
    }
    this.think.tx = tx;
    this.think.ty = ty;
  }
}

/* the egg: a mutated line hatches in front of everyone */
function drawEgg(ctx, c, t){
  const r = c.r * 1.15;
  const frac = clamp(1 - (c.hatchUntil - Date.now()) / 2200, 0, 1);   // 0 fresh -> 1 hatching
  drawGlow(ctx, c.x, c.y, r * 2.2, `hsla(${c.genome.hue},90%,70%,0.7)`, 0.25 + frac * 0.3);
  ctx.save();
  ctx.translate(c.x, c.y);
  ctx.rotate(Math.sin(t * (6 + frac * 14)) * 0.09 * (0.3 + frac));
  ctx.fillStyle = '#e8dcc3';
  ctx.beginPath();
  ctx.ellipse(0, 0, r * 0.82, r, 0, 0, TAU);
  ctx.fill();
  ctx.fillStyle = `hsla(${c.genome.hue},50%,55%,0.35)`;
  for (let i = 0; i < 7; i++){
    const a = i * 2.3 + 1, d = r * (0.2 + (i % 3) * 0.22);
    ctx.beginPath();
    ctx.arc(Math.cos(a) * d * 0.7, Math.sin(a) * d, r * 0.09, 0, TAU);
    ctx.fill();
  }
  if (frac > 0.35){
    ctx.strokeStyle = 'rgba(60,45,30,0.7)';
    ctx.lineWidth = Math.max(1.2, r * 0.035);
    ctx.beginPath();
    ctx.moveTo(-r * 0.4, -r * 0.3);
    ctx.lineTo(-r * 0.15, -r * 0.05);
    ctx.lineTo(-r * 0.3, r * 0.2);
    if (frac > 0.7){
      ctx.moveTo(r * 0.1, -r * 0.5);
      ctx.lineTo(r * 0.25, -r * 0.1);
      ctx.lineTo(r * 0.05, r * 0.15);
      ctx.lineTo(r * 0.3, r * 0.45);
    }
    ctx.stroke();
  }
  ctx.restore();
}

/* ============================================================
   rendering — shared by the world and the evolution preview
   ============================================================ */

/* seeded PRNG: one dynasty seed -> one creature, forever */
function mulberry32(a){
  return function(){
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let z = Math.imul(a ^ a >>> 15, 1 | a);
    z = z + Math.imul(z ^ z >>> 7, 61 | z) ^ z;
    return ((z ^ z >>> 14) >>> 0) / 4294967296;
  };
}

function genomeParams(seed, depth){
  const R = mulberry32(seed);
  const gp = { depth };
  gp.harm = Array.from({ length: 3 }, () => ({
    f: 2 + Math.floor(R() * 6), amp: 0.025 + R() * 0.075, ph: R() * TAU, sp: 0.6 + R() * 2
  }));
  gp.hue2 = R() * 360;
  gp.freck = Array.from({ length: 5 + Math.floor(R() * 9) }, () => ({
    a: R() * TAU, d: 0.2 + R() * 0.65, r: 0.02 + R() * 0.05, tw: R() * TAU
  }));
  gp.apps = Array.from({ length: Math.min(6, 1 + Math.floor(R() * 3) + depth) }, () => ({
    a: R() * TAU, len: 0.5 + R() * 1.1, wav: 1 + R() * 4, w: 0.03 + R() * 0.05,
    tip: Math.floor(R() * 3), th: R() * TAU
  }));
  gp.sat = depth >= 5 ? { d: 1.7 + R() * 0.5, r: 0.16 + R() * 0.1, sp: 0.5 + R() * 1.2, h: R() * 360 } : null;
  return gp;
}

function drawCreature(ctx, c, t){
  if (c.hatchUntil > Date.now()){ drawEgg(ctx, c, t); return; }
  const g = c.genome, p = g.parts, s = c.stats;
  const h = g.hue;
  const lvl = k => p[k] || 0;
  const sp = Math.hypot(c.vx, c.vy);
  const squash = clamp(sp / (s.speed || 1), 0, 1) * 0.16;
  const seed = c.wobbleSeed;

  /* bioluminescent halo */
  drawGlow(ctx, c.x, c.y, c.r * 2.7, `hsla(${h},90%,65%,0.8)`, c.dashT > 0 ? 0.55 : 0.32);

  ctx.save();
  ctx.translate(c.x, c.y);
  ctx.rotate(c.dir);
  if (c.pokeT > 0) ctx.rotate(Math.sin(t * 30) * 0.07 * clamp(c.pokeT / 0.3, 0, 1));
  if (c.iframes > 0) ctx.globalAlpha = 0.55 + 0.45 * Math.sin(t * 42);

  const r = c.r;
  const memLvl = lvl('membrane');
  let gp = null;
  if (c.dseed){
    const depth = Math.min(6, c.lineage || 0);
    if (!c._gp || c._gpKey !== c.dseed + '/' + depth){
      c._gp = genomeParams(c.dseed, depth);
      c._gpKey = c.dseed + '/' + depth;
    }
    gp = c._gp;
  }
  const mut = c.mut || 0;
  const mPat = mut & 7, mCrest = (mut >> 3) & 7, mEyes = (mut >> 6) & 7, mAcc = (mut >> 9) & 7;

  /* ---- membrane blob points ---- */
  const N = 16, pts = [];
  for (let i = 0; i < N; i++){
    const a = i / N * TAU;
    let rr;
    if (gp){
      rr = 1;
      for (const hm of gp.harm) rr += hm.amp * Math.sin(hm.f * a + t * hm.sp + hm.ph + seed);
      rr *= r;
    } else {
      rr = r * (1
        + 0.05 * Math.sin(3 * a + t * 2.1 + seed)
        + 0.035 * Math.sin(5 * a - t * 1.6 + seed * 2));
    }
    pts.push([Math.cos(a) * rr * (1 + squash), Math.sin(a) * rr * (1 - squash * 0.55)]);
  }

  /* ---- flagella (behind body) ---- */
  const flag = lvl('flagellum');
  if (flag > 0){
    ctx.strokeStyle = `hsla(${h},80%,72%,0.85)`;
    ctx.lineCap = 'round';
    const offsets = flag === 1 ? [0] : flag === 2 ? [-0.35, 0.35] : [-0.5, 0, 0.5];
    const wave = 0.5 + clamp(sp / (s.speed || 1), 0, 1);
    for (let f = 0; f < offsets.length; f++){
      const oy = offsets[f] * r;
      ctx.lineWidth = r * 0.09;
      ctx.beginPath();
      ctx.moveTo(-r * 0.9, oy);
      const segs = 8, len = r * 1.5;
      for (let i = 1; i <= segs; i++){
        const fr = i / segs;
        const wx = -r * 0.9 - fr * len;
        const wy = oy + Math.sin(t * 9 - i * 0.95 + f * 2 + seed) * r * 0.22 * fr * wave;
        ctx.lineTo(wx, wy);
      }
      ctx.stroke();
    }
  }

  /* ---- cilia fringe ---- */
  const cil = lvl('cilia');
  if (cil > 0){
    ctx.strokeStyle = `hsla(${h},75%,78%,0.5)`;
    ctx.lineWidth = Math.max(0.8, r * 0.03);
    ctx.lineCap = 'round';
    const n = 10 + cil * 7;
    ctx.beginPath();
    for (let i = 0; i < n; i++){
      const a = i / n * TAU;
      const rr = r * 1.02;
      const hair = r * 0.17;
      const wig = Math.sin(t * 6 + a * 4 + seed) * 0.5;
      const bx = Math.cos(a) * rr * (1 + squash), by = Math.sin(a) * rr * (1 - squash * 0.55);
      ctx.moveTo(bx, by);
      ctx.lineTo(bx + Math.cos(a + wig) * hair, by + Math.sin(a + wig) * hair);
    }
    ctx.stroke();
  }

  /* ---- spines (under membrane edge) ---- */
  const spk = lvl('spike');
  if (spk > 0){
    ctx.fillStyle = `hsla(${h},70%,80%,0.9)`;
    const count = 2 + spk * 2;
    for (let i = 0; i < count; i++){
      /* fan across the sides & back, keep the face clear */
      const a = 0.6 + (i / (count - 1)) * (TAU - 1.2);
      const len = r * (0.28 + 0.09 * spk);
      const bw = r * 0.14;
      const bx = Math.cos(a) * r * 0.96, by = Math.sin(a) * r * 0.96;
      ctx.save();
      ctx.translate(bx, by);
      ctx.rotate(a);
      ctx.beginPath();
      ctx.moveTo(0, -bw / 2);
      ctx.lineTo(len, 0);
      ctx.lineTo(0, bw / 2);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }

  /* ---- body ---- */
  blobPath(ctx, pts);
  if (gp){
    const grad = ctx.createRadialGradient(-r * 0.2, -r * 0.2, r * 0.1, 0, 0, r * 1.1);
    grad.addColorStop(0, `hsla(${gp.hue2},70%,62%,0.22)`);
    grad.addColorStop(1, `hsla(${h},65%,55%,0.15)`);
    ctx.fillStyle = grad;
  } else {
    ctx.fillStyle = `hsla(${h},65%,55%,0.16)`;
  }
  ctx.fill();
  ctx.strokeStyle = `hsla(${h},85%,72%,0.95)`;
  ctx.lineWidth = r * 0.055 * (1 + 0.45 * memLvl);
  ctx.stroke();
  if (memLvl > 0){
    ctx.strokeStyle = `hsla(${h},85%,72%,0.25)`;
    ctx.lineWidth = r * 0.16;
    ctx.stroke();
  }

  /* ---- mutation pattern, clipped to the body ---- */
  if (mPat){
    const ph = (h + 45) % 360;
    ctx.save();
    blobPath(ctx, pts);
    ctx.clip();
    if (mPat === 1){
      ctx.fillStyle = `hsla(${ph},70%,68%,0.32)`;
      for (let i = 0; i < 6; i++){
        const a = seed * 5 + i * 1.9, d = r * (0.25 + (i % 3) * 0.22);
        ctx.beginPath();
        ctx.ellipse(Math.cos(a) * d, Math.sin(a) * d, r * 0.16, r * 0.13, a, 0, TAU);
        ctx.fill();
      }
    } else if (mPat === 2){
      ctx.strokeStyle = `hsla(${ph},70%,68%,0.34)`;
      ctx.lineWidth = r * 0.13;
      for (let i = -2; i <= 2; i++){
        ctx.beginPath();
        ctx.moveTo(i * r * 0.42 - r * 0.5, -r * 1.1);
        ctx.quadraticCurveTo(i * r * 0.42 + r * 0.25, 0, i * r * 0.42 - r * 0.5, r * 1.1);
        ctx.stroke();
      }
    } else if (mPat === 3){
      ctx.strokeStyle = `hsla(${ph},70%,68%,0.3)`;
      ctx.lineWidth = r * 0.09;
      for (const rr of [0.42, 0.72]){
        ctx.beginPath(); ctx.arc(0, 0, r * rr, 0, TAU); ctx.stroke();
      }
    } else if (mPat === 4){
      ctx.fillStyle = `hsla(${ph},95%,80%,0.55)`;
      for (let i = 0; i < 13; i++){
        const a = seed * 7 + i * 2.4, d = r * (0.2 + ((i * 37) % 60) / 100);
        ctx.beginPath();
        ctx.arc(Math.cos(a) * d, Math.sin(a) * d, r * 0.045, 0, TAU);
        ctx.fill();
      }
    } else if (mPat === 5){
      ctx.fillStyle = `hsla(${ph},60%,60%,0.3)`;
      ctx.beginPath();
      ctx.ellipse(-r * 0.45, -r * 0.3, r * 0.75, r * 0.6, 0.7 + seed, 0, TAU);
      ctx.fill();
    } else if (mPat === 6){
      ctx.strokeStyle = `hsla(${ph},95%,75%,0.4)`;
      ctx.lineWidth = r * 0.05;
      for (let i = 0; i < 6; i++){
        const a = i / 6 * TAU + seed;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * r * 0.15, Math.sin(a) * r * 0.15);
        ctx.quadraticCurveTo(Math.cos(a + 0.4) * r * 0.55, Math.sin(a + 0.4) * r * 0.55,
          Math.cos(a) * r * 0.95, Math.sin(a) * r * 0.95);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  /* ---- the dynasty's own constellation & limbs ---- */
  if (gp){
    ctx.fillStyle = `hsla(${gp.hue2},95%,78%,0.6)`;
    for (const f2 of gp.freck){
      const tw = 0.55 + 0.45 * Math.sin(t * 2.4 + f2.tw);
      ctx.beginPath();
      ctx.arc(Math.cos(f2.a) * r * f2.d, Math.sin(f2.a) * r * f2.d, r * f2.r * tw, 0, TAU);
      ctx.fill();
    }
    ctx.lineCap = 'round';
    for (const ap of gp.apps){
      ctx.strokeStyle = `hsla(${gp.hue2},75%,70%,0.75)`;
      ctx.lineWidth = Math.max(1, r * ap.w);
      const bx = Math.cos(ap.a) * r * 0.95, by = Math.sin(ap.a) * r * 0.95;
      const wig = Math.sin(t * ap.wav + ap.th) * 0.5;
      const tx2 = Math.cos(ap.a + wig * 0.4) * r * (0.95 + ap.len);
      const ty2 = Math.sin(ap.a + wig * 0.4) * r * (0.95 + ap.len);
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.quadraticCurveTo(
        Math.cos(ap.a - wig * 0.3) * r * (0.95 + ap.len * 0.5),
        Math.sin(ap.a - wig * 0.3) * r * (0.95 + ap.len * 0.5),
        tx2, ty2);
      ctx.stroke();
      if (ap.tip === 1){
        ctx.fillStyle = `hsla(${gp.hue2},100%,80%,0.9)`;
        ctx.beginPath(); ctx.arc(tx2, ty2, Math.max(1.5, r * 0.06), 0, TAU); ctx.fill();
      } else if (ap.tip === 2){
        ctx.strokeStyle = `hsla(${gp.hue2},90%,80%,0.8)`;
        ctx.beginPath();
        ctx.moveTo(tx2, ty2);
        ctx.lineTo(tx2 + Math.cos(ap.a + 0.5) * r * 0.14, ty2 + Math.sin(ap.a + 0.5) * r * 0.14);
        ctx.moveTo(tx2, ty2);
        ctx.lineTo(tx2 + Math.cos(ap.a - 0.5) * r * 0.14, ty2 + Math.sin(ap.a - 0.5) * r * 0.14);
        ctx.stroke();
      }
    }
    if (gp.sat){
      const sa = t * gp.sat.sp + seed;
      const sx = Math.cos(sa) * r * gp.sat.d, sy = Math.sin(sa) * r * gp.sat.d * 0.8;
      drawGlow(ctx, sx, sy, r * gp.sat.r * 3, `hsla(${gp.sat.h},95%,70%,0.8)`, 0.5);
      ctx.fillStyle = `hsla(${gp.sat.h},80%,68%,0.85)`;
      ctx.beginPath();
      ctx.arc(sx, sy, r * gp.sat.r, 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#0a1c26';
      ctx.beginPath();
      ctx.arc(sx + r * gp.sat.r * 0.25, sy, r * gp.sat.r * 0.3, 0, TAU);
      ctx.fill();
    }
  }

  /* ---- nucleus & organelles ---- */
  ctx.fillStyle = `hsla(${h},60%,75%,0.3)`;
  ctx.beginPath();
  ctx.ellipse(-r * 0.18, r * 0.06, r * 0.3, r * 0.26, seed, 0, TAU);
  ctx.fill();
  ctx.fillStyle = `hsla(${h},60%,80%,0.22)`;
  for (let i = 0; i < 3; i++){
    const oa = seed * 3 + i * 2.1 + t * 0.35;
    ctx.beginPath();
    ctx.arc(Math.cos(oa) * r * 0.45, Math.sin(oa) * r * 0.4, r * 0.08, 0, TAU);
    ctx.fill();
  }

  /* ---- mouth ---- */
  const jaw = lvl('jaw'), filt = lvl('filter');
  const mouthOpen = clamp(c.mouthT / 0.35, 0, 1);
  if (jaw > 0){
    const snap = c.biteT > 0 ? Math.sin(c.biteT / 0.25 * Math.PI) : mouthOpen * 0.6;
    const open = 0.22 + snap * 0.55;
    ctx.strokeStyle = `hsla(${h},70%,85%,0.95)`;
    ctx.lineWidth = r * 0.08;
    ctx.lineCap = 'round';
    const jl = r * (0.32 + 0.1 * jaw);
    for (const sgn of [-1, 1]){
      ctx.beginPath();
      ctx.moveTo(r * 0.82, sgn * r * 0.16);
      const a = sgn * open;
      ctx.quadraticCurveTo(
        r * 0.82 + Math.cos(a) * jl * 0.6, sgn * r * 0.16 + Math.sin(a) * jl * 0.6,
        r * 0.82 + Math.cos(a * 1.6) * jl, sgn * r * 0.16 + Math.sin(a * 1.6) * jl * 1.4
      );
      ctx.stroke();
    }
  } else if (filt > 0){
    const fw = r * (0.3 + 0.07 * filt);
    ctx.fillStyle = 'rgba(4,14,20,0.55)';
    ctx.beginPath();
    ctx.ellipse(r * 0.8, 0, r * 0.16 * (0.6 + mouthOpen * 0.7), fw, 0, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = `hsla(${h},70%,85%,0.6)`;
    ctx.lineWidth = Math.max(0.8, r * 0.025);
    ctx.beginPath();
    for (let i = -1; i <= 1; i++){
      ctx.moveTo(r * 0.72, i * fw * 0.45);
      ctx.lineTo(r * 0.88, i * fw * 0.45);
    }
    ctx.stroke();
  } else {
    ctx.strokeStyle = 'rgba(4,14,20,0.6)';
    ctx.lineWidth = r * 0.05;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(r * 0.62, 0, r * 0.16, -0.6 - mouthOpen, 0.6 + mouthOpen);
    ctx.stroke();
  }

  /* ---- eyes (everyone gets a pair; ocelli make them grand) ---- */
  const eye = lvl('eye');
  let er = r * (0.12 + eye * 0.035);
  if (c.pokeT > 0) er *= 1.3;   /* poked: eyes go wide */
  let blink = c.pokeT > 0 ? 1 : (((t * 0.35 + seed) % 2.7) < 0.07 ? 0.15 : 1);
  let spots = [[r * 0.38, -r * 0.34], [r * 0.38, r * 0.34]];
  if (eye >= 2) spots.push([r * 0.55, 0]);
  if (mEyes === 1){
    /* stalked: eyes wave on stems above the brow */
    ctx.strokeStyle = `hsla(${h},80%,72%,0.9)`;
    ctx.lineWidth = r * 0.06;
    spots = [];
    for (const sgn of [-1, 1]){
      const wob = Math.sin(t * 3 + seed + sgn) * 0.25;
      const tipX = r * (0.55 + wob * 0.2), tipY = sgn * r * 0.55 - r * 0.35 * 0;
      const bx = r * 0.3, by = sgn * r * 0.3;
      const tx2 = r * 0.6 + wob * r * 0.15, ty2 = sgn * (r * 0.62);
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.quadraticCurveTo(r * 0.55, sgn * r * 0.5, tx2, ty2);
      ctx.stroke();
      spots.push([tx2, ty2]);
    }
  } else if (mEyes === 2){
    spots = [[r * 0.42, 0]];
    er *= 1.9;
  } else if (mEyes === 3){
    spots = [[r * 0.38, -r * 0.38], [r * 0.38, r * 0.38], [r * 0.52, 0]];
  } else if (mEyes === 4){
    blink = Math.min(blink, 0.55);   /* permanently drowsy */
  }
  const px = Math.cos(Math.sin(t * 0.7 + seed)) * er * 0.28 + er * 0.2;
  for (const [ex, ey] of spots){
    ctx.fillStyle = '#f4fff9';
    ctx.beginPath();
    ctx.ellipse(ex, ey, er, er * blink, 0, 0, TAU);
    ctx.fill();
    if (blink > 0.5){
      ctx.fillStyle = '#0a1c26';
      ctx.beginPath();
      ctx.arc(ex + px, ey + Math.sin(t * 0.9 + seed) * er * 0.2, er * 0.52, 0, TAU);
      ctx.fill();
      if (mEyes === 5){
        /* star pupils */
        ctx.fillStyle = '#ffe9a8';
        const cxp = ex + px, cyp = ey;
        ctx.beginPath();
        for (let k2 = 0; k2 < 10; k2++){
          const aa = k2 / 10 * TAU - Math.PI / 2 + t * 0.6;
          const rr2 = (k2 % 2 ? 0.16 : 0.4) * er;
          const pxx = cxp + Math.cos(aa) * rr2, pyy = cyp + Math.sin(aa) * rr2;
          k2 ? ctx.lineTo(pxx, pyy) : ctx.moveTo(pxx, pyy);
        }
        ctx.closePath(); ctx.fill();
      }
    }
  }

  /* ---- mutation crest ---- */
  if (mCrest === 1){
    ctx.strokeStyle = `hsla(${h},80%,75%,0.9)`;
    ctx.lineWidth = r * 0.05;
    for (const sgn of [-1, 1]){
      const wag = Math.sin(t * 4 + seed + sgn * 2) * 0.2;
      ctx.beginPath();
      ctx.moveTo(r * 0.15, sgn * r * 0.2 * 0 - sgn * r * 0.15);
      ctx.quadraticCurveTo(r * 0.7, -sgn * r * 0.7, r * (0.95 + wag), -sgn * r * (0.95 - wag * 0.5));
      ctx.stroke();
      ctx.fillStyle = `hsla(${(h + 45) % 360},100%,80%,0.9)`;
      ctx.beginPath();
      ctx.arc(r * (0.95 + wag), -sgn * r * (0.95 - wag * 0.5), r * 0.08, 0, TAU);
      ctx.fill();
    }
  } else if (mCrest === 2){
    ctx.fillStyle = `hsla(${(h + 45) % 360},70%,65%,0.5)`;
    for (let i = 0; i < 6; i++){
      const a = Math.PI * 0.55 + i / 5 * Math.PI * 0.9;
      const wob = 1 + 0.12 * Math.sin(t * 2.5 + i + seed);
      ctx.beginPath();
      ctx.ellipse(Math.cos(a) * r * 1.02, Math.sin(a) * r * 1.02, r * 0.22 * wob, r * 0.12, a, 0, TAU);
      ctx.fill();
    }
  } else if (mCrest === 3){
    ctx.fillStyle = `hsla(${(h + 45) % 360},70%,68%,0.55)`;
    for (let i = -2; i <= 2; i++){
      const a = Math.PI + i * 0.24;
      const fl = 1 + 0.15 * Math.sin(t * 5 + i);
      ctx.save();
      ctx.translate(Math.cos(a) * r * 0.95, Math.sin(a) * r * 0.95);
      ctx.rotate(a);
      ctx.beginPath();
      ctx.moveTo(0, -r * 0.07);
      ctx.lineTo(r * 0.5 * fl, 0);
      ctx.lineTo(0, r * 0.07);
      ctx.closePath(); ctx.fill();
      ctx.restore();
    }
  } else if (mCrest === 4){
    ctx.strokeStyle = `hsla(${h},70%,70%,0.7)`;
    ctx.lineWidth = r * 0.05;
    ctx.lineCap = 'round';
    for (let i = 0; i < 3; i++){
      const bx = -r * 0.2 + i * r * 0.25;
      ctx.beginPath();
      ctx.moveTo(bx, r * 0.9);
      ctx.quadraticCurveTo(bx + Math.sin(t * 3 + i + seed) * r * 0.25, r * 1.3, bx - Math.sin(t * 2 + i) * r * 0.2, r * 1.55);
      ctx.stroke();
    }
  } else if (mCrest === 5){
    ctx.fillStyle = 'rgba(244,255,249,0.85)';
    for (const sgn of [-1, 1]){
      ctx.save();
      ctx.translate(r * 0.25, sgn * r * 0.55);
      ctx.rotate(sgn * 0.8);
      ctx.beginPath();
      ctx.moveTo(-r * 0.08, 0);
      ctx.lineTo(0, -r * 0.38);
      ctx.lineTo(r * 0.08, 0);
      ctx.closePath(); ctx.fill();
      ctx.restore();
    }
  } else if (mCrest === 6){
    ctx.strokeStyle = 'rgba(58,42,33,0.85)';
    ctx.lineWidth = r * 0.07;
    ctx.lineCap = 'round';
    for (const sgn of [-1, 1]){
      ctx.beginPath();
      ctx.moveTo(r * 0.52, sgn * r * 0.06);
      ctx.quadraticCurveTo(r * 0.72, sgn * r * 0.22, r * 0.62, sgn * r * 0.42);
      ctx.stroke();
    }
  }

  /* ---- mutation accent ---- */
  if (mAcc === 1){
    ctx.fillStyle = 'rgba(255,240,200,0.9)';
    for (let i = 0; i < 4; i++){
      const a = t * 1.2 + i * TAU / 4 + seed;
      const d = r * 1.25, tw = 0.5 + 0.5 * Math.sin(t * 5 + i * 2);
      const xx = Math.cos(a) * d, yy = Math.sin(a) * d * 0.8;
      ctx.save(); ctx.translate(xx, yy); ctx.scale(tw, tw);
      ctx.beginPath();
      ctx.moveTo(0, -r * 0.09); ctx.lineTo(r * 0.025, -r * 0.025); ctx.lineTo(r * 0.09, 0);
      ctx.lineTo(r * 0.025, r * 0.025); ctx.lineTo(0, r * 0.09); ctx.lineTo(-r * 0.025, r * 0.025);
      ctx.lineTo(-r * 0.09, 0); ctx.lineTo(-r * 0.025, -r * 0.025);
      ctx.closePath(); ctx.fill();
      ctx.restore();
    }
  } else if (mAcc === 2){
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = r * 0.08;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.72, -2.4, -1.4);
    ctx.stroke();
  } else if (mAcc === 3){
    ctx.fillStyle = 'rgba(220,255,250,0.14)';
    blobPath(ctx, pts);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = r * 0.02;
    ctx.stroke();
  } else if (mAcc === 4){
    drawGlow(ctx, 0, 0, r * 2.2, `hsla(${(t * 50) % 360},90%,65%,0.75)`, 0.3);
  }

  /* ---- biolume gland ---- */
  if (lvl('gland') > 0){
    const pulse = 0.6 + 0.4 * Math.sin(t * 3 + seed);
    ctx.fillStyle = `hsla(${h},100%,85%,${0.7 * pulse})`;
    ctx.beginPath();
    ctx.arc(-r * 0.1, -r * 0.52, r * 0.11, 0, TAU);
    ctx.fill();
  }

  /* ---- ink sac: a pocket of night ---- */
  if (lvl('ink') > 0){
    ctx.fillStyle = 'rgba(8,12,20,0.85)';
    ctx.beginPath();
    ctx.ellipse(-r * 0.38, -r * 0.22, r * 0.17, r * 0.13, 0.5, 0, TAU);
    ctx.fill();
    ctx.fillStyle = 'rgba(120,160,200,0.25)';
    ctx.beginPath();
    ctx.arc(-r * 0.42, -r * 0.27, r * 0.045, 0, TAU);
    ctx.fill();
  }

  /* ---- volt organ: crackling arcs ---- */
  const voltLvl = lvl('volt');
  if (voltLvl > 0){
    const buzz = 0.5 + 0.5 * Math.sin(t * 11 + seed * 3);
    ctx.strokeStyle = `rgba(170,220,255,${0.45 + 0.5 * buzz})`;
    ctx.lineWidth = Math.max(1, r * 0.035);
    ctx.lineCap = 'round';
    for (let v = 0; v < voltLvl; v++){
      const bx = r * 0.05 - v * r * 0.35, by = -r * 0.42 + v * r * 0.15;
      const s2 = r * 0.13;
      ctx.beginPath();
      ctx.moveTo(bx - s2, by - s2);
      ctx.lineTo(bx + s2 * 0.3, by - s2 * 0.2);
      ctx.lineTo(bx - s2 * 0.3, by + s2 * 0.2);
      ctx.lineTo(bx + s2, by + s2);
      ctx.stroke();
    }
  }

  /* ---- ancestral helix: gold memory coiled beside the nucleus ---- */
  if (lvl('helix') > 0){
    ctx.strokeStyle = `rgba(255,214,107,${0.55 + 0.2 * Math.sin(t * 2.2 + seed)})`;
    ctx.lineWidth = Math.max(1, r * 0.03);
    ctx.lineCap = 'round';
    const hx = r * 0.28, hy = r * 0.28, hl = r * 0.34;
    for (const ph of [0, Math.PI]){
      ctx.beginPath();
      for (let i = 0; i <= 8; i++){
        const yy = hy - hl / 2 + (i / 8) * hl;
        const xx = hx + Math.sin(i / 8 * TAU + ph + t) * r * 0.09;
        i ? ctx.lineTo(xx, yy) : ctx.moveTo(xx, yy);
      }
      ctx.stroke();
    }
  }

  /* ---- crown jelly: a royal shimmer around the whole membrane ---- */
  if (lvl('jelly') > 0){
    blobPath(ctx, pts);
    ctx.strokeStyle = `rgba(255,214,107,${0.3 + 0.15 * Math.sin(t * 1.7 + seed)})`;
    ctx.lineWidth = r * 0.14;
    ctx.stroke();
  }

  /* ---- osmotic core: a hungry ring around the nucleus ---- */
  if (lvl('osmo') > 0){
    ctx.strokeStyle = `hsla(${h},85%,82%,${0.3 + 0.15 * Math.sin(t * 2 + seed)})`;
    ctx.lineWidth = Math.max(1, r * 0.03);
    ctx.setLineDash([r * 0.12, r * 0.09]);
    ctx.beginPath();
    ctx.arc(-r * 0.15, r * 0.05, r * 0.4, t * 0.4 + seed, t * 0.4 + seed + TAU);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  /* ---- hurt flash ---- */
  if (c.hurtT > 0){
    blobPath(ctx, pts);
    ctx.fillStyle = `rgba(255,96,70,${(c.hurtT / 0.3) * 0.45})`;
    ctx.fill();
  }

  ctx.restore();

  if (c.genome.parts.gland){
    drawGlow(ctx, c.x, c.y, c.r * 3.4, `hsla(${h},100%,80%,0.8)`, 0.14 + 0.08 * Math.sin(t * 3 + seed));
  }
  if (c.genome.parts.jelly){
    drawGlow(ctx, c.x, c.y, c.r * 3.6, 'hsla(45,100%,70%,0.8)', 0.12 + 0.06 * Math.sin(t * 1.7 + seed));
  }
  if (c.frenzied){
    drawGlow(ctx, c.x, c.y, c.r * 3.3, 'hsla(48,100%,68%,0.85)', 0.28 + 0.14 * Math.sin(t * 9 + seed));
  }
}
