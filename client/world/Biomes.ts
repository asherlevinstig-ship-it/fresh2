// ============================================================
// Biomes.ts  (FULL REWRITE - NO OMITS - NO BREVITY)
// ============================================================
// PURPOSE
// - Deterministic biome selection from (x,z) only.
// - Deterministic height function from (x,z) and biome.
// - Deterministic surface/subsurface layering rules per biome.
// - Deterministic vegetation: trees + cactus (and hooks for future flora).
// - Deterministic ore selection: replaces some underground stone blocks.
// - Designed to be DUPLICATED byte-for-byte:
//     client/src/world/Biomes.ts
//     server/src/world/Biomes.ts (or server/world/Biomes.ts)
// - No Math.random() usage anywhere.
//
// IMPORTANT
// - This file intentionally avoids engine-specific imports.
// - WorldStore/index provide a "palette" object (block ID constants).
// - Keep block IDs consistent on client + server.
// ============================================================

export type BiomeId =
  | "plains"
  | "forest"
  | "desert"
  | "tundra"
  | "mountains"
  | "swamp";

export type BiomeSample = {
  biome: BiomeId;
  height: number;        // integer column height
  humidity: number;      // 0..1
  temperature: number;   // 0..1
  mountains: number;     // 0..1 (mountain mask)
  swampiness: number;    // 0..1 (swamp mask)
};

export type TreeType = "oak" | "pine";

export type TreeSpec = {
  type: TreeType;
  trunkHeight: number;

  // Leaf canopy controls (WorldStore expects canopyRadius)
  canopyRadius: number;   // radius in blocks (approx)
  canopyHeight: number;   // vertical thickness

  // Optional shape params you can use later (client visuals etc.)
  // These are deterministic but not required by WorldStore.
  // leafDensity can control how "full" a canopy is.
  leafDensity: number;    // 0..1
};

export type OreTables = {
  common: number[];
  uncommon: number[];
  rare: number[];
  epic: number[];
};

// ------------------------------------------------------------
// Math Helpers (Deterministic)
// ------------------------------------------------------------

function frac(n: number) {
  return n - Math.floor(n);
}

function clamp01(v: number) {
  return Math.max(0, Math.min(1, v));
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function smoothstep(t: number) {
  // 0..1 -> 0..1
  return t * t * (3 - 2 * t);
}

// ------------------------------------------------------------
// Hash / Noise (Deterministic)
// ------------------------------------------------------------
//
// All noise below is deterministic and depends only on input coords.
// DO NOT change these lightly once worlds exist, unless you want a new world.
//
// hash2: stable pseudo-random 0..1 from integer-ish coords
// valueNoise2: continuous-ish 2D noise using grid corner hashing
// fbm2: fractal noise using multiple octaves
// ------------------------------------------------------------

function hash2(x: number, z: number) {
  // Deterministic 0..1
  const n = Math.sin(x * 127.1 + z * 311.7) * 43758.5453123;
  return frac(n);
}

function hash3(x: number, y: number, z: number) {
  // Deterministic 0..1
  const n = Math.sin(x * 127.1 + y * 269.5 + z * 311.7) * 43758.5453123;
  return frac(n);
}

function valueNoise2(x: number, z: number) {
  // Grid-based value noise with smooth interpolation
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const x1 = x0 + 1;
  const z1 = z0 + 1;

  const fx = x - x0;
  const fz = z - z0;

  const sx = smoothstep(fx);
  const sz = smoothstep(fz);

  const v00 = hash2(x0, z0);
  const v10 = hash2(x1, z0);
  const v01 = hash2(x0, z1);
  const v11 = hash2(x1, z1);

  const ix0 = lerp(v00, v10, sx);
  const ix1 = lerp(v01, v11, sx);

  return lerp(ix0, ix1, sz);
}

function fbm2(x: number, z: number, octaves = 4, lacunarity = 2, gain = 0.5) {
  // Fractal Brownian Motion: sum of valueNoise2 at multiple frequencies
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;

  for (let i = 0; i < octaves; i++) {
    sum += valueNoise2(x * freq, z * freq) * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }

  return norm > 0 ? sum / norm : 0;
}

// ------------------------------------------------------------
// Biome Sampling
// ------------------------------------------------------------
//
// sampleBiome(x,z):
// - temperature/humidity are broad-scale fields (low frequency)
// - mountains is a separate mask
// - swampiness is a separate mask
// - returns chosen biome + final computed height
//
// HEIGHT STRATEGY
// - keep your old “sin/cos base height” vibe
// - add biome-specific noise modulation
// - keep integer output
// ------------------------------------------------------------

export function sampleBiome(x: number, z: number): BiomeSample {
  // Scale down for large coherent regions
  const sx = x / 180;
  const sz = z / 180;

  // Broad climate fields
  const temperature = clamp01(fbm2(sx + 10, sz - 20, 4, 2, 0.55));
  const humidity = clamp01(fbm2(sx - 40, sz + 30, 4, 2, 0.55));

  // Mountain mask (higher = more mountainous)
  const mountains = clamp01(fbm2(sx + 200, sz + 200, 5, 2, 0.5));

  // Swamp mask (humid lowlands)
  const swampiness = clamp01(fbm2(sx - 120, sz + 90, 4, 2, 0.55));

  let biome: BiomeId = "plains";

  // Biome decision
  // Priority:
  // 1) big mountain areas
  // 2) hot+dry desert
  // 3) cold tundra
  // 4) swampy wet lowlands
  // 5) humid forest
  // 6) otherwise plains
  if (mountains > 0.72) {
    biome = "mountains";
  } else if (temperature > 0.70 && humidity < 0.35) {
    biome = "desert";
  } else if (temperature < 0.30) {
    biome = "tundra";
  } else if (humidity > 0.65 && swampiness > 0.60) {
    biome = "swamp";
  } else if (humidity > 0.55) {
    biome = "forest";
  } else {
    biome = "plains";
  }

  // Original-ish base height (your current world vibe)
  const base = Math.floor(4 * Math.sin(x / 15) + 4 * Math.cos(z / 20));

  // Additional height noise
  const n1 = fbm2(x / 90, z / 90, 4, 2, 0.55);  // 0..1 (medium)
  const n2 = fbm2(x / 32, z / 32, 3, 2, 0.50);  // 0..1 (smaller)

  let h = base;

  if (biome === "plains") {
    // gentle rolling
    h += Math.floor((n1 - 0.5) * 4);
  } else if (biome === "forest") {
    // slightly more variation
    h += Math.floor((n1 - 0.5) * 6);
  } else if (biome === "desert") {
    // dunes (medium scale)
    h += Math.floor((n1 - 0.5) * 5);
  } else if (biome === "tundra") {
    // fairly flat with occasional bumps
    h += Math.floor((n1 - 0.5) * 4);
  } else if (biome === "swamp") {
    // lowlands / subtle noise
    h += Math.floor((n2 - 0.5) * 3);
  } else if (biome === "mountains") {
    // high variance
    h += Math.floor((n1 - 0.3) * 18);
  }

  return {
    biome,
    height: h | 0,
    humidity,
    temperature,
    mountains,
    swampiness,
  };
}

// ------------------------------------------------------------
// Terrain Layer Rules
// ------------------------------------------------------------
//
// getTerrainLayerBlockId(palette, biome, depth):
// - palette is an object containing numeric IDs for blocks.
// - depth = height - y:
//   depth 0 = surface
//   depth 1..2 = subsurface
//   depth >=3 = stone
//
// Palette must include at least:
//   AIR, DIRT, GRASS, STONE, BEDROCK, LOG, LEAVES
// Optional biome blocks:
//   SAND, SNOW, CLAY, GRAVEL, MUD, ICE
// ------------------------------------------------------------

export function getTerrainLayerBlockId(
  palette: any,
  biome: BiomeId,
  depth: number
): number {
  const AIR = palette.AIR ?? 0;
  const DIRT = palette.DIRT ?? 1;
  const GRASS = palette.GRASS ?? 2;
  const STONE = palette.STONE ?? 3;

  const SAND = palette.SAND ?? DIRT;
  const SNOW = palette.SNOW ?? GRASS;
  const CLAY = palette.CLAY ?? DIRT;
  const GRAVEL = palette.GRAVEL ?? STONE;
  const MUD = palette.MUD ?? DIRT;
  const ICE = palette.ICE ?? SNOW;

  // Always stone deeper down
  if (depth >= 3) return STONE;

  // Desert: sand top + sand subsurface
  if (biome === "desert") {
    return SAND;
  }

  // Tundra: snow top, dirt under
  if (biome === "tundra") {
    return depth === 0 ? SNOW : DIRT;
  }

  // Swamp: mud top, clay below, then dirt
  if (biome === "swamp") {
    if (depth === 0) return MUD;
    if (depth === 1) return CLAY;
    return DIRT;
  }

  // Mountains: stone surface and subsurface (rugged)
  if (biome === "mountains") {
    return STONE;
  }

  // Plains / Forest: grass top, dirt below
  return depth === 0 ? GRASS : DIRT;
}

// ------------------------------------------------------------
// Vegetation: Trees
// ------------------------------------------------------------
//
// The world generator (server + client) typically calls:
// - shouldSpawnTree(x,z, biome) for tree root columns.
// - getTreeSpec(x,z, biome) for deterministic parameters.
//
// IMPORTANT:
// - This must be deterministic from x,z,biome only.
// - It should not depend on y or runtime randomness.
// ------------------------------------------------------------

export function shouldSpawnTree(x: number, z: number, biome: BiomeId) {
  const r = hash2(x, z);

  // Forest: common trees
  if (biome === "forest") return r > 0.965; // ~3.5%

  // Plains: rare trees
  if (biome === "plains") return r > 0.985; // ~1.5%

  // Swamp: moderate (gnarly trees later)
  if (biome === "swamp") return r > 0.972; // ~2.8%

  // Tundra: rare pines
  if (biome === "tundra") return r > 0.982; // ~1.8%

  // Mountains: optional rare pines
  if (biome === "mountains") return r > 0.988; // ~1.2%

  // Desert: no trees here (use cactus)
  return false;
}

export function getTreeSpec(x: number, z: number, biome: BiomeId): TreeSpec {
  const r = hash2(x * 2 + 11, z * 2 - 7); // 0..1
  const r2 = hash2(x * 3 - 19, z * 3 + 31); // 0..1 (extra variation)

  if (biome === "tundra" || biome === "mountains") {
    const trunkHeight = 5 + Math.floor(r * 3); // 5..7

    // Pine canopy: narrower, taller
    const canopyRadius = 2 + Math.floor(r2 * 2); // 2..3
    const canopyHeight = 3 + Math.floor(r * 2);  // 3..4

    return {
      type: "pine",
      trunkHeight,
      canopyRadius,
      canopyHeight,
      leafDensity: 0.75 + 0.20 * r2, // 0.75..0.95
    };
  }

  // Oak-like
  const trunkHeight = 4 + Math.floor(r * 2); // 4..5
  const canopyRadius = 2 + Math.floor(r2 * 2); // 2..3
  const canopyHeight = 3 + Math.floor(r * 2);  // 3..4

  return {
    type: "oak",
    trunkHeight,
    canopyRadius,
    canopyHeight,
    leafDensity: 0.80 + 0.15 * r2, // 0.80..0.95
  };
}

// ------------------------------------------------------------
// Vegetation: Cactus (Desert)
// ------------------------------------------------------------
//
// shouldSpawnCactus(x,z, biome):
// - only in desert
// - deterministic chance
//
// getCactusHeight(x,z):
// - deterministic height 2..4
// ------------------------------------------------------------

export function shouldSpawnCactus(x: number, z: number, biome: BiomeId) {
  if (biome !== "desert") return false;
  const r = hash2(x + 999, z - 999);
  return r > 0.988; // ~1.2%
}

export function getCactusHeight(x: number, z: number) {
  const r = hash2(x * 3 + 5, z * 3 + 9);
  return 2 + Math.floor(r * 3); // 2..4
}

// ------------------------------------------------------------
// Ore Tables
// ------------------------------------------------------------
//
// buildDefaultOreTablesFromPalette(palette):
// - takes a palette of numeric IDs
// - returns tier arrays for ore selection
//
// pickOreId(...):
// - chooses an ore ID based on depth + biome bias
// - returns 0 to indicate "no ore, keep stone"
// ------------------------------------------------------------

export function buildDefaultOreTablesFromPalette(palette: any): OreTables {
  const COAL = palette.COAL_ORE ?? 0;
  const COPPER = palette.COPPER_ORE ?? 0;
  const IRON = palette.IRON_ORE ?? 0;
  const SILVER = palette.SILVER_ORE ?? 0;
  const GOLD = palette.GOLD_ORE ?? 0;

  const RUBY = palette.RUBY_ORE ?? 0;
  const SAPPHIRE = palette.SAPPHIRE_ORE ?? 0;
  const MYTHRIL = palette.MYTHRIL_ORE ?? 0;
  const DRAGONSTONE = palette.DRAGONSTONE ?? 0;

  // Filter out zeros (if a block doesn't exist in palette, skip)
  const common = [COAL, COPPER, IRON].filter(Boolean);
  const uncommon = [IRON, SILVER, GOLD].filter(Boolean);
  const rare = [GOLD, RUBY, SAPPHIRE].filter(Boolean);
  const epic = [MYTHRIL, DRAGONSTONE].filter(Boolean);

  return { common, uncommon, rare, epic };
}

function pickFrom(arr: number[], t: number) {
  if (!arr || arr.length === 0) return 0;
  const idx = Math.floor(t * arr.length);
  return arr[Math.max(0, Math.min(arr.length - 1, idx))] || 0;
}

export function pickOreId(
  x: number,
  y: number,
  z: number,
  biome: BiomeId,
  surfaceHeight: number,
  tables: OreTables
): number {
  // Only underground (below some depth)
  const depthBelowSurface = surfaceHeight - y;
  if (depthBelowSurface < 4) return 0;

  // Deterministic roll (ore placement chance)
  const r = hash3(x, y, z);

  // Depth-based rarity bias:
  // deeper => more likely ore, and more likely rare/epic tiers
  const deep = clamp01((depthBelowSurface - 8) / 40); // 0..1

  // Biome bias:
  // mountains slightly richer, swamp slightly poorer
  const biomeBonus = biome === "mountains" ? 0.08 : biome === "swamp" ? -0.02 : 0;

  // Overall chance that STONE becomes an ore block
  const baseChance = 0.08 + deep * 0.10 + biomeBonus; // ~8% to ~28% typically
  if (r > baseChance) return 0;

  // Second roll for tier selection
  const r2 = hash3(x + 99, y - 77, z + 33);

  // Tier thresholds shift with depth
  const epicT = 0.02 + deep * 0.08;   // up to ~10%
  const rareT = 0.10 + deep * 0.18;   // up to ~28%
  const uncoT = 0.35 + deep * 0.25;   // up to ~60%

  if (r2 < epicT) return pickFrom(tables.epic, hash3(x + 7, y + 7, z + 7));
  if (r2 < rareT) return pickFrom(tables.rare, hash3(x + 8, y + 8, z + 8));
  if (r2 < uncoT) return pickFrom(tables.uncommon, hash3(x + 9, y + 9, z + 9));
  return pickFrom(tables.common, hash3(x + 10, y + 10, z + 10));
}
