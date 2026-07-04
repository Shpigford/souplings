/* ============================================================
   SOUPLINGS — client networking: WebSocket to the Soup
   ============================================================ */

const Net = {
  ws: null,
  connected: false,
  joined: false,
  myId: 0,
  radius: 0,
  hazards: [],
  snaps: [],        // recent snapshots, stamped with local receive time
  events: [],       // world events awaiting the render loop
  me: { dna: 0, growth: 0, need: 110, gen: 1 },
  world: null,      // the chronicle: all-time world stats
  lastDead: null,   // last death report, kept for share cards
  lastAshore: null,
  retryT: null,
  pingT: null,

  /* handlers assigned by game.js */
  onWelcome: null, onJoined: null, onDead: null,
  onAshore: null, onBuyok: null, onStatus: null, onHint: null, onToast: null, onRenamed: null, onInvite: null,

  url(){
    return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
  },

  connect(){
    if (location.protocol === 'file:'){
      this.onStatus && this.onStatus('offline');
      return;
    }
    try { this.ws = new WebSocket(this.url()); }
    catch (e) { this.scheduleRetry(); return; }

    this.ws.onopen = () => {
      this.connected = true;
      this.onStatus && this.onStatus('connected');
      /* heartbeat: incoming messages reset the Durable Object's CPU clock;
         without one, an idle spectator lets the server tick itself to eviction */
      clearInterval(this.pingT);
      this.pingT = setInterval(() => this.send({ t: 'ping' }), 10000);
    };
    this.ws.onclose = () => {
      this.connected = false;
      this.joined = false;
      this.snaps.length = 0;
      clearInterval(this.pingT);
      this.onStatus && this.onStatus('lost');
      this.scheduleRetry();
    };
    this.ws.onerror = () => {};
    this.ws.onmessage = e => {
      let m;
      try { m = JSON.parse(e.data); } catch (err) { return; }
      this.handle(m);
    };
  },

  scheduleRetry(){
    clearTimeout(this.retryT);
    this.retryT = setTimeout(() => this.connect(), 2000);
  },

  handle(m){
    switch (m.t){
      case 'welcome':
        this.myId = m.id;
        this.shore = m.shore;
        this.radius = m.radius;
        this.hazards = m.hazards;
        if (m.world) this.world = m.world;
        this.onWelcome && this.onWelcome(m);
        break;
      case 'snap':
        m.rt = performance.now();
        this.snaps.push(m);
        if (this.snaps.length > 8) this.snaps.shift();
        if (m.ev && m.ev.length) this.events.push(...m.ev);
        if (m.world) this.world = m.world;
        break;
      case 'you':
        this.me = m;
        break;
      case 'joined':
        this.joined = true;
        this.onJoined && this.onJoined(m);
        break;
      case 'dead':
        this.joined = false;
        this.lastDead = m;
        this.onDead && this.onDead(m);
        break;
      case 'ashore':
        this.joined = false;
        this.lastAshore = m;
        this.onAshore && this.onAshore(m);
        break;
      case 'buyok':
        this.me.dna = m.dna;
        this.onBuyok && this.onBuyok(m);
        break;
      case 'sellok':
        this.me.dna = m.dna;
        this.me.reab = m.reab;
        this.onSellok && this.onSellok(m);
        break;
      case 'hint':
        this.onHint && this.onHint(m);
        break;
      case 'toast':
        this.onToast && this.onToast(m);
        break;
      case 'renamed':
        this.onRenamed && this.onRenamed(m);
        break;
      case 'invite':
        this.onInvite && this.onInvite(m);
        break;
    }
  },

  /* stable anonymous identity — the dynasty survives page refreshes */
  token(){
    try {
      let t = localStorage.getItem('soup_token');
      if (!t){
        t = [...crypto.getRandomValues(new Uint8Array(16))]
          .map(b => b.toString(16).padStart(2, '0')).join('');
        localStorage.setItem('soup_token', t);
      }
      return t;
    } catch (e) { return null; }
  },

  send(o){
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(o));
  },
  join(name, buddy){
    let hue = 0, trail = 0, shape = 0;
    try {
      hue = +localStorage.getItem('soup_hue') || 0;
      trail = +localStorage.getItem('soup_trail') || 0;
      shape = +localStorage.getItem('soup_shape') || 0;
    } catch (e) {}
    this.send({ t: 'join', name, token: this.token(), hue, trail, shape, buddy: buddy || undefined });
  },
  invite(avenge){ this.send({ t: 'invite', avenge: !!avenge }); },
  ident(name, hue, trail, shape){ this.send({ t: 'ident', name, hue, trail, shape }); },
  input(tx, ty, th, dash){
    this.send({ t: 'input', tx: Math.round(tx), ty: Math.round(ty), th: +th.toFixed(2), dash: !!dash });
  },
  buy(key){ this.send({ t: 'buy', key }); },
  emote(i){ this.send({ t: 'emote', i }); },
  sell(key){ this.send({ t: 'sell', key }); },
  respawn(){ this.send({ t: 'respawn' }); }
};
