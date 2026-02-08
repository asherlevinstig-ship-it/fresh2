// ============================================================
// src/world/regions/applyBlueprint.ts
// ------------------------------------------------------------
// Town of Beginnings v2.2 (TERRAFORMED SLOPE + WATERTIGHT WALLS)
//
// Features:
// - ASCII Prefab System: Draw buildings in text!
// - "The Hero's Fountain" Centerpiece
// - Detailed Cottages with peaked roofs & log framing
// - Market Stalls
// - Procedural Tree generation
// - Textural variation in roads
// - EXPORTED inTownSafeZone helper (Required by MyRoom.ts)
// - FIX: Diagonal walls are now watertight (no edge gaps)
// - FIX: Added "Terraforming Skirt" to blend town into world
// - FIX: Lowered town height slightly to match world average
//
// ============================================================

import * as fs from "fs";
import * as path from "path";
import { WorldStore, BLOCKS, type BlockId } from "../WorldStore.js";

// -----------------------------
// Configuration
// -----------------------------

export const TOWN_SAFE_ZONE = {
  center: { x: 0, z: 0 },
  radius: 48, // Slightly larger than v1
  yMin: -64,
  yMax: 256,
};

// LOWERED from 10 to 6 to align better with world generation
export const TOWN_GROUND_Y = 6;
// How far out to slope the terrain so it doesn't look like a cliff
const TOWN_SLOPE_WIDTH = 24; 

export const TOWN_STAMP_VERSION = "town_v3.2_terraformed_slope";

// -----------------------------
// Safe Zone Helper (Fix for TS2724)
// -----------------------------

export function inTownSafeZone(x: number, y: number, z: number) {
  const r = TOWN_SAFE_ZONE;
  
  // Check height bounds
  if (y < r.yMin || y > r.yMax) return false;
  
  // Check radius (circle)
  const dx = x - r.center.x;
  const dz = z - r.center.z;
  return Math.sqrt(dx * dx + dz * dz) <= r.radius;
}

// -----------------------------
// Block Palette
// -----------------------------
// We map ASCII chars to your BlockIds for readable schematics

const P = {
  _: BLOCKS.AIR,
  D: BLOCKS.DIRT,
  G: BLOCKS.GRASS,
  S: BLOCKS.STONE,
  L: BLOCKS.LOG,
  W: (BLOCKS as any).PLANKS ?? BLOCKS.LOG, // Wood Planks
  V: BLOCKS.LEAVES, // Vegetation
  R: BLOCKS.STONE,  // Road (Stone/Gravel mix logic handled in code)
  C: (BLOCKS as any).COAL_ORE ?? BLOCKS.STONE, // Cobble/Dark stone substitute
  F: BLOCKS.LOG,    // Fence substitute
  X: BLOCKS.DIRT,   // Foundation filler
  T: BLOCKS.LOG,    // Trunk
  I: (BLOCKS as any).ICE ?? BLOCKS.STONE,    // Water/Ice substitute
  O: (BLOCKS as any).GOLD_ORE ?? BLOCKS.STONE, // Lamp/Light source
};

// -----------------------------
// Prefab System (The Magic)
// -----------------------------

type SchematicLayer = string[]; // Array of strings, each string is a row Z
type Schematic = SchematicLayer[]; // Array of layers (Y axis, bottom to top)

/**
 * Pastes a 3D ASCII schematic into the world.
 * Legend:
 * - Chars mapped in palette P
 * - '.' = Skip (Keep existing block)
 */
function pasteSchematic(
  world: WorldStore, 
  ox: number, oy: number, oz: number, 
  schematic: Schematic,
  rotation: 0 | 1 | 2 | 3 = 0
) {
  let blocksTouched = 0;

  schematic.forEach((layer, yOffset) => {
    const y = oy + yOffset;
    
    layer.forEach((rowStr, zIndex) => {
      [...rowStr].forEach((char, xIndex) => {
        if (char === '.') return; // Skip

        // Handle Rotation (0=0deg, 1=90deg, 2=180deg, 3=270deg)
        // We rotate around the schematic's local (0,0) origin
        let x = xIndex;
        let z = zIndex;
        const width = rowStr.length;
        const depth = layer.length;

        if (rotation === 1) { const t = x; x = depth - 1 - z; z = t; }
        else if (rotation === 2) { x = width - 1 - x; z = depth - 1 - z; }
        else if (rotation === 3) { const t = x; x = z; z = width - 1 - t; }

        const wx = ox + x;
        const wz = oz + z;

        // Block Palette Lookup
        let blockId = (P as any)[char] ?? BLOCKS.AIR;

        // Special Randomization logic
        if (char === 'R') {
          // Road: Mix Gravel and Stone
          blockId = Math.random() > 0.7 ? ((BLOCKS as any).GRAVEL ?? BLOCKS.STONE) : BLOCKS.STONE;
        }

        // Apply
        if (world.getBlock(wx, y, wz) !== blockId) {
            // Simple break then place
            if (blockId === BLOCKS.AIR) world.applyBreak(wx, y, wz);
            else world.applyPlace(wx, y, wz, blockId);
            blocksTouched++;
        }
      });
    });
  });

  return blocksTouched;
}

// -----------------------------
// Assets (The "Look")
// -----------------------------

// A nice cozy cottage with a peaked roof
const HOUSE_SMALL: Schematic = [
  // Floor 0 (Foundation/Floor)
  [
    "LLLLLLL",
    "LWWWWWL",
    "LWWWWWL",
    "LWWWWWL",
    "LWWWWWL",
    "LWWWWWL",
    "LLLLLLL"
  ],
  // Floor 1 (Walls + Door)
  [
    "LWWWWWL",
    "W_____W",
    "W_____W",
    "W_____W",
    "W_____W",
    "W_____W",
    "LW_W_WL" // Door gap
  ],
  // Floor 2 (Walls + Windows)
  [
    "LWWWWWL",
    "W_____W",
    "W_____W",
    "W_____W",
    "W_____W",
    "W_____W",
    "LWWWWWL"
  ],
  // Floor 3 (Roof Base)
  [
    "LLLLLLL",
    "LLLLLLL",
    "LLLLLLL",
    "LLLLLLL",
    "LLLLLLL",
    "LLLLLLL",
    "LLLLLLL"
  ],
  // Floor 4 (Roof Peak 1)
  [
    ".......",
    ".WWWWW.",
    ".WWWWW.",
    ".WWWWW.",
    ".WWWWW.",
    ".WWWWW.",
    "......."
  ],
  // Floor 5 (Roof Peak 2)
  [
    ".......",
    ".......",
    "..WWW..",
    "..WWW..",
    "..WWW..",
    ".......",
    "......."
  ],
  // Floor 6 (Chimney top)
  [
    ".......",
    ".......",
    "...S...",
    "...O...", // Light on top
    ".......",
    ".......",
    "......."
  ]
];

const MARKET_STALL: Schematic = [
  [
    "LL...LL",
    ".......",
    ".......",
    "LL...LL"
  ],
  [
    "L.....L",
    ".......",
    "WWW.WWW", // Counters
    "L.....L"
  ],
  [
    "L.....L",
    ".......",
    ".......",
    "L.....L"
  ],
  [
    "VVVVVVV", // Wool/Leaves roof
    "VVVVVVV",
    "VVVVVVV",
    "VVVVVVV"
  ]
];

const FOUNTAIN: Schematic = [
  // Base
  [
    ".SSSSS.",
    "SSSSSSS",
    "SSSSSSS",
    "SSSSSSS",
    "SSSSSSS",
    "SSSSSSS",
    ".SSSSS."
  ],
  // Rim + Water
  [
    ".SSSSS.",
    "SIIIIIS",
    "SIIIIIS",
    "SIIOSIS", // Center pillar base
    "SIIIIIS",
    "SIIIIIS",
    ".SSSSS."
  ],
  // Pillar
  [
    ".......",
    ".......",
    ".......",
    "...S...",
    ".......",
    ".......",
    "......."
  ],
  // Top
  [
    ".......",
    ".......",
    "...O...", // Light/Gold top
    "...S...",
    "...O...",
    ".......",
    "......."
  ]
];

// -----------------------------
// Procedural Logic
// -----------------------------

function spawnTree(world: WorldStore, x: number, y: number, z: number) {
  const height = 4 + Math.floor(Math.random() * 3);
  
  // Trunk
  for (let i = 0; i < height; i++) {
    world.applyPlace(x, y + i, z, BLOCKS.LOG);
  }

  // Leaves
  const crownY = y + height - 1;
  for (let ly = crownY - 2; ly <= crownY + 1; ly++) {
    const radius = ly === crownY + 1 ? 1 : 2;
    for (let lx = x - radius; lx <= x + radius; lx++) {
      for (let lz = z - radius; lz <= z + radius; lz++) {
        // Round corners
        if (Math.abs(lx - x) === radius && Math.abs(lz - z) === radius && Math.random() > 0.2) continue;
        
        const existing = world.getBlock(lx, ly, lz);
        if (existing === BLOCKS.AIR) {
          world.applyPlace(lx, ly, lz, BLOCKS.LEAVES);
        }
      }
    }
  }
}

function drawWall(world: WorldStore, x1: number, z1: number, x2: number, z2: number, yBase: number) {
  // Simple Bresenham-like line for straight walls
  const dx = Math.sign(x2 - x1);
  const dz = Math.sign(z2 - z1);
  let cx = x1;
  let cz = z1;
  
  const len = Math.max(Math.abs(x2 - x1), Math.abs(z2 - z1));

  // If both dx and dz are non-zero, it's a diagonal wall.
  // We need to fill the gap to make it watertight (no edge-only connections).
  const isDiagonal = (dx !== 0 && dz !== 0);

  for (let i = 0; i <= len; i++) {
    // 1. Draw the primary column at (cx, cz)
    drawColumn(world, cx, cz, yBase, i % 2 === 0);

    // 2. If diagonal, draw a filler column to seal the gap
    // We place it at (cx + dx, cz) which is the "step" in X before the step in Z.
    // This creates a solid stair-step pattern.
    if (isDiagonal && i < len) {
        drawColumn(world, cx + dx, cz, yBase, (i+1) % 2 === 0);
    }

    cx += dx;
    cz += dz;
  }
}

// Helper to draw a single vertical slice of the wall
function drawColumn(world: WorldStore, x: number, z: number, yBase: number, crenellation: boolean) {
    // Foundation (ensure it hits ground)
    for (let y = -2; y < yBase; y++) world.applyPlace(x, y, z, BLOCKS.STONE);
    // Main Wall Body (5 blocks high)
    for (let y = yBase; y < yBase + 5; y++) world.applyPlace(x, y, z, BLOCKS.STONE);
    // Crenellations (Battlements) on top
    if (crenellation) world.applyPlace(x, yBase + 5, z, BLOCKS.STONE);
}

// -----------------------------
// Main Logic
// -----------------------------

export function stampTownOfBeginnings(world: WorldStore, opts?: { verbose?: boolean; force?: boolean }) {
  const metaPath = path.join(process.cwd(), "town_stamp.json");
  let meta: any = null;
  try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch {}

  const forced = !!opts?.force;

  // Use the constant here
  if (!forced && meta?.version === TOWN_STAMP_VERSION) {
    if (opts?.verbose) console.log(`[TOWN] Already stamped v${TOWN_STAMP_VERSION}`);
    return { stamped: false, forced: false, version: TOWN_STAMP_VERSION, opsApplied: 0, blocksTouched: 0, metaPath };
  }

  if (opts?.verbose) console.log(`[TOWN] Stamping v${TOWN_STAMP_VERSION}...`);

  const cx = TOWN_SAFE_ZONE.center.x;
  const cz = TOWN_SAFE_ZONE.center.z;
  const gy = TOWN_GROUND_Y;
  const r = TOWN_SAFE_ZONE.radius;

  // 1. TERRAFORMING: Create a slope from the town edge down to the world
  // We go from Radius 0 out to Radius + SlopeWidth
  const totalR = r + TOWN_SLOPE_WIDTH;

  for (let x = -totalR; x <= totalR; x++) {
    for (let z = -totalR; z <= totalR; z++) {
      const dist = Math.sqrt(x*x + z*z);
      if (dist > totalR) continue;

      const wx = cx + x;
      const wz = cz + z;

      let surfaceY = gy;

      // If outside the flat town circle, slope it down
      if (dist > r) {
        const distanceFromEdge = dist - r;
        // Slope formula: Linear drop off with some noise
        // Approx 1 block down every 1.5 blocks out
        const drop = Math.floor(distanceFromEdge * 0.7);
        surfaceY = gy - drop;
      }

      // Don't modify if it goes too deep (let natural terrain handle deep caves)
      if (surfaceY < -5) continue;

      // FILL THE COLUMN
      // We fill from bottom up to surfaceY to ensure it's solid
      // We start at -10 (bedrock-ish) to ensure no floating islands
      for (let y = -10; y <= surfaceY; y++) {
        let block = BLOCKS.DIRT;
        
        // Visuals: Grass on top, Dirt below, Stone deep down
        if (y === surfaceY) block = BLOCKS.GRASS;
        else if (y < surfaceY - 3) block = BLOCKS.STONE;
        
        // Force placement to overwrite any air pockets or existing trees
        world.applyPlace(wx, y, wz, block);
      }

      // Clear air above the surface (to remove trees buried in the slope)
      // We clear a bit higher near the town
      const clearHeight = (dist <= r) ? 20 : 5;
      for (let y = surfaceY + 1; y <= surfaceY + clearHeight; y++) {
        world.applyBreak(wx, y, wz);
      }
    }
  }

  // 2. Roads (Cross shape + Ring)
  for (let x = -r + 2; x <= r - 2; x++) {
    for (let z = -r + 2; z <= r - 2; z++) {
      const dist = Math.sqrt(x*x + z*z);
      const isRing = dist > 20 && dist < 25;
      const isCross = (Math.abs(x) < 4 || Math.abs(z) < 4);

      if (isRing || isCross) {
         // Mix materials for detail
         const mat = Math.random() > 0.2 ? ((BLOCKS as any).GRAVEL ?? BLOCKS.STONE) : BLOCKS.STONE;
         world.applyPlace(cx + x, gy, cz + z, mat);
      }
    }
  }

  // 3. Centerpiece: Fountain
  pasteSchematic(world, cx - 3, gy + 1, cz - 3, FOUNTAIN);

  // 4. Buildings
  // North House
  pasteSchematic(world, cx - 15, gy + 1, cz + 28, HOUSE_SMALL, 2);
  // East House
  pasteSchematic(world, cx + 28, gy + 1, cz - 15, HOUSE_SMALL, 3);
  // West House
  pasteSchematic(world, cx - 28, gy + 1, cz + 10, HOUSE_SMALL, 1);
  
  // Market Area (South-East)
  pasteSchematic(world, cx + 15, gy + 1, cz + 15, MARKET_STALL, 0);
  pasteSchematic(world, cx + 24, gy + 1, cz + 15, MARKET_STALL, 1);

  // 5. Outer Walls (Octagon-ish) with Watertight Fix
  const wallR = r - 2;
  // N
  drawWall(world, cx-10, cz+wallR, cx+10, cz+wallR, gy+1);
  // S
  drawWall(world, cx-10, cz-wallR, cx+10, cz-wallR, gy+1);
  // E
  drawWall(world, cx+wallR, cz-10, cx+wallR, cz+10, gy+1);
  // W
  drawWall(world, cx-wallR, cz-10, cx-wallR, cz+10, gy+1);
  
  // Diagonals (Manual simple connection)
  // NE
  drawWall(world, cx+10, cz+wallR, cx+wallR, cz+10, gy+1);
  // NW
  drawWall(world, cx-10, cz+wallR, cx-wallR, cz+10, gy+1);
  // SE
  drawWall(world, cx+10, cz-wallR, cx+wallR, cz-10, gy+1);
  // SW
  drawWall(world, cx-10, cz-wallR, cx-wallR, cz-10, gy+1);


  // 6. Vegetation (Fill empty grass spots inside town)
  for (let i = 0; i < 40; i++) {
    const rx = Math.floor((Math.random() - 0.5) * r * 1.5);
    const rz = Math.floor((Math.random() - 0.5) * r * 1.5);
    
    // Check if valid spot (flat grass)
    if (inTownSafeZone(cx+rx, gy, cz+rz)) {
        const floor = world.getBlock(cx+rx, gy, cz+rz);
        const above = world.getBlock(cx+rx, gy+1, cz+rz);
        
        if (floor === BLOCKS.GRASS && above === BLOCKS.AIR) {
            spawnTree(world, cx+rx, gy+1, cz+rz);
        }
    }
  }

  // Save meta
  try {
    fs.writeFileSync(metaPath, JSON.stringify({ version: TOWN_STAMP_VERSION, at: Date.now() }));
  } catch {}

  // Return structure matching old signature to be safe
  return { 
      stamped: true, 
      forced: forced, 
      version: TOWN_STAMP_VERSION, 
      opsApplied: 1, 
      blocksTouched: 1, 
      metaPath 
  };
}