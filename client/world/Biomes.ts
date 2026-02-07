// ============================================================
// Biomes.ts (DUPLICATED FILE: client/src/world/Biomes.ts AND server/world/Biomes.ts)
// ============================================================
// Purpose:
// - Deterministic biome + terrain height sampling from (x,z).
// - Deterministic surface/layer rules per biome.
// - Deterministic vegetation (trees/cactus) + simple ore distribution hooks.
// - Designed so client and server can run the SAME math (duplicated file).
//
// IMPORTANT RULES:
// - Do NOT use Math.random().
// - Only deterministic functions based on x/z/(y).
// - Keep this file byte-identical in both client and server copies.
// ============================================================

export type BiomeId = "plains" | "forest" | "desert" | "tundra" | "mountains" | "swamp";

export type BiomeSample = {
  biome: BiomeId;
  height: number;
  humidity: number; // 0..1
  temperature: number; // 0..1
};

// ------------------------------------------------------------
// Deterministic Hash / Noise Helpers
// ------------------------------------------------------------

function frac(n: number) {
  return n - Math.floor(n);
}

function hash2(x: number, z: number) {
  // Deterministic 0..1
  const n = Math.sin(x * 127.1 + z * 311.7) * 43758.5453123;
  return frac(n);
}

function hash3(x: number, y: number, z: number) {
  const n = Math.sin(x * 127.1 + y * 269.5 + z * 311.7) * 43758.5453123;
  return frac(n);
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function smoothstep(t: number) {
  // cubic smooth
  return t * t * (3 - 2 * t);
}

function valueNoise2(x: number, z: number) {
  // 2D value noise (grid-based) with smooth interpolation
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
  // Fractal brownian motion 0..~1
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
// Biome Selection + Height
// ------------------------------------------------------------

function clamp01(v: number) {
  return Math.max(0, Math.min(1, v));
}

export function sampleBiome(x: number, z: number): BiomeSample {
  // Normalize scale
  const sx = x / 180;
  const sz = z / 180;

  // Two fields that drive biome: temperature + humidity
  const temperature = clamp01(fbm2(sx + 10, sz - 20, 4, 2, 0.55));
  const humidity = clamp01(fbm2(sx - 40, sz + 30, 4, 2, 0.55));

  // Mountains field
  const m = clamp01(fbm2(sx + 200, sz + 200, 5, 2, 0.5));

  // Swamp tendency (humid lowlands)
  const swampiness = clamp01(fbm2(sx - 120, sz + 90, 4, 2, 0.55));

  let biome: BiomeId = "plains";

  // Decide biome
  if (m > 0.72) {
    biome = "mountains";
  } else if (temperature > 0.70 && humidity < 0.35) {
    biome = "desert";
  } else if (temperature < 0.30) {
    biome = "tundra";
  } else if (humidity > 0.65 && swampiness > 0.6) {
    biome = "swamp";
  } else if (humidity > 0.55) {
    biome = "forest";
  } else {
    biome = "plains";
  }

  // Height: match your existing vibe but biome-variant
  const base = Math.floor(4 * Math.sin(x / 15) + 4 * Math.cos(z / 20));

  // Add biome noise shaping
  const n1 = fbm2(x / 90, z / 90, 4, 2, 0.55); // 0..1
  const n2 = fbm2(x / 32, z / 32, 3, 2, 0.5); // 0..1

  let h = base;

  if (biome === "plains") {
    h += Math.floor((n1 - 0.5) * 4);
  } else if (biome === "forest") {
    h += Math.floor((n1 - 0.5) * 6);
  } else if (biome === "desert") {
    h += Math.floor((n1 - 0.5) * 5);
  } else if (biome === "tundra") {
    h += Math.floor((n1 - 0.5) * 4);
  } else if (biome === "swamp") {
    h += Math.floor((n2 - 0.5) * 3);
  } else if (biome === "mountains") {
    // Much higher variance
    h += Math.floor((n1 - 0.3) * 18);
  }

  return { biome, height: h, humidity, temperature };
}

// ------------------------------------------------------------
// Terrain Layer Rules
// ------------------------------------------------------------
//
// We operate on numeric IDs via a palette supplied by WorldStore/index.
// Palette must include: AIR, DIRT, GRASS, STONE, BEDROCK, LOG, LEAVES,
// plus optional: SAND, SNOW, CLAY, GRAVEL, MUD, ICE.
// ------------------------------------------------------------

export function getTerrainLayerBlockId(
  palette: any,
  biome: BiomeId,
  depth: number
): number {
  // depth = height - y
  // depth 0 => top surface block
  // depth 1..2 => sub surface
  // depth >=3 => stone

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

  // Deep layer always stone
  if (depth >= 3) return STONE;

  // Surface/subsurface by biome
  if (biome === "desert") {
    // all sand top + subsurface
    return depth === 0 ? SAND : SAND;
  }

  if (biome === "tundra") {
    // snowy grass top, dirt under, stone deep
    return depth === 0 ? SNOW : DIRT;
  }

  if (biome === "swamp") {
    // muddy top with clay pockets
    if (depth === 0) return MUD;
    if (depth === 1) return CLAY;
    return DIRT;
  }

  if (biome === "mountains") {
    // rocky surface with patchy snow caps simulated elsewhere; keep simple:
    return depth === 0 ? STONE : STONE;
  }

  // plains / forest
  return depth === 0 ? GRASS : DIRT;
}

// ------------------------------------------------------------
// Vegetation (Trees / Cactus)
// ------------------------------------------------------------

export type TreeSpec = { type: "oak" | "pine"; trunkHeight: number };

export function shouldSpawnTree(x: number, z: number, biome: BiomeId) {
  // Deterministic chance
  const r = hash2(x, z);
  if (biome === "forest") return r > 0.965;     // ~3.5%
  if (biome === "plains") return r > 0.985;     // ~1.5%
  if (biome === "swamp") return r > 0.972;      // ~2.8%
  if (biome === "tundra") return r > 0.982;     // rare pines
  return false;
}

export function getTreeSpec(x: number, z: number, biome: BiomeId): TreeSpec {
  const r = hash2(x * 2 + 11, z * 2 - 7);
  if (biome === "tundra" || biome === "mountains") {
    const trunkHeight = 5 + Math.floor(r * 3); // 5..7
    return { type: "pine", trunkHeight };
  }
  const trunkHeight = 4 + Math.floor(r * 2); // 4..5
  return { type: "oak", trunkHeight };
}

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
// We do "ore replacement" only in STONE zones.
// The palette should include ore IDs or it will skip them.
//
// This is intentionally simple but feels like rarity/value tiers.
// ------------------------------------------------------------

export type OreTables = {
  common: number[];
  uncommon: number[];
  rare: number[];
  epic: number[];
};

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
  // Only underground
  const depthBelowSurface = surfaceHeight - y;
  if (depthBelowSurface < 4) return 0;

  // Deterministic roll
  const r = hash3(x, y, z);

  // Depth-based rarity bias
  // deeper => more likely rare/epic
  const deep = clamp01((depthBelowSurface - 8) / 40); // 0..1

  // Biome bias: mountains slightly richer
  const biomeBonus = biome === "mountains" ? 0.08 : biome === "swamp" ? -0.02 : 0;

  // Overall chance a stone becomes an ore
  const baseChance = 0.08 + deep * 0.10 + biomeBonus; // ~8% to ~28%
  if (r > baseChance) return 0;

  // Second roll for tier selection
  const r2 = hash3(x + 99, y - 77, z + 33);

  // Tier thresholds shift with depth
  const epicT = 0.02 + deep * 0.08;     // up to 10%
  const rareT = 0.10 + deep * 0.18;     // up to 28%
  const uncoT = 0.35 + deep * 0.25;     // up to 60%

  if (r2 < epicT) return pickFrom(tables.epic, hash3(x + 7, y + 7, z + 7));
  if (r2 < rareT) return pickFrom(tables.rare, hash3(x + 8, y + 8, z + 8));
  if (r2 < uncoT) return pickFrom(tables.uncommon, hash3(x + 9, y + 9, z + 9));
  return pickFrom(tables.common, hash3(x + 10, y + 10, z + 10));
}
