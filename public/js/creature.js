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
    const sp = this.stats.speed * (this.dashT > 0 ? 2.8 : 1) * throttle;
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
        if (th.huntT > 4.5){
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
      let prey = null, pd = s.sense;
      for (const c of world.cells){
        if (c === this || !c.alive) continue;
        if (c.r > this.r * 0.85) continue;
        if (c.isPlayer && c.r < NEWBIE_R) continue;        // newborn players are beneath notice
        if (c.iframes > 1) continue;                       // freshly spawned or encysted — not worth stalking
        if (th.blackT > 0 && c === th.black) continue;     // gave up on that one recently
        /* the nursery shelters only the small — grown campers are fair game */
        if (nursery && c.r < NEWBIE_R && Math.hypot(c.x, c.y) < nursery) continue;
        const d = dist(this.x, this.y, c.x, c.y);
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

/* ============================================================
   rendering — shared by the world and the evolution preview
   ============================================================ */

function drawCreature(ctx, c, t){
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
  if (c.iframes > 0) ctx.globalAlpha = 0.55 + 0.45 * Math.sin(t * 42);

  const r = c.r;
  const memLvl = lvl('membrane');

  /* ---- membrane blob points ---- */
  const N = 16, pts = [];
  for (let i = 0; i < N; i++){
    const a = i / N * TAU;
    const rr = r * (1
      + 0.05 * Math.sin(3 * a + t * 2.1 + seed)
      + 0.035 * Math.sin(5 * a - t * 1.6 + seed * 2));
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
  ctx.fillStyle = `hsla(${h},65%,55%,0.16)`;
  ctx.fill();
  ctx.strokeStyle = `hsla(${h},85%,72%,0.95)`;
  ctx.lineWidth = r * 0.055 * (1 + 0.45 * memLvl);
  ctx.stroke();
  if (memLvl > 0){
    ctx.strokeStyle = `hsla(${h},85%,72%,0.25)`;
    ctx.lineWidth = r * 0.16;
    ctx.stroke();
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
  const er = r * (0.12 + eye * 0.035);
  const blink = ((t * 0.35 + seed) % 2.7) < 0.07 ? 0.15 : 1;
  const spots = [[r * 0.38, -r * 0.34], [r * 0.38, r * 0.34]];
  if (eye >= 2) spots.push([r * 0.55, 0]);
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
    }
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
}
