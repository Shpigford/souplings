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
  onAshore: null, onBuyok: null, onStatus: null,

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
    }
  },

  send(o){
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(o));
  },
  join(name){ this.send({ t: 'join', name }); },
  input(tx, ty, th, dash){
    this.send({ t: 'input', tx: Math.round(tx), ty: Math.round(ty), th: +th.toFixed(2), dash: !!dash });
  },
  buy(key){ this.send({ t: 'buy', key }); },
  respawn(){ this.send({ t: 'respawn' }); }
};
