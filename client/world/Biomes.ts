// ============================================================
// shared/world/Biomes.ts  (FULL FILE - NO OMITS)
// ============================================================
// Purpose:
// - Deterministic biome + height + feature helpers.
// - Designed to be used BOTH client + server with identical math.
// - No external dependencies (no noise library) so it runs anywhere.
// - Biomes are derived from 2D "value-noise-ish" fields:
//   temperature(x,z) and moisture(x,z), both in [0..1].
// - Height is biome-dependent and stable.
//
// How to use (server):
//   import { getBiome, getHeight, getSurfaceBlockId, getStoneBlockId } from "../shared/world/Biomes"
//   const biome = getBiome(x,z);
//   const h = getHeight(x,z, biome);
//   ...
//
// How to use (client):
//   import same functions (ensure build copies shared/ -> client bundle)
//
// Important:
// - Block IDs are passed in via a palette object to avoid circular deps.
// - That means this file does NOT import WorldStore.ts or noa registry.
// ============================================================

export type BiomeId =
  | "plains"
  | "forest"
  | "desert"
  | "tundra"
  | "mountains"
  | "swamp";

export type BiomeParams = {
  name: BiomeId;

  // Base vertical shaping
  baseHeight: number;     // average terrain height offset
  heightAmp: number;      // amplitude applied to height noise

  // Surface composition (layers)
  surface: "grass" | "sand" | "snow" | "mud" | "stone";
  topDepth: number;       // how many blocks of top material (e.g. grass/sand/snow)
  underDepth: number;     // how many blocks below top before stone

  // Vegetation
  treeChance: number;     // 0..1 chance per (x,z) column
  treeType: "oak" | "pine" | "none";
  cactusChance: number;   // 0..1 (desert)
  shrubChance: number;    // 0..1 (plains/desert)
};

export type BlockPalette = {
  AIR: number;
  DIRT: number;
  GRASS: number;
  STONE: number;
  BEDROCK: number;

  LOG: number;
  LEAVES: number;

  // Optional / biome surfaces:
  SAND?: number;
  SNOW?: number;
  CLAY?: number;
  GRAVEL?: number;
  MUD?: number;
  ICE?: number;

  // Optional ore IDs (if you want biome-aware ore tables):
  COAL_ORE?: number;
  COPPER_ORE?: number;
  IRON_ORE?: number;
  SILVER_ORE?: number;
  GOLD_ORE?: number;
  RUBY_ORE?: number;
  SAPPHIRE_ORE?: number;
  MYTHRIL_ORE?: number;
  DRAGONSTONE?: number;
};

export type BiomeOut = {
  biome: BiomeId;
  temp: number;      // 0..1
  moist: number;     // 0..1
  height: number;    // integer ground height for (x,z)
};

// ------------------------------------------------------------
// Core math helpers
// ------------------------------------------------------------

function clamp01(n: number) {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function smoothstep(t: number) {
  // smoother than linear; stable and cheap
  return t * t * (3 - 2 * t);
}

function fract(n: number) {
  return n - Math.floor(n);
}

/**
 * Deterministic 2D hash -> [0,1)
 * (Not cryptographic; stable across JS engines)
 */
function hash2d(x: number, z: number) {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453123;
  return fract(s);
}

/**
 * Value noise in 2D.
 * - Samples hashes on integer lattice points
 * - Interpolates smoothly
 * Output ~ [0..1]
 */
function valueNoise2D(x: number, z: number) {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const x1 = x0 + 1;
  const z1 = z0 + 1;

  const sx = smoothstep(x - x0);
  const sz = smoothstep(z - z0);

  const n00 = hash2d(x0, z0);
  const n10 = hash2d(x1, z0);
  const n01 = hash2d(x0, z1);
  const n11 = hash2d(x1, z1);

  const ix0 = lerp(n00, n10, sx);
  const ix1 = lerp(n01, n11, sx);
  return lerp(ix0, ix1, sz);
}

/**
 * Fractal Brownian Motion (FBM) built from valueNoise2D.
 * Output ~ [0..1]
 */
function fbm2D(x: number, z: number, octaves: number, lacunarity = 2.0, gain = 0.5) {
  let amp = 1.0;
  let freq = 1.0;
  let sum = 0.0;
  let norm = 0.0;

  for (let i = 0; i < octaves; i++) {
    const n = valueNoise2D(x * freq, z * freq);
    sum += n * amp;
    norm += amp;

    amp *= gain;
    freq *= lacunarity;
  }

  return norm > 0 ? sum / norm : 0;
}

// ------------------------------------------------------------
// Biome configuration
// ------------------------------------------------------------

export const BIOMES: Record<BiomeId, BiomeParams> = {
  plains: {
    name: "plains",
    baseHeight: 0,
    heightAmp: 4,
    surface: "grass",
    topDepth: 1,
    underDepth: 3,
    treeChance: 0.02,
    treeType: "oak",
    cactusChance: 0.0,
    shrubChance: 0.08,
  },
  forest: {
    name: "forest",
    baseHeight: 0,
    heightAmp: 5,
    surface: "grass",
    topDepth: 1,
    underDepth: 3,
    treeChance: 0.08,
    treeType: "oak",
    cactusChance: 0.0,
    shrubChance: 0.10,
  },
  desert: {
    name: "desert",
    baseHeight: -1,
    heightAmp: 3,
    surface: "sand",
    topDepth: 3,
    underDepth: 6,
    treeChance: 0.0,
    treeType: "none",
    cactusChance: 0.03,
    shrubChance: 0.05,
  },
  tundra: {
    name: "tundra",
    baseHeight: 0,
    heightAmp: 4,
    surface: "snow",
    topDepth: 2,
    underDepth: 5,
    treeChance: 0.03,
    treeType: "pine",
    cactusChance: 0.0,
    shrubChance: 0.02,
  },
  mountains: {
    name: "mountains",
    baseHeight: 2,
    heightAmp: 12,
    surface: "stone",
    topDepth: 0,
    underDepth: 0,
    treeChance: 0.02,
    treeType: "pine",
    cactusChance: 0.0,
    shrubChance: 0.01,
  },
  swamp: {
    name: "swamp",
    baseHeight: -2,
    heightAmp: 2,
    surface: "mud",
    topDepth: 2,
    underDepth: 4,
    treeChance: 0.06,
    treeType: "oak",
    cactusChance: 0.0,
    shrubChance: 0.12,
  },
};

// ------------------------------------------------------------
// Public biome sampling
// ------------------------------------------------------------

/**
 * Temperature field in [0..1]
 * Uses a low-frequency FBM + slight warp for variety.
 */
export function getTemperature(x: number, z: number): number {
  // Large-scale variation
  const t0 = fbm2D(x * 0.0015, z * 0.0015, 4);
  // Add a bit of medium-scale detail
  const t1 = fbm2D((x + 1000) * 0.006, (z - 1000) * 0.006, 2);
  return clamp01(t0 * 0.75 + t1 * 0.25);
}

/**
 * Moisture field in [0..1]
 */
export function getMoisture(x: number, z: number): number {
  const m0 = fbm2D((x - 2000) * 0.0018, (z + 2000) * 0.0018, 4);
  const m1 = fbm2D((x + 500) * 0.007, (z + 250) * 0.007, 2);
  return clamp01(m0 * 0.8 + m1 * 0.2);
}

/**
 * Select biome from temp/moist.
 * Boundaries are simple and readable; tweak to taste.
 */
export function pickBiome(temp: number, moist: number): BiomeId {
  // Cold
  if (temp < 0.28) {
    if (moist < 0.35) return "tundra";
    // colder + wet -> swampy cold -> still tundra for now
    return "tundra";
  }

  // Hot
  if (temp > 0.72) {
    if (moist < 0.35) return "desert";
    // hot + wet -> swamp
    return "swamp";
  }

  // Temperate
  if (moist > 0.72) return "swamp";
  if (moist > 0.45) return "forest";

  return "plains";
}

/**
 * Returns biome + fields (temp, moisture).
 */
export function getBiome(x: number, z: number): { biome: BiomeId; temp: number; moist: number } {
  const temp = getTemperature(x, z);
  const moist = getMoisture(x, z);
  const biome = pickBiome(temp, moist);
  return { biome, temp, moist };
}

/**
 * Height function. Returns integer ground height for (x,z).
 * This MUST be mirrored on client+server for perfect base match.
 */
export function getHeight(x: number, z: number, biome: BiomeId): number {
  const b = BIOMES[biome];

  // Base rolling hills (existing vibe: sin/cos)
  const sincos = 4 * Math.sin(x / 15) + 4 * Math.cos(z / 20);

  // Add multi-scale noise for realism
  const nLow = fbm2D(x * 0.0025, z * 0.0025, 4);  // 0..1
  const nMed = fbm2D((x + 999) * 0.01, (z - 333) * 0.01, 3);

  // Convert to signed-ish [-1..1]
  const sLow = (nLow * 2 - 1);
  const sMed = (nMed * 2 - 1);

  // Mountains get an extra ridge bias
  let ridge = 0;
  if (biome === "mountains") {
    const r = fbm2D((x - 700) * 0.003, (z + 1200) * 0.003, 5);
    ridge = Math.pow(Math.abs(r * 2 - 1), 2) * 10; // 0..10
  }

  const h =
    b.baseHeight +
    sincos * 0.6 +
    sLow * b.heightAmp +
    sMed * (b.heightAmp * 0.35) +
    ridge;

  return Math.floor(h);
}

/**
 * Convenience: returns all biome fields including height.
 */
export function sampleBiome(x: number, z: number): BiomeOut {
  const { biome, temp, moist } = getBiome(x, z);
  const height = getHeight(x, z, biome);
  return { biome, temp, moist, height };
}

// ------------------------------------------------------------
// Surface / layering helpers
// ------------------------------------------------------------

/**
 * Given biome + depth below surface, decide which "terrain" block to use.
 * depth = 0 for topmost ground block at y==height
 * depth = 1 for one below, etc.
 */
export function getTerrainLayerBlockId(
  palette: BlockPalette,
  biome: BiomeId,
  depth: number
): number {
  const b = BIOMES[biome];

  // Mountains default to stone
  if (b.surface === "stone") return palette.STONE;

  // Swamp mud defaults to dirt if mud is unavailable
  if (b.surface === "mud") {
    const mudId = palette.MUD ?? palette.DIRT;
    if (depth < b.topDepth) return mudId;
    if (depth < b.topDepth + b.underDepth) return palette.DIRT;
    return palette.STONE;
  }

  // Snow defaults to grass if snow is unavailable (but try to provide it)
  if (b.surface === "snow") {
    const snowId = palette.SNOW ?? palette.GRASS;
    if (depth < b.topDepth) return snowId;
    if (depth < b.topDepth + b.underDepth) return palette.DIRT;
    return palette.STONE;
  }

  // Sand defaults to dirt if sand is unavailable
  if (b.surface === "sand") {
    const sandId = palette.SAND ?? palette.DIRT;
    if (depth < b.topDepth) return sandId;
    if (depth < b.topDepth + b.underDepth) return palette.DIRT;
    return palette.STONE;
  }

  // Grass
  if (depth < b.topDepth) return palette.GRASS;
  if (depth < b.topDepth + b.underDepth) return palette.DIRT;
  return palette.STONE;
}

/**
 * Determine if a tree should spawn at column (x,z) for a biome.
 * Deterministic by coordinate.
 */
export function shouldSpawnTree(x: number, z: number, biome: BiomeId): boolean {
  const b = BIOMES[biome];
  if (b.treeType === "none") return false;
  const h = hash2d(x * 0.13, z * 0.13);
  return h < b.treeChance;
}

/**
 * Tree trunk/leaves layout rules.
 * Returns:
 * - trunkHeight
 * - canopyRadius
 */
export function getTreeSpec(x: number, z: number, biome: BiomeId) {
  const b = BIOMES[biome];
  const h = hash2d(x * 0.77 + 10, z * 0.77 - 10);
  const trunkHeight = b.treeType === "pine" ? 5 + Math.floor(h * 3) : 4 + Math.floor(h * 3);
  const canopyRadius = b.treeType === "pine" ? 1 : 2;
  return { trunkHeight, canopyRadius, type: b.treeType };
}

/**
 * Determine if cactus should spawn at column (x,z).
 */
export function shouldSpawnCactus(x: number, z: number, biome: BiomeId): boolean {
  const b = BIOMES[biome];
  if (b.cactusChance <= 0) return false;
  const h = hash2d(x * 0.21 + 999, z * 0.21 - 999);
  return h < b.cactusChance;
}

/**
 * Determine cactus height (2..4 blocks).
 */
export function getCactusHeight(x: number, z: number) {
  const h = hash2d(x * 0.9 + 3, z * 0.9 + 7);
  return 2 + Math.floor(h * 3);
}

// ------------------------------------------------------------
// Ore helper (optional, deterministic, biome-weighted)
// ------------------------------------------------------------

export type OrePick = {
  id: number;      // block id of ore
  // probability threshold at a given point (higher => rarer)
  thresh: number;
  // minDepthBelowSurface: only spawn if y <= height - depth
  minDepthBelowSurface: number;
};

/**
 * Default ore tables. Only used if you call pickOreId().
 * You can tweak these per biome to change economy.
 */
export const ORE_TABLES: Record<BiomeId, OrePick[]> = {
  plains: [
    { id: 0, thresh: 1, minDepthBelowSurface: 0 },
  ],
  forest: [
    { id: 0, thresh: 1, minDepthBelowSurface: 0 },
  ],
  desert: [
    { id: 0, thresh: 1, minDepthBelowSurface: 0 },
  ],
  tundra: [
    { id: 0, thresh: 1, minDepthBelowSurface: 0 },
  ],
  mountains: [
    { id: 0, thresh: 1, minDepthBelowSurface: 0 },
  ],
  swamp: [
    { id: 0, thresh: 1, minDepthBelowSurface: 0 },
  ],
};

/**
 * Utility to seed ore tables from palette (only if those IDs exist).
 * Call this once at startup on each side if you want a sensible default.
 */
export function buildDefaultOreTablesFromPalette(palette: BlockPalette): Record<BiomeId, OrePick[]> {
  const coal = palette.COAL_ORE ?? 0;
  const copper = palette.COPPER_ORE ?? 0;
  const iron = palette.IRON_ORE ?? 0;
  const silver = palette.SILVER_ORE ?? 0;
  const gold = palette.GOLD_ORE ?? 0;
  const ruby = palette.RUBY_ORE ?? 0;
  const sapphire = palette.SAPPHIRE_ORE ?? 0;
  const mythril = palette.MYTHRIL_ORE ?? 0;
  const dragon = palette.DRAGONSTONE ?? 0;

  const base: OrePick[] = [];
  if (coal) base.push({ id: coal, thresh: 0.995, minDepthBelowSurface: 3 });
  if (copper) base.push({ id: copper, thresh: 0.996, minDepthBelowSurface: 4 });
  if (iron) base.push({ id: iron, thresh: 0.9972, minDepthBelowSurface: 7 });
  if (silver) base.push({ id: silver, thresh: 0.9978, minDepthBelowSurface: 11 });
  if (gold) base.push({ id: gold, thresh: 0.9983, minDepthBelowSurface: 15 });
  if (ruby) base.push({ id: ruby, thresh: 0.99875, minDepthBelowSurface: 19 });
  if (sapphire) base.push({ id: sapphire, thresh: 0.99875, minDepthBelowSurface: 19 });
  if (mythril) base.push({ id: mythril, thresh: 0.9992, minDepthBelowSurface: 27 });
  if (dragon) base.push({ id: dragon, thresh: 0.9996, minDepthBelowSurface: 35 });

  // Biome tweaks (slight)
  return {
    plains: base,
    forest: base,
    desert: base,
    tundra: base,
    swamp: base,
    mountains: base.map((o) => ({
      ...o,
      // Mountains: slightly more ores by lowering thresholds a hair
      thresh: Math.max(0, o.thresh - 0.0002),
    })),
  };
}

/**
 * Pick an ore block id at (x,y,z) given biome + surface height.
 * Returns 0 if no ore. You decide to place stone otherwise.
 */
export function pickOreId(
  x: number,
  y: number,
  z: number,
  biome: BiomeId,
  surfaceHeight: number,
  table: Record<BiomeId, OrePick[]>
): number {
  const picks = table[biome] || [];
  if (!picks.length) return 0;

  // Only in stone zone: must be sufficiently below the surface
  // (caller should already ensure base is stone)
  for (let i = 0; i < picks.length; i++) {
    const p = picks[i];
    if (!p || !p.id) continue;
    if (surfaceHeight - y < p.minDepthBelowSurface) continue;

    const h = hash3d(x, y, z, p.id);
    if (h > p.thresh) return p.id;
  }
  return 0;
}

/**
 * 3D hash in [0..1) (used for ore checks)
 */
function hash3d(x: number, y: number, z: number, salt: number) {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7 + salt * 13.37) * 43758.5453123;
  return fract(s);
}
