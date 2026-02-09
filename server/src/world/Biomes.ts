// ============================================================
// src/world/Biomes.ts
// ------------------------------------------------------------
// FULL REWRITE - NO OMITS - ALL LOGIC INCLUDED
//
// PURPOSE:
// - Deterministic biome selection from (x,z) coordinates.
// - Deterministic height map generation.
// - Deterministic surface/subsurface block layering.
// - Deterministic vegetation (Trees, Cacti) placement.
// - Deterministic ore generation based on depth and biome.
//
// DESIGN:
// - Pure functions where possible.
// - No imports from 'WorldStore' to avoid circular dependencies.
// - Relies on a 'palette' object passed in for block IDs.
// ============================================================

// ------------------------------------------------------------
// 1. Types & Interfaces
// ------------------------------------------------------------

export type BiomeId =
  | "plains"
  | "forest"
  | "desert"
  | "tundra"
  | "mountains"
  | "swamp";

export interface BiomeSample {
  biome: BiomeId;
  height: number;        // The integer y-level of the surface
  humidity: number;      // 0.0 to 1.0
  temperature: number;   // 0.0 to 1.0
  mountains: number;     // 0.0 to 1.0 (Mountain intensity mask)
  swampiness: number;    // 0.0 to 1.0 (Swamp intensity mask)
}

export type TreeType = "oak" | "pine";

export interface TreeSpec {
  type: TreeType;
  trunkHeight: number;
  canopyRadius: number;  // Horizontal radius of leaves
  canopyHeight: number;  // Vertical height of leaves
  leafDensity: number;   // 0.0 to 1.0 (Probability of a leaf block spawning)
}

export interface OreTables {
  common: number[];
  uncommon: number[];
  rare: number[];
  epic: number[];
}

// ------------------------------------------------------------
// 2. Deterministic Math & Noise Helpers
// ------------------------------------------------------------

/** Returns the fractional part of a number (e.g. 1.25 -> 0.25) */
function frac(n: number): number {
  return n - Math.floor(n);
}

/** Linear interpolation between a and b by t */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Clamps a value between 0 and 1 */
function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/** Smooth Hermite interpolation (0..1 -> 0..1), smooths edges */
function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

/**
 * 2D Pseudo-random hash.
 * Returns a deterministic value between 0 and 1 based on x, z.
 */
function hash2(x: number, z: number): number {
  // Large primes for mixing
  const n = Math.sin(x * 127.1 + z * 311.7) * 43758.5453123;
  return frac(n);
}

/**
 * 3D Pseudo-random hash.
 * Returns a deterministic value between 0 and 1 based on x, y, z.
 */
function hash3(x: number, y: number, z: number): number {
  const n = Math.sin(x * 127.1 + y * 269.5 + z * 311.7) * 43758.5453123;
  return frac(n);
}

/**
 * 2D Value Noise.
 * Generates smooth noise by interpolating between random values at integer grid points.
 */
function valueNoise2(x: number, z: number): number {
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

/**
 * Fractal Brownian Motion (FBM) - 2D.
 * layers multiple octaves of noise to create detail.
 * @param octaves Number of layers (more = more detail/roughness)
 * @param lacunarity How much frequency increases per octave (usually 2.0)
 * @param gain How much amplitude decreases per octave (usually 0.5)
 */
function fbm2(x: number, z: number, octaves = 4, lacunarity = 2, gain = 0.5): number {
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
// 3. Biome Selection & Height Generation
// ------------------------------------------------------------

/**
 * Main function to query the environment at a specific column.
 * Calculates climate, selects biome, and computes surface height.
 */
export function sampleBiome(x: number, z: number): BiomeSample {
  // Scale coordinates down for broad, coherent regions
  const sx = x / 180;
  const sz = z / 180;

  // 1. Generate Climate Fields
  // Temperature: 0 = Cold, 1 = Hot
  const temperature = clamp01(fbm2(sx + 10, sz - 20, 4, 2, 0.55));
  
  // Humidity: 0 = Dry, 1 = Wet
  const humidity = clamp01(fbm2(sx - 40, sz + 30, 4, 2, 0.55));

  // Mountain Mask: 0 = Flat, 1 = Mountainous
  const mountains = clamp01(fbm2(sx + 200, sz + 200, 5, 2, 0.5));

  // Swamp Mask: Specific check for low, wet areas
  const swampiness = clamp01(fbm2(sx - 120, sz + 90, 4, 2, 0.55));

  // 2. Determine Biome
  let biome: BiomeId = "plains";

  // Priority Decision Tree
  if (mountains > 0.72) {
    biome = "mountains";
  } else if (temperature > 0.70 && humidity < 0.35) {
    biome = "desert"; // Hot and Dry
  } else if (temperature < 0.30) {
    biome = "tundra"; // Cold
  } else if (humidity > 0.65 && swampiness > 0.60) {
    biome = "swamp";  // Wet and swampy
  } else if (humidity > 0.55) {
    biome = "forest"; // Wet but not swampy
  } else {
    biome = "plains"; // Default moderate
  }

  // 3. Compute Terrain Height
  // Start with a base rolling wave (preserving original world feel)
  let h = Math.floor(4 * Math.sin(x / 15) + 4 * Math.cos(z / 20));

  // Add biome-specific noise details
  const n1 = fbm2(x / 90, z / 90, 4, 2, 0.55); // Large scale features
  const n2 = fbm2(x / 32, z / 32, 3, 2, 0.50); // Small scale roughness

  if (biome === "plains") {
    // Gentle rolling hills
    h += Math.floor((n1 - 0.5) * 4);
  } else if (biome === "forest") {
    // Slightly hillier than plains
    h += Math.floor((n1 - 0.5) * 6);
  } else if (biome === "desert") {
    // Dunes
    h += Math.floor((n1 - 0.5) * 5);
  } else if (biome === "tundra") {
    // Mostly flat, some roughness
    h += Math.floor((n1 - 0.5) * 4);
  } else if (biome === "swamp") {
    // Lowlands, often near or below sea level, slightly messy
    h += Math.floor((n2 - 0.5) * 3);
  } else if (biome === "mountains") {
    // Extreme variance, tall peaks
    h += Math.floor((n1 - 0.3) * 18); 
  }

  return {
    biome,
    height: h | 0, // Ensure integer
    humidity,
    temperature,
    mountains,
    swampiness,
  };
}

// ------------------------------------------------------------
// 4. Terrain Layering (Surface Blocks)
// ------------------------------------------------------------

/**
 * Determines which block to place at a specific depth below the surface.
 * @param palette Object containing block IDs (e.g. BLOCKS from WorldStore)
 * @param biome The current biome
 * @param depth Distance from surface (0 = surface block)
 */
export function getTerrainLayerBlockId(
  palette: any,
  biome: BiomeId,
  depth: number
): number {
  // Default fallback IDs (if palette is missing keys)
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

  // --- Biome Specific Rules ---

  // Desert: Sand on top, sand below, then stone
  if (biome === "desert") {
    return SAND;
  }

  // Tundra: Snow on top, dirt below
  if (biome === "tundra") {
    return depth === 0 ? SNOW : DIRT;
  }

  // Swamp: Mud on top, Clay underneath, then Dirt
  if (biome === "swamp") {
    if (depth === 0) return MUD;
    if (depth === 1) return CLAY;
    return DIRT;
  }

  // Mountains: Exposed Stone (rugged look)
  if (biome === "mountains") {
    return STONE;
  }

  // Plains & Forest: Standard Grass on top, Dirt below
  return depth === 0 ? GRASS : DIRT;
}

// ------------------------------------------------------------
// 5. Vegetation: Trees
// ------------------------------------------------------------

/**
 * Determines if a tree should spawn at this (x, z) location.
 * Purely probabilistic based on biome density.
 */
export function shouldSpawnTree(x: number, z: number, biome: BiomeId): boolean {
  const r = hash2(x, z);

  if (biome === "forest") return r > 0.965;     // ~3.5% chance (Dense)
  if (biome === "plains") return r > 0.985;     // ~1.5% chance (Sparse)
  if (biome === "swamp") return r > 0.972;      // ~2.8% chance
  if (biome === "tundra") return r > 0.982;     // ~1.8% chance
  if (biome === "mountains") return r > 0.988;  // ~1.2% chance
  
  // Desert: No trees (Cacti handled separately)
  return false;
}

/**
 * Generates the specifications for a tree at (x, z).
 * Returns height, type, and canopy shape.
 */
export function getTreeSpec(x: number, z: number, biome: BiomeId): TreeSpec {
  const r = hash2(x * 2 + 11, z * 2 - 7);       // 0..1 random
  const r2 = hash2(x * 3 - 19, z * 3 + 31);     // 0..1 random (variation)

  // Pine Trees (Tundra & Mountains)
  if (biome === "tundra" || biome === "mountains") {
    const trunkHeight = 5 + Math.floor(r * 3); // 5 to 7 blocks

    // Pine canopy is tall and narrow
    const canopyRadius = 2 + Math.floor(r2 * 2); // 2 to 3
    const canopyHeight = 3 + Math.floor(r * 2);  // 3 to 4

    return {
      type: "pine",
      trunkHeight,
      canopyRadius,
      canopyHeight,
      leafDensity: 0.75 + 0.20 * r2, // 0.75 to 0.95 density
    };
  }

  // Oak Trees (Forest, Plains, Swamp)
  const trunkHeight = 4 + Math.floor(r * 2); // 4 to 5 blocks
  const canopyRadius = 2 + Math.floor(r2 * 2); // 2 to 3
  const canopyHeight = 3 + Math.floor(r * 2);  // 3 to 4

  return {
    type: "oak",
    trunkHeight,
    canopyRadius,
    canopyHeight,
    leafDensity: 0.80 + 0.15 * r2, // 0.80 to 0.95 density
  };
}

// ------------------------------------------------------------
// 6. Vegetation: Cacti (Deserts)
// ------------------------------------------------------------

export function shouldSpawnCactus(x: number, z: number, biome: BiomeId): boolean {
  if (biome !== "desert") return false;
  const r = hash2(x + 999, z - 999);
  return r > 0.988; // ~1.2% chance
}

export function getCactusHeight(x: number, z: number): number {
  const r = hash2(x * 3 + 5, z * 3 + 9);
  return 2 + Math.floor(r * 3); // Height 2 to 4
}

// ------------------------------------------------------------
// 7. Ore Generation
// ------------------------------------------------------------

/**
 * helper to build ore tables from the palette.
 * Filters out 0/undefined values safely.
 */
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
    common: [COAL, COPPER, IRON].filter((id) => id !== 0),
    uncommon: [IRON, SILVER, GOLD].filter((id) => id !== 0),
    rare: [GOLD, RUBY, SAPPHIRE].filter((id) => id !== 0),
    epic: [MYTHRIL, DRAGONSTONE].filter((id) => id !== 0),
  };
}

/**
 * Safely picks an item from an array using a normalized t value (0..1)
 */
function pickFrom(arr: number[], t: number): number {
  if (!arr || arr.length === 0) return 0;
  const idx = Math.floor(t * arr.length);
  return arr[Math.max(0, Math.min(arr.length - 1, idx))] || 0;
}

/**
 * Determines if a stone block should be replaced by ore.
 * @param x World X
 * @param y World Y (depth check)
 * @param z World Z
 * @param biome Biome context
 * @param surfaceHeight The surface Y at this column (used to calc depth)
 * @param tables The ore tables
 * @returns Block ID of the ore, or 0 if no ore.
 */
export function pickOreId(
  x: number,
  y: number,
  z: number,
  biome: BiomeId,
  surfaceHeight: number,
  tables: OreTables
): number {
  // 1. Depth Check
  const depthBelowSurface = surfaceHeight - y;
  
  // No ores immediately at surface (must be at least 4 blocks down)
  if (depthBelowSurface < 4) return 0;

  // 2. Base Chance Roll
  const r = hash3(x, y, z);

  // Depth Scaler: Deeper = Higher chance of ore
  const deepFactor = clamp01((depthBelowSurface - 8) / 40);

  // Biome Modifiers
  const biomeBonus = biome === "mountains" ? 0.08 : biome === "swamp" ? -0.02 : 0;

  // Calculate probability threshold
  // Ranges from ~8% (shallow) to ~28% (deep/mountains)
  const chanceThreshold = 0.08 + deepFactor * 0.10 + biomeBonus;

  if (r > chanceThreshold) return 0; // No ore here

  // 3. Tier Selection
  // We use a second hash to determine WHICH ore
  const r2 = hash3(x + 99, y - 77, z + 33);

  // Tier Thresholds (Dynamic based on depth)
  const epicThreshold = 0.02 + deepFactor * 0.08;   // Up to ~10% chance
  const rareThreshold = 0.10 + deepFactor * 0.18;   // Up to ~28% chance
  const uncommonThreshold = 0.35 + deepFactor * 0.25; // Up to ~60% chance

  // Use distinct hash seeds for the specific pick to avoid patterns
  if (r2 < epicThreshold) {
    return pickFrom(tables.epic, hash3(x + 7, y + 7, z + 7));
  }
  if (r2 < rareThreshold) {
    return pickFrom(tables.rare, hash3(x + 8, y + 8, z + 8));
  }
  if (r2 < uncommonThreshold) {
    return pickFrom(tables.uncommon, hash3(x + 9, y + 9, z + 9));
  }
  
  // Fallback to common
  return pickFrom(tables.common, hash3(x + 10, y + 10, z + 10));
}