/* ============================================================
   SOUPLINGS — parts catalog, stat derivation, species names
   ============================================================ */

const PARTS = {
  flagellum: {
    name: 'Flagellum', max: 3, cost: [15, 30, 55],
    desc: 'A whip of a tail. Each level adds raw speed.'
  },
  cilia: {
    name: 'Cilia', max: 3, cost: [10, 25, 45],
    desc: 'A fringe of beating hairs. Sharper turns, faster dash recovery.'
  },
  spike: {
    name: 'Spines', max: 3, cost: [20, 35, 60],
    desc: 'Bristling defenses. Contact damage, and bites hurt you less.'
  },
  jaw: {
    name: 'Proboscis Jaw', max: 3, cost: [20, 40, 65],
    desc: 'Snapping mandibles. Big bite damage; meat nourishes you more.'
  },
  filter: {
    name: 'Filter Mouth', max: 3, cost: [15, 30, 50],
    desc: 'Baleen for the small stuff. Algae and motes are worth more.'
  },
  eye: {
    name: 'Ocelli', max: 2, cost: [10, 35],
    desc: 'Primitive eyes. See farther across the soup.'
  },
  membrane: {
    name: 'Thick Membrane', max: 3, cost: [15, 35, 60],
    desc: 'A tougher hide. More health, shrug off a little damage.'
  },
  gland: {
    name: 'Biolume Gland', max: 1, cost: [30],
    desc: 'A soft lantern. Nearby morsels drift toward your light.'
  }
};

const PART_KEYS = Object.keys(PARTS);

/* cost to buy the NEXT level given current level; null when maxed */
function partCost(key, curLvl){
  const p = PARTS[key];
  return curLvl >= p.max ? null : p.cost[curLvl];
}

/* derive live stats from a genome + current radius */
function deriveStats(genome, r, isPlayer){
  const p = genome.parts;
  const g = k => p[k] || 0;
  const sizeF = r / 26;
  const speed = 150 * sizeF * (1 + 0.33 * g('flagellum'));
  return {
    speed,
    steerK: 3.2 + 1.1 * g('cilia'),
    maxHp: (isPlayer ? 55 : 40) + 26 * g('membrane') + (isPlayer ? 0 : r * 0.45),
    dmg: 3 + 6 * g('spike') + 8 * g('jaw'),
    armor: clamp(0.12 * g('spike') + 0.10 * g('membrane'), 0, 0.5),
    algaeMul: 1 + 0.5 * g('filter'),
    meatMul: 1 + 0.5 * g('jaw'),
    sense: 340 * sizeF * (1 + 0.35 * g('eye')),
    zoomOut: 1 + 0.14 * g('eye'),
    dashCd: Math.max(1.1, 2.6 - 0.5 * g('cilia')),
    lure: g('gland') ? 150 * sizeF : 0,
    pickup: r + 26 + (g('gland') ? 60 * sizeF : 0)
  };
}

/* random genome for AI fauna; scale ~ relative power budget */
function randomGenome(budget){
  const parts = {};
  /* the small fry skew peaceful; real predators are bigger investments */
  const carn = Math.random() < (budget <= 2 ? 0.28 : 0.42);
  const pool = carn
    ? ['jaw', 'jaw', 'spike', 'flagellum', 'eye', 'membrane', 'cilia']
    : ['filter', 'filter', 'flagellum', 'cilia', 'membrane', 'eye', 'gland', 'spike'];
  let pts = budget;
  let guard = 20;
  while (pts > 0 && guard-- > 0){
    const k = pick(pool);
    if ((parts[k] || 0) < PARTS[k].max){ parts[k] = (parts[k] || 0) + 1; pts--; }
  }
  return {
    parts,
    carn,
    hue: carn ? rand(-25, 30) : pick([rand(45, 110), rand(170, 230), rand(255, 300)]),
    aggro: carn && Math.random() < 0.85
  };
}

/* ---- species name generator: dubious latin ----
   Names are ONLY ever generated (never typed) — that is the whole
   moderation strategy. ~170k combinations. */
const NAME_FRONT = ['Glo','Mur','Vor','Squi','Plu','Bry','Zil','Nem','Cra','Flu','Wib','Oo','Thal','Spo',
  'Kel','Bar','Mox','Fen','Tri','Quab','Yol','Dro','Hux','Pip','Vel','Sna'];
const NAME_MID   = ['ba','mo','ri','ple','dra','no','lu','ga','zzo','ndi','',
  'ta','vi','ko','ra','zel','mun'];
const NAME_END   = ['dax','mia','pod','zoa','rix','lus','nid','phor','bula','cyst',
  'gast','mere','plax','thid','vorn','culo'];
const NAME_EPITHET = ['minor','luminis','vulgaris','tremula','spinosa','dulcis','errans','profunda','viscosa','pigfordii',
  'gloriosa','furtiva','placida','borealis','abyssi','lucens','velox','modesta','iridescens','somnia',
  'crispini','maximus','humilis','undulata'];

function randomSpeciesName(){
  return pick(NAME_FRONT) + pick(NAME_MID) + pick(NAME_END) + ' ' + pick(NAME_EPITHET);
}

/* server-side check: accept only names our own generator could have produced */
function isValidSpeciesName(name){
  const m = /^([A-Z][a-z]+) ([a-z]+)$/.exec(name || '');
  if (!m) return false;
  if (!NAME_EPITHET.includes(m[2])) return false;
  const genus = m[1];
  for (const f of NAME_FRONT){
    if (!genus.startsWith(f)) continue;
    for (const e of NAME_END){
      if (!genus.endsWith(e)) continue;
      if (genus.length < f.length + e.length) continue;
      if (NAME_MID.includes(genus.slice(f.length, genus.length - e.length))) return true;
    }
  }
  return false;
}

const GEN_TITLES = ['Mote', 'Wriggler', 'Darter', 'Lurker', 'Sovereign of the Shallows'];
const ROMAN = ['I', 'II', 'III', 'IV', 'V'];

/* shared between client and server; tuned for the food-dense shared pool */
const growthNeedFor = gen => 150 + (gen - 1) * 75;
const FOOD_TYPES = ['mote', 'algae', 'meat', 'dna'];

/* players below this size are beneath the food chain's notice —
   gens 1–2 (r 26–39) are for learning and building; the wild only
   starts hunting you at gen 3, when you can hunt back */
const NEWBIE_R = 40;
