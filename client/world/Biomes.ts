// ============================================================
// src/world/Biomes.ts
// ------------------------------------------------------------
// FULL REWRITE - DETERMINISTIC GENERATION LOGIC
//
// PURPOSE:
// - Defines biome selection, height maps, and vegetation rules.
// - PURE FUNCTIONS ONLY: Depends only on (x, y, z) inputs.
// - SHARED: Identical copy used by Client (visualization) and Server (physics/storage).
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
  height: number;        // Integer Y surface level
  humidity: number;      // 0..1
  temperature: number;   // 0..1
  mountains: number;     // 0..1 (intensity mask)
  swampiness: number;    // 0..1 (intensity mask)
};

export type TreeType = "oak" | "pine";

export type TreeSpec = {
  type: TreeType;
  trunkHeight: number;
  canopyRadius: number;
  canopyHeight: number;
  leafDensity: number;   // 0..1
};

export type OreTables = {
  common: number[];
  uncommon: number[];
  rare: number[];
  epic: number[];
};

// ------------------------------------------------------------
// 1. Math Helpers (Deterministic)
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
  return t * t * (3 - 2 * t);
}

// ------------------------------------------------------------
// 2. Noise Functions (The DNA of the World)
// ------------------------------------------------------------

// Hash 2D: Returns deterministic 0..1
function hash2(x: number, z: number) {
  const n = Math.sin(x * 127.1 + z * 311.7) * 43758.5453123;
  return frac(n);
}

// Hash 3D: Returns deterministic 0..1
function hash3(x: number, y: number, z: number) {
  const n = Math.sin(x * 127.1 + y * 269.5 + z * 311.7) * 43758.5453123;
  return frac(n);
}

// Value Noise 2D: Smooth interpolated noise
function valueNoise2(x: number, z: number) {
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

// Fractal Brownian Motion (FBM): Layers noise for detail
function fbm2(x: number, z: number, octaves = 4, lacunarity = 2, gain = 0.5) {
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
// 3. Biome Sampling Logic
// ------------------------------------------------------------

export function sampleBiome(x: number, z: number): BiomeSample {
  // Scale coords for broad regional features
  const sx = x / 180;
  const sz = z / 180;

  // 1. Climate Fields
  const temperature = clamp01(fbm2(sx + 10, sz - 20, 4, 2, 0.55));
  const humidity = clamp01(fbm2(sx - 40, sz + 30, 4, 2, 0.55));

  // 2. Feature Masks
  // Mountains: High frequency + High amplitude potential
  const mountains = clamp01(fbm2(sx + 200, sz + 200, 5, 2, 0.5));
  // Swamp: Low lying, high humidity mask
  const swampiness = clamp01(fbm2(sx - 120, sz + 90, 4, 2, 0.55));

  // 3. Determine Biome ID
  let biome: BiomeId = "plains";

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

  // 4. Calculate Height
  // Base rolling hills
  const base = Math.floor(4 * Math.sin(x / 15) + 4 * Math.cos(z / 20));

  // Height noise layers
  const n1 = fbm2(x / 90, z / 90, 4, 2, 0.55); // Medium detail
  const n2 = fbm2(x / 32, z / 32, 3, 2, 0.50); // Fine detail

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
    // Swamps are flatter/lower
    h += Math.floor((n2 - 0.5) * 3);
  } else if (biome === "mountains") {
    // Mountains add massive height variance
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
// 4. Layering Rules (Surface vs Subsurface)
// ------------------------------------------------------------

export function getTerrainLayerBlockId(
  palette: any,
  biome: BiomeId,
  depth: number
): number {
  // Safe Fallbacks
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

  // Deep underground is always stone
  if (depth >= 3) return STONE;

  // Biome-specific topsoil rules
  if (biome === "desert") {
    return SAND; // Sand all the way down to stone
  }

  if (biome === "tundra") {
    return depth === 0 ? SNOW : DIRT;
  }

  if (biome === "swamp") {
    if (depth === 0) return MUD;
    if (depth === 1) return CLAY;
    return DIRT;
  }

  if (biome === "mountains") {
    return STONE; // Bare rock mountains
  }

  // Default (Plains/Forest)
  return depth === 0 ? GRASS : DIRT;
}

// ------------------------------------------------------------
// 5. Vegetation Logic
// ------------------------------------------------------------

export function shouldSpawnTree(x: number, z: number, biome: BiomeId) {
  const r = hash2(x, z);

  if (biome === "forest") return r > 0.965;    // High density
  if (biome === "plains") return r > 0.985;    // Low density
  if (biome === "swamp") return r > 0.972;     // Medium density
  if (biome === "tundra") return r > 0.982;    // Low density
  if (biome === "mountains") return r > 0.988; // Very low density
  return false; // Desert
}

export function getTreeSpec(x: number, z: number, biome: BiomeId): TreeSpec {
  const r = hash2(x * 2 + 11, z * 2 - 7);
  const r2 = hash2(x * 3 - 19, z * 3 + 31);

  if (biome === "tundra" || biome === "mountains") {
    // Pine Trees
    return {
      type: "pine",
      trunkHeight: 5 + Math.floor(r * 3),
      canopyRadius: 2 + Math.floor(r2 * 2),
      canopyHeight: 3 + Math.floor(r * 2),
      leafDensity: 0.75 + 0.20 * r2,
    };
  }

  // Oak Trees (Default)
  return {
    type: "oak",
    trunkHeight: 4 + Math.floor(r * 2),
    canopyRadius: 2 + Math.floor(r2 * 2),
    canopyHeight: 3 + Math.floor(r * 2),
    leafDensity: 0.80 + 0.15 * r2,
  };
}

export function shouldSpawnCactus(x: number, z: number, biome: BiomeId) {
  if (biome !== "desert") return false;
  const r = hash2(x + 999, z - 999);
  return r > 0.988;
}

export function getCactusHeight(x: number, z: number) {
  const r = hash2(x * 3 + 5, z * 3 + 9);
  return 2 + Math.floor(r * 3);
}

// ------------------------------------------------------------
// 6. Ore Generation Logic
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

  return {
    common: [COAL, COPPER, IRON].filter(Boolean),
    uncommon: [IRON, SILVER, GOLD].filter(Boolean),
    rare: [GOLD, RUBY, SAPPHIRE].filter(Boolean),
    epic: [MYTHRIL, DRAGONSTONE].filter(Boolean),
  };
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
  // Ore only spawns underground
  const depthBelowSurface = surfaceHeight - y;
  if (depthBelowSurface < 4) return 0;

  // Base chance check
  const r = hash3(x, y, z);
  const deep = clamp01((depthBelowSurface - 8) / 40); // 0..1 factor for depth
  const biomeBonus = biome === "mountains" ? 0.08 : biome === "swamp" ? -0.02 : 0;
  
  const baseChance = 0.08 + deep * 0.10 + biomeBonus;
  if (r > baseChance) return 0;

  // Rarity check
  const r2 = hash3(x + 99, y - 77, z + 33);
  const epicT = 0.02 + deep * 0.08;
  const rareT = 0.10 + deep * 0.18;
  const uncoT = 0.35 + deep * 0.25;

  if (r2 < epicT) return pickFrom(tables.epic, hash3(x + 7, y + 7, z + 7));
  if (r2 < rareT) return pickFrom(tables.rare, hash3(x + 8, y + 8, z + 8));
  if (r2 < uncoT) return pickFrom(tables.uncommon, hash3(x + 9, y + 9, z + 9));
  
  return pickFrom(tables.common, hash3(x + 10, y + 10, z + 10));
}