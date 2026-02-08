// ============================================================
// src/world/regions/applyBlueprint.ts
// ------------------------------------------------------------
// Town of Beginnings v2 (ARTISTIC OVERHAUL + FIX)
//
// Features:
// - ASCII Prefab System: Draw buildings in text!
// - "The Hero's Fountain" Centerpiece
// - Detailed Cottages with peaked roofs & log framing
// - Market Stalls
// - Procedural Tree generation
// - Textural variation in roads
// - EXPORTED inTownSafeZone helper (Required by MyRoom.ts)
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

export const TOWN_GROUND_Y = 10;
export const TOWN_STAMP_VERSION = "town_v3_artistic_overhaul";

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

  for (let i = 0; i <= len; i++) {
    // Foundation
    for (let y = -2; y < yBase; y++) world.applyPlace(cx, y, cz, BLOCKS.STONE);
    // Wall
    for (let y = yBase; y < yBase + 5; y++) world.applyPlace(cx, y, cz, BLOCKS.STONE);
    // Crenellations (every other block)
    if (i % 2 === 0) world.applyPlace(cx, yBase + 5, cz, BLOCKS.STONE);

    cx += dx;
    cz += dz;
  }
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

  // 1. Clear Air
  // (Simplified clearing - assumes relatively flat world or we just overwrite)
  // For a perfect clear, we'd loop x/z/y. Let's just build additively for performance 
  // and ensure we overwrite the ground.

  // 2. Base Ground (Grass Circle)
  const r = TOWN_SAFE_ZONE.radius;
  for (let x = -r; x <= r; x++) {
    for (let z = -r; z <= r; z++) {
      if (x*x + z*z > r*r) continue;
      
      const wx = cx + x;
      const wz = cz + z;
      
      // Foundation to prevent floating
      for (let y = -2; y < gy; y++) {
        world.applyPlace(wx, y, wz, BLOCKS.DIRT);
      }
      world.applyPlace(wx, gy, wz, BLOCKS.GRASS);
      
      // Clear up a bit
      for(let y=1; y<=10; y++) world.applyBreak(wx, gy+y, wz);
    }
  }

  // 3. Roads (Cross shape + Ring)
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

  // 4. Centerpiece: Fountain
  pasteSchematic(world, cx - 3, gy + 1, cz - 3, FOUNTAIN);

  // 5. Buildings
  // North House
  pasteSchematic(world, cx - 15, gy + 1, cz + 28, HOUSE_SMALL, 2);
  // East House
  pasteSchematic(world, cx + 28, gy + 1, cz - 15, HOUSE_SMALL, 3);
  // West House
  pasteSchematic(world, cx - 28, gy + 1, cz + 10, HOUSE_SMALL, 1);
  
  // Market Area (South-East)
  pasteSchematic(world, cx + 15, gy + 1, cz + 15, MARKET_STALL, 0);
  pasteSchematic(world, cx + 24, gy + 1, cz + 15, MARKET_STALL, 1);

  // 6. Outer Walls (Octagon-ish)
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


  // 7. Vegetation (Fill empty grass spots)
  for (let i = 0; i < 40; i++) {
    const rx = Math.floor((Math.random() - 0.5) * r * 1.5);
    const rz = Math.floor((Math.random() - 0.5) * r * 1.5);
    
    // Check if we are on grass (not road, not house)
    const floor = world.getBlock(cx+rx, gy, cz+rz);
    const above = world.getBlock(cx+rx, gy+1, cz+rz);
    
    if (floor === BLOCKS.GRASS && above === BLOCKS.AIR) {
      spawnTree(world, cx+rx, gy+1, cz+rz);
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