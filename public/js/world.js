/* ============================================================
   SOUPLINGS — World: food, hazards, particles, atmosphere
   ============================================================ */

const FOOD_DEF = {
  mote:  { dna: 1, mass: 2 },
  algae: { dna: 2, mass: 7 },
  meat:  { dna: 4, mass: 10 },
  dna:   { dna: 8, mass: 0 },
  gold:  { dna: 60, mass: 30 }
};

/* screen-space depth layers, shared by every world */
const Backdrop = {
  tile: 1400,
  layers: null,
  grad: null, gradW: 0, gradH: 0,
  vig: null,

  init(){
    if (this.layers) return;
    this.layers = [0.22, 0.45].map((f, li) => {
      const pts = [];
      for (let i = 0; i < 70; i++){
        pts.push({ x: rand(0, this.tile), y: rand(0, this.tile), r: rand(0.7, 2.4 + li), a: rand(0.04, 0.13) });
      }
      return { f, pts };
    });
  },

  ensureGrad(w, h){
    if (this.grad && this.gradW === w && this.gradH === h) return;
    this.gradW = w; this.gradH = h;
    const c = document.createElement('canvas');
    c.width = Math.max(2, Math.floor(w / 4));
    c.height = Math.max(2, Math.floor(h / 4));
    const g = c.getContext('2d');
    const gr = g.createLinearGradient(0, 0, 0, c.height);
    gr.addColorStop(0, '#0c3140');
    gr.addColorStop(0.45, '#082433');
    gr.addColorStop(1, '#030e17');
    g.fillStyle = gr;
    g.fillRect(0, 0, c.width, c.height);
    this.grad = c;

    const v = document.createElement('canvas');
    v.width = Math.max(2, Math.floor(w / 4));
    v.height = Math.max(2, Math.floor(h / 4));
    const vg = v.getContext('2d');
    const vgr = vg.createRadialGradient(v.width/2, v.height/2, Math.min(v.width, v.height) * 0.35, v.width/2, v.height/2, Math.max(v.width, v.height) * 0.72);
    vgr.addColorStop(0, 'rgba(2,8,14,0)');
    vgr.addColorStop(1, 'rgba(2,8,14,0.55)');
    vg.fillStyle = vgr;
    vg.fillRect(0, 0, v.width, v.height);
    this.vig = v;
  },

  draw(ctx, w, h, cam, t){
    this.init();
    this.ensureGrad(w, h);
    ctx.drawImage(this.grad, 0, 0, w, h);

    /* god rays swaying from the surface */
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 3; i++){
      const bx = w * (0.2 + i * 0.3) + Math.sin(t * 0.05 + i * 2.1) * 80 - cam.x * 0.04 % w;
      const sway = Math.sin(t * 0.07 + i) * 0.12;
      ctx.save();
      ctx.translate(bx, -60);
      ctx.rotate(0.18 + sway);
      const rw = 90 + i * 50;
      const gr = ctx.createLinearGradient(0, 0, 0, h * 1.1);
      gr.addColorStop(0, 'rgba(120,220,200,0.05)');
      gr.addColorStop(1, 'rgba(120,220,200,0)');
      ctx.fillStyle = gr;
      ctx.beginPath();
      ctx.moveTo(-rw / 2, 0);
      ctx.lineTo(rw / 2, 0);
      ctx.lineTo(rw * 1.6, h * 1.15);
      ctx.lineTo(-rw * 1.6, h * 1.15);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();

    /* parallax motes — cheap depth */
    const T = this.tile;
    ctx.fillStyle = '#bfe9dc';
    for (const layer of this.layers){
      const ox = ((-cam.x * layer.f) % T + T) % T;
      const oy = ((-cam.y * layer.f) % T + T) % T;
      const cols = Math.ceil(w / T) + 1, rows = Math.ceil(h / T) + 1;
      for (const p of layer.pts){
        for (let cx = -1; cx < cols; cx++){
          for (let cy = -1; cy < rows; cy++){
            const sx = p.x + ox + cx * T, sy = p.y + oy + cy * T;
            if (sx < -4 || sx > w + 4 || sy < -4 || sy > h + 4) continue;
            ctx.globalAlpha = p.a;
            ctx.beginPath();
            ctx.arc(sx, sy, p.r, 0, TAU);
            ctx.fill();
          }
        }
      }
    }
    ctx.globalAlpha = 1;
  },

  vignette(ctx, w, h){
    if (this.vig) ctx.drawImage(this.vig, 0, 0, w, h);
  }
};

class World {
  constructor(radius){
    this.radius = radius;
    this.cells = [];
    this.food = [];
    this.particles = [];
    this.hazards = [];
  }

  /* -------------------- spawning -------------------- */

  spawnFood(type, x, y){
    const def = FOOD_DEF[type];
    const f = {
      type, x, y,
      r: type === 'mote' ? rand(2, 3) : type === 'algae' ? rand(5, 8) : type === 'meat' ? rand(6, 10) : type === 'gold' ? 9 : 4,
      vx: rand(-6, 6), vy: rand(-6, 6),
      seed: rand(0, 100),
      dna: def.dna, mass: def.mass,
      decay: type === 'meat' ? 24 : type === 'dna' ? 22 : Infinity,
      dead: false
    };
    this.food.push(f);
    return f;
  }

  scatterFood(type, cx, cy, n, spread){
    for (let i = 0; i < n; i++){
      const a = rand(0, TAU), d = rand(0, spread);
      const f = this.spawnFood(type, cx + Math.cos(a) * d, cy + Math.sin(a) * d);
      f.vx = Math.cos(a) * rand(20, 70);
      f.vy = Math.sin(a) * rand(20, 70);
    }
  }

  randomFoodSpot(avoidX, avoidY, avoidR){
    for (let tries = 0; tries < 8; tries++){
      const a = rand(0, TAU), d = Math.sqrt(Math.random()) * this.radius * 0.94;
      const x = Math.cos(a) * d, y = Math.sin(a) * d;
      if (avoidR && dist(x, y, avoidX, avoidY) < avoidR) continue;
      return [x, y];
    }
    return [rand(-this.radius, this.radius) * 0.5, rand(-this.radius, this.radius) * 0.5];
  }

  spawnHazard(refR){
    /* urchins keep to deeper water, never the central nursery */
    for (let tries = 0; tries < 12; tries++){
      const a = rand(0, TAU), d = rand(this.radius * 0.45, this.radius * 0.9);
      const x = Math.cos(a) * d, y = Math.sin(a) * d;
      let ok = true;
      for (const h of this.hazards) if (dist(x, y, h.x, h.y) < 500){ ok = false; break; }
      if (!ok) continue;
      this.hazards.push({
        x, y, ax: x, ay: y,
        orbitR: rand(90, 240), w: rand(0.06, 0.14) * (Math.random() < 0.5 ? -1 : 1),
        phase: rand(0, TAU),
        r: refR * rand(1.1, 1.7), rot: rand(0, TAU), spin: rand(-0.3, 0.3), seed: rand(0, 100)
      });
      return;
    }
  }

  /* -------------------- particles -------------------- */

  burst(x, y, color, n, speed = 120, life = 0.7, r = 2.5){
    for (let i = 0; i < n; i++){
      const a = rand(0, TAU), s = rand(speed * 0.3, speed);
      this.particles.push({
        x, y,
        vx: Math.cos(a) * s, vy: Math.sin(a) * s,
        life: rand(life * 0.5, life), maxLife: life,
        r: rand(r * 0.5, r * 1.4),
        color, rise: 0
      });
    }
  }

  inkCloud(x, y){
    /* a real curtain of night: big, lingering, matches the server slow-zone */
    for (let i = 0; i < 38; i++){
      const a = rand(0, TAU), s = rand(15, 150);
      this.particles.push({
        x, y,
        vx: Math.cos(a) * s, vy: Math.sin(a) * s,
        life: rand(2.6, 4.2), maxLife: 4.2,
        r: rand(16, 44),
        color: 'rgba(6,10,18,0.9)', rise: 0, dark: true
      });
    }
  }

  bubble(x, y, r){
    this.particles.push({
      x, y, vx: rand(-4, 4), vy: rand(-10, -4),
      life: rand(2.5, 5), maxLife: 5,
      r: r || rand(1, 3),
      color: 'rgba(190,235,255,0.5)', rise: rand(8, 20)
    });
  }

  /* -------------------- update -------------------- */

  update(dt){
    for (const f of this.food){
      f.x += f.vx * dt;
      f.y += f.vy * dt;
      f.vx *= Math.exp(-1.2 * dt);
      f.vy *= Math.exp(-1.2 * dt);
      if (f.decay !== Infinity){
        f.decay -= dt;
        if (f.decay <= 0) f.dead = true;
      }
    }
    this.food = this.food.filter(f => !f.dead);

    for (const h of this.hazards) h.rot += h.spin * dt;

    for (const p of this.particles){
      p.x += p.vx * dt;
      p.y += (p.vy - p.rise) * dt;
      p.vx *= Math.exp(-2.2 * dt);
      p.vy *= Math.exp(-2.2 * dt);
      p.life -= dt;
    }
    this.particles = this.particles.filter(p => p.life > 0);
  }

  /* urchins patrol slow, readable circles — same math on both ends of
     the wire, driven by the shared clock, so no sync traffic is needed */
  updateHazardOrbits(nowSec){
    for (const h of this.hazards){
      if (h.orbitR === undefined) continue;
      h.x = h.ax + Math.cos(h.phase + nowSec * h.w) * h.orbitR;
      h.y = h.ay + Math.sin(h.phase + nowSec * h.w) * h.orbitR;
    }
  }

  /* -------------------- drawing -------------------- */

  drawEdge(ctx, t){
    /* faint pool floor */
    ctx.save();
    const g = ctx.createRadialGradient(0, 0, this.radius * 0.4, 0, 0, this.radius);
    g.addColorStop(0, 'rgba(60,140,130,0.045)');
    g.addColorStop(1, 'rgba(60,140,130,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, this.radius, 0, TAU);
    ctx.fill();

    /* everything beyond the rim fades into true dark */
    const rim = ctx.createRadialGradient(0, 0, this.radius * 0.93, 0, 0, this.radius * 1.7);
    rim.addColorStop(0, 'rgba(2,8,13,0)');
    rim.addColorStop(0.22, 'rgba(2,8,13,0.6)');
    rim.addColorStop(1, 'rgba(2,8,13,0.95)');
    ctx.fillStyle = rim;
    ctx.beginPath();
    ctx.arc(0, 0, this.radius * 2.4, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = `rgba(125,255,212,${0.1 + 0.05 * Math.sin(t * 0.8)})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(0, 0, this.radius, 0, TAU);
    ctx.stroke();

    /* the edge of the shallows — beyond this faint ring, things hunt */
    ctx.setLineDash([26, 34]);
    ctx.strokeStyle = `rgba(255,122,92,${0.10 + 0.04 * Math.sin(t * 0.5)})`;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(0, 0, this.radius * 0.33, t * 0.02, t * 0.02 + TAU);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  drawFood(ctx, t){
    for (const f of this.food){
      const bob = Math.sin(t * 2 + f.seed) * 0.15 + 1;
      switch (f.type){
        case 'mote':
          drawGlow(ctx, f.x, f.y, f.r * 5, 'hsla(140,80%,80%,0.7)', 0.25);
          ctx.fillStyle = 'rgba(210,255,225,0.85)';
          ctx.beginPath();
          ctx.arc(f.x, f.y, f.r * bob, 0, TAU);
          ctx.fill();
          break;
        case 'algae': {
          drawGlow(ctx, f.x, f.y, f.r * 4.5, 'hsla(110,85%,60%,0.7)', 0.3);
          ctx.fillStyle = 'hsla(110,60%,55%,0.85)';
          for (let i = 0; i < 3; i++){
            const a = f.seed + i * 2.1 + Math.sin(t + f.seed) * 0.2;
            ctx.beginPath();
            ctx.arc(f.x + Math.cos(a) * f.r * 0.5, f.y + Math.sin(a) * f.r * 0.5, f.r * 0.62 * bob, 0, TAU);
            ctx.fill();
          }
          break;
        }
        case 'meat': {
          const fade = f.decay < 4 ? f.decay / 4 : 1;
          ctx.save();
          ctx.globalAlpha = fade;
          drawGlow(ctx, f.x, f.y, f.r * 4.5, 'hsla(28,95%,60%,0.7)', 0.3);
          ctx.fillStyle = 'hsla(20,75%,58%,0.9)';
          ctx.beginPath();
          for (let i = 0; i < 7; i++){
            const a = i / 7 * TAU;
            const rr = f.r * (0.75 + 0.3 * Math.sin(f.seed * 7 + i * 3));
            const px = f.x + Math.cos(a) * rr, py = f.y + Math.sin(a) * rr;
            i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
          }
          ctx.closePath();
          ctx.fill();
          ctx.restore();
          break;
        }
        case 'gold': {
          const gp = 0.85 + 0.3 * Math.sin(t * 6 + f.seed);
          drawGlow(ctx, f.x, f.y, f.r * 9 * gp, 'hsla(48,100%,62%,0.9)', 0.65);
          ctx.save();
          ctx.translate(f.x, f.y);
          ctx.rotate(t * 2.2);
          ctx.strokeStyle = 'rgba(255,232,150,0.95)';
          ctx.lineWidth = 2.2;
          ctx.beginPath();
          for (let i = 0; i < 6; i++){
            const a = i / 6 * TAU;
            ctx.moveTo(Math.cos(a) * f.r * 0.7, Math.sin(a) * f.r * 0.7);
            ctx.lineTo(Math.cos(a) * f.r * 1.9 * gp, Math.sin(a) * f.r * 1.9 * gp);
          }
          ctx.stroke();
          ctx.fillStyle = '#fff3c8';
          ctx.beginPath();
          ctx.arc(0, 0, f.r * 0.75, 0, TAU);
          ctx.fill();
          ctx.fillStyle = 'rgba(255,214,107,0.9)';
          ctx.beginPath();
          ctx.arc(0, 0, f.r * 0.45, 0, TAU);
          ctx.fill();
          ctx.restore();
          break;
        }
        case 'dna': {
          const pulse = 0.8 + 0.35 * Math.sin(t * 5 + f.seed);
          drawGlow(ctx, f.x, f.y, f.r * 7 * pulse, 'hsla(45,100%,65%,0.85)', 0.5);
          ctx.save();
          ctx.translate(f.x, f.y);
          ctx.rotate(t * 1.5 + f.seed);
          ctx.strokeStyle = 'rgba(255,220,120,0.95)';
          ctx.lineWidth = 1.6;
          ctx.beginPath();
          for (let i = 0; i < 4; i++){
            const a = i / 4 * TAU;
            ctx.moveTo(0, 0);
            ctx.lineTo(Math.cos(a) * f.r * 1.5 * pulse, Math.sin(a) * f.r * 1.5 * pulse);
          }
          ctx.stroke();
          ctx.fillStyle = '#ffe9ad';
          ctx.beginPath();
          ctx.arc(0, 0, f.r * 0.55, 0, TAU);
          ctx.fill();
          ctx.restore();
          break;
        }
      }
    }
  }

  drawHazards(ctx, t){
    for (const h of this.hazards){
      drawGlow(ctx, h.x, h.y, h.r * 2.6, 'hsla(340,80%,50%,0.6)', 0.18);
      ctx.save();
      ctx.translate(h.x, h.y);
      ctx.rotate(h.rot);
      ctx.fillStyle = '#1a0d18';
      ctx.strokeStyle = 'rgba(255,90,120,0.5)';
      ctx.lineWidth = h.r * 0.06;
      const spikes = 11;
      ctx.beginPath();
      for (let i = 0; i < spikes * 2; i++){
        const a = i / (spikes * 2) * TAU;
        const rr = i % 2 === 0 ? h.r * 1.35 : h.r * 0.62;
        const px = Math.cos(a) * rr, py = Math.sin(a) * rr;
        i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      /* venomous little heart */
      ctx.fillStyle = `rgba(255,90,120,${0.5 + 0.3 * Math.sin(t * 2.5 + h.seed)})`;
      ctx.beginPath();
      ctx.arc(0, 0, h.r * 0.2, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
  }

  drawVaults(ctx, t, vaults){
    for (const v of vaults || []){
      const frac = v.maxHp ? v.hp / v.maxHp : 1;
      const pulse = 0.75 + 0.25 * Math.sin(t * 3 + v.id);
      drawGlow(ctx, v.x, v.y, v.r * 5 * pulse, 'hsla(48,100%,60%,0.8)', 0.3 + 0.25 * (1 - frac));
      ctx.save();
      ctx.translate(v.x, v.y);
      ctx.rotate(v.id % 6);
      /* crystalline shell */
      ctx.beginPath();
      for (let i = 0; i < 6; i++){
        const a = i / 6 * TAU;
        const rr = v.r * (1 + 0.06 * Math.sin(t * 2 + i * 2 + v.id));
        i ? ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr) : ctx.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
      }
      ctx.closePath();
      ctx.fillStyle = 'rgba(20,26,20,0.85)';
      ctx.fill();
      ctx.strokeStyle = `rgba(255,214,107,${0.5 + 0.4 * (1 - frac)})`;
      ctx.lineWidth = Math.max(2, v.r * 0.09);
      ctx.stroke();
      /* cracks spread as it weakens */
      const cracks = Math.floor((1 - frac) * 6);
      if (cracks > 0){
        ctx.strokeStyle = 'rgba(255,232,150,0.85)';
        ctx.lineWidth = Math.max(1, v.r * 0.045);
        for (let i = 0; i < cracks; i++){
          const a = (v.id + i * 2.4) % TAU;
          ctx.beginPath();
          ctx.moveTo(Math.cos(a) * v.r * 0.2, Math.sin(a) * v.r * 0.2);
          ctx.lineTo(Math.cos(a + 0.35) * v.r * 0.65, Math.sin(a + 0.35) * v.r * 0.65);
          ctx.lineTo(Math.cos(a + 0.2) * v.r * 0.98, Math.sin(a + 0.2) * v.r * 0.98);
          ctx.stroke();
        }
      }
      /* the hoard inside */
      ctx.fillStyle = `rgba(255,214,107,${0.55 + 0.35 * pulse})`;
      ctx.beginPath();
      ctx.arc(0, 0, v.r * 0.3, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
  }

  drawParticles(ctx){
    ctx.save();
    for (const p of this.particles){
      /* ink is darkness, not light — it needs normal compositing */
      ctx.globalCompositeOperation = p.dark ? 'source-over' : 'lighter';
      ctx.globalAlpha = clamp(p.life / p.maxLife, 0, 1) * 0.85;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }
}
