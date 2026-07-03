# PRIMORDIA

A multiplayer evolution game inspired by Spore's cell stage, running on
Cloudflare Workers + Durable Objects. Everyone shares one persistent tide
pool: eat, collect DNA, buy body parts in the Evolution Chamber, and grow
through five generations until your line crawls ashore — while dodging (or
hunting) the other players.

## Run it locally

```
npm install --ignore-scripts
npm start
```

Then open http://localhost:8787 — in as many browser windows as you want
players. (`--ignore-scripts` sidesteps a `sharp` source build that fails on
some machines; sharp is an unused miniflare image dependency.)

## Deploy to Cloudflare

```
npx wrangler login
npm run deploy
```

That's the whole thing: the Worker serves the static client from `public/`,
and a single Durable Object (`Soup`) runs the authoritative world simulation,
ticking at 30 Hz and broadcasting 15 Hz snapshots to every connected player.
When the last player leaves, the soup goes dormant; a fresh one is seeded on
the next visit.

## Play

- **Mouse** — swim toward the cursor
- **Click / Space** — dash (short cooldown)
- **E** — open/close the Evolution Chamber (the soup does not pause!)
- **M** — mute

Green algae and motes feed herbivores; meat and gold DNA orbs drop when
things die — including other players. Warm-colored cells bite. Urchins are
hazards. The central shallows are a gentle nursery; monsters patrol the deep
rim, so venture outward as you grow. Fill the growth bar to molt; survive
five generations to win, then rejoin as a fresh speck.

## Architecture

- `public/` — the client. Canvas rendering, snapshot interpolation (~120 ms
  buffer), UI. All audio synthesized via WebAudio; no assets.
  - `js/util.js`, `js/parts.js`, `js/creature.js`, `js/world.js` — the
    simulation core, shared with the server
  - `js/net.js` — WebSocket client
  - `js/game.js` — interpolation, input, HUD, editor
- `server/worker.js` — Worker entry + `Soup` Durable Object: authoritative
  sim, combat, growth, per-player runs, snapshot broadcast
- `server/sim.gen.mjs` — generated ES-module bundle of the shared sim files
  (Workers can't `eval`; the browser loads the same files as script tags).
  Regenerated automatically by `scripts/build-sim.mjs` on every
  dev/deploy build — edit `public/js/*.js`, never the generated file.

The server is authoritative for everything: clients only send steering
targets, dash, buy, and respawn intents. Snapshots are full-state (~10 KB at
15 Hz), which keeps the client dead simple — delta encoding is the obvious
next optimization if the soup ever gets crowded.
