/* ============================================================
   SOUPLINGS — audio: everything synthesized, zero assets
   ============================================================ */

const AudioSys = {
  ctx: null,
  master: null,
  muted: false,

  init(){
    if (this.ctx) return;
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.55;
      this.master.connect(this.ctx.destination);
      this.startAmbient();
    } catch (e) { /* no audio, no problem */ }
  },

  toggleMute(){
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.55;
    return this.muted;
  },

  /* low abyssal drone: two detuned sines + slow-filtered noise wash */
  startAmbient(){
    const c = this.ctx;
    const amb = c.createGain(); amb.gain.value = 0.05; amb.connect(this.master);

    [55, 82.6].forEach((f, i) => {
      const o = c.createOscillator();
      o.type = 'sine'; o.frequency.value = f; o.detune.value = i * 7;
      const g = c.createGain(); g.gain.value = 0.5;
      o.connect(g); g.connect(amb); o.start();
    });

    const len = c.sampleRate * 4;
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++){ last = (last + rand(-1, 1) * 0.04) * 0.985; d[i] = last * 3; }
    const noise = c.createBufferSource(); noise.buffer = buf; noise.loop = true;
    const filt = c.createBiquadFilter(); filt.type = 'lowpass'; filt.frequency.value = 220; filt.Q.value = 2;
    const ng = c.createGain(); ng.gain.value = 0.4;
    noise.connect(filt); filt.connect(ng); ng.connect(amb); noise.start();

    const lfo = c.createOscillator(); lfo.frequency.value = 0.06;
    const lfoG = c.createGain(); lfoG.gain.value = 120;
    lfo.connect(lfoG); lfoG.connect(filt.frequency); lfo.start();
  },

  /* generic pluck */
  tone(freq, dur, type, vol, glideTo){
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime;
    const o = c.createOscillator(); o.type = type || 'sine';
    o.frequency.setValueAtTime(freq, t);
    if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + dur + 0.02);
  },

  noiseBurst(dur, vol, freq){
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime;
    const len = Math.ceil(c.sampleRate * dur);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = rand(-1, 1) * (1 - i / len);
    const s = c.createBufferSource(); s.buffer = buf;
    const f = c.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = 1.2;
    const g = c.createGain(); g.gain.value = vol;
    s.connect(f); f.connect(g); g.connect(this.master);
    s.start(t);
  },

  eat(){     this.tone(rand(520, 720), 0.09, 'sine', 0.14, rand(900, 1200)); },
  meat(){    this.tone(rand(180, 240), 0.13, 'triangle', 0.16, 90); },
  dna(){     this.tone(1180, 0.14, 'sine', 0.1, 1560); },
  hurt(){    this.tone(110, 0.22, 'sawtooth', 0.14, 55); this.noiseBurst(0.12, 0.08, 400); },
  hit(){     this.tone(240, 0.08, 'square', 0.06, 180); },
  dash(){    this.noiseBurst(0.22, 0.12, 900); },
  zap(){     this.tone(1400, 0.08, 'sawtooth', 0.08, 500); this.tone(900, 0.12, 'square', 0.05, 300); },
  poke(){    this.tone(740, 0.07, 'sine', 0.09, 990); },
  frenzy(){  [520, 660, 880].forEach((f, i) => setTimeout(() => this.tone(f, 0.1, 'sine', 0.1), i * 45)); },
  devour(){  this.noiseBurst(0.25, 0.18, 240); this.tone(70, 0.32, 'triangle', 0.2, 44); },
  heart(){   this.tone(52, 0.1, 'sine', 0.24, 40); setTimeout(() => this.tone(48, 0.12, 'sine', 0.2, 36), 130); },
  gold(){    [880, 1175, 1568].forEach((f, i) => setTimeout(() => this.tone(f, 0.18, 'sine', 0.1), i * 70)); },
  buy(){     [440, 554, 659].forEach((f, i) => setTimeout(() => this.tone(f, 0.16, 'triangle', 0.11), i * 55)); },
  molt(){    [330, 415, 494, 659, 880].forEach((f, i) => setTimeout(() => this.tone(f, 0.3, 'sine', 0.12), i * 90)); },
  death(){   [392, 311, 233, 155].forEach((f, i) => setTimeout(() => this.tone(f, 0.5, 'triangle', 0.12), i * 160)); },
  win(){     [523, 659, 784, 1047, 1319].forEach((f, i) => setTimeout(() => this.tone(f, 0.7, 'sine', 0.12), i * 150)); }
};
