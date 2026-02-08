// ============================================================
// src/world/regions/applyBlueprint.ts
// ------------------------------------------------------------
// Town of Beginnings v2.3 (FIXED BUILD ERROR)
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
// - FIX: Terraforming Skirt & Lower Elevation
// - FIX: Rotation type widened to 'number' to prevent TS compilation errors
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
  radius: 48,
  yMin: -64,
  yMax: 256,
};

// Town Ground Y Level (Lowered to 6 to match terrain better)
export const TOWN_GROUND_Y = 6;
const TOWN_SLOPE_WIDTH = 24; 

export const TOWN_STAMP_VERSION = "town_v3.3_fixed_build";

// -----------------------------
// Safe Zone Helper
// -----------------------------

export function inTownSafeZone(x: number, y: number, z: number) {
  const r = TOWN_SAFE_ZONE;
  if (y < r.yMin || y > r.yMax) return false;
  const dx = x - r.center.x;
  const dz = z - r.center.z;
  return Math.sqrt(dx * dx + dz * dz) <= r.radius;
}

// -----------------------------
// Block Palette
// -----------------------------

const P = {
  _: BLOCKS.AIR,
  D: BLOCKS.DIRT,
  G: BLOCKS.GRASS,
  S: BLOCKS.STONE,
  L: BLOCKS.LOG,
  W: (BLOCKS as any).PLANKS ?? BLOCKS.LOG,
  V: BLOCKS.LEAVES,
  R: BLOCKS.STONE,  
  C: (BLOCKS as any).COAL_ORE ?? BLOCKS.STONE,
  F: BLOCKS.LOG,    
  X: BLOCKS.DIRT,   
  T: BLOCKS.LOG,    
  I: (BLOCKS as any).ICE ?? BLOCKS.STONE,    
  O: (BLOCKS as any).GOLD_ORE ?? BLOCKS.STONE,
};

// -----------------------------
// Prefab System
// -----------------------------

type SchematicLayer = string[];
type Schematic = SchematicLayer[];

/**
 * Pastes a 3D ASCII schematic into the world.
 * FIXED: 'rotation' type widened to number to avoid TS errors.
 */
function pasteSchematic(
  world: WorldStore, 
  ox: number, oy: number, oz: number, 
  schematic: Schematic,
  rotation: number = 0
) {
  let blocksTouched = 0;

  schematic.forEach((layer, yOffset) => {
    const y = oy + yOffset;
    
    layer.forEach((rowStr, zIndex) => {
      [...rowStr].forEach((char, xIndex) => {
        if (char === '.') return;

        let x = xIndex;
        let z = zIndex;
        const width = rowStr.length;
        const depth = layer.length;

        // Rotation Logic (0, 1, 2, 3)
        if (rotation === 1) { const t = x; x = depth - 1 - z; z = t; }
        else if (rotation === 2) { x = width - 1 - x; z = depth - 1 - z; }
        else if (rotation === 3) { const t = x; x = z; z = width - 1 - t; }

        const wx = ox + x;
        const wz = oz + z;

        let blockId = (P as any)[char] ?? BLOCKS.AIR;

        // Road randomization
        if (char === 'R') {
          blockId = Math.random() > 0.7 ? ((BLOCKS as any).GRAVEL ?? BLOCKS.STONE) : BLOCKS.STONE;
        }

        if (world.getBlock(wx, y, wz) !== blockId) {
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
// Assets
// -----------------------------

const HOUSE_SMALL: Schematic = [
  ["LLLLLLL","LWWWWWL","LWWWWWL","LWWWWWL","LWWWWWL","LWWWWWL","LLLLLLL"],
  ["LWWWWWL","W_____W","W_____W","W_____W","W_____W","W_____W","LW_W_WL"],
  ["LWWWWWL","W_____W","W_____W","W_____W","W_____W","W_____W","LWWWWWL"],
  ["LLLLLLL","LLLLLLL","LLLLLLL","LLLLLLL","LLLLLLL","LLLLLLL","LLLLLLL"],
  [".......",".WWWWW.",".WWWWW.",".WWWWW.",".WWWWW.",".WWWWW.","......."],
  [".......",".......","..WWW..","..WWW..","..WWW..",".......","......."],
  [".......",".......","...S...","...O...",".......",".......","......."]
];

const MARKET_STALL: Schematic = [
  ["LL...LL",".......",".......","LL...LL"],
  ["L.....L",".......","WWW.WWW","L.....L"],
  ["L.....L",".......",".......","L.....L"],
  ["VVVVVVV","VVVVVVV","VVVVVVV","VVVVVVV"]
];

const FOUNTAIN: Schematic = [
  [".SSSSS.","SSSSSSS","SSSSSSS","SSSSSSS","SSSSSSS","SSSSSSS",".SSSSS."],
  [".SSSSS.","SIIIIIS","SIIIIIS","SIIOSIS","SIIIIIS","SIIIIIS",".SSSSS."],
  [".......",".......",".......","...S...",".......",".......","......."],
  [".......",".......","...O...","...S...","...O...",".......","......."]
];

// -----------------------------
// Procedural Logic
// -----------------------------

function spawnTree(world: WorldStore, x: number, y: number, z: number) {
  const height = 4 + Math.floor(Math.random() * 3);
  for (let i = 0; i < height; i++) world.applyPlace(x, y + i, z, BLOCKS.LOG);
  const crownY = y + height - 1;
  for (let ly = crownY - 2; ly <= crownY + 1; ly++) {
    const radius = ly === crownY + 1 ? 1 : 2;
    for (let lx = x - radius; lx <= x + radius; lx++) {
      for (let lz = z - radius; lz <= z + radius; lz++) {
        if (Math.abs(lx - x) === radius && Math.abs(lz - z) === radius && Math.random() > 0.2) continue;
        const existing = world.getBlock(lx, ly, lz);
        if (existing === BLOCKS.AIR) world.applyPlace(lx, ly, lz, BLOCKS.LEAVES);
      }
    }
  }
}

function drawWall(world: WorldStore, x1: number, z1: number, x2: number, z2: number, yBase: number) {
  const dx = Math.sign(x2 - x1);
  const dz = Math.sign(z2 - z1);
  let cx = x1;
  let cz = z1;
  const len = Math.max(Math.abs(x2 - x1), Math.abs(z2 - z1));
  const isDiagonal = (dx !== 0 && dz !== 0);

  for (let i = 0; i <= len; i++) {
    drawColumn(world, cx, cz, yBase, i % 2 === 0);
    // Watertight fix: fill the corner gap
    if (isDiagonal && i < len) {
        drawColumn(world, cx + dx, cz, yBase, (i+1) % 2 === 0);
    }
    cx += dx;
    cz += dz;
  }
}

function drawColumn(world: WorldStore, x: number, z: number, yBase: number, crenellation: boolean) {
    for (let y = -2; y < yBase; y++) world.applyPlace(x, y, z, BLOCKS.STONE);
    for (let y = yBase; y < yBase + 5; y++) world.applyPlace(x, y, z, BLOCKS.STONE);
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

  if (!forced && meta?.version === TOWN_STAMP_VERSION) {
    if (opts?.verbose) console.log(`[TOWN] Already stamped v${TOWN_STAMP_VERSION}`);
    return { stamped: false, forced: false, version: TOWN_STAMP_VERSION, opsApplied: 0, blocksTouched: 0, metaPath };
  }

  if (opts?.verbose) console.log(`[TOWN] Stamping v${TOWN_STAMP_VERSION}...`);

  const cx = TOWN_SAFE_ZONE.center.x;
  const cz = TOWN_SAFE_ZONE.center.z;
  const gy = TOWN_GROUND_Y;
  const r = TOWN_SAFE_ZONE.radius;

  // 1. TERRAFORMING SKIRT
  const totalR = r + TOWN_SLOPE_WIDTH;

  for (let x = -totalR; x <= totalR; x++) {
    for (let z = -totalR; z <= totalR; z++) {
      const dist = Math.sqrt(x*x + z*z);
      if (dist > totalR) continue;

      const wx = cx + x;
      const wz = cz + z;

      let surfaceY = gy;

      if (dist > r) {
        const distanceFromEdge = dist - r;
        const drop = Math.floor(distanceFromEdge * 0.7);
        surfaceY = gy - drop;
      }

      if (surfaceY < -5) continue;

      for (let y = -10; y <= surfaceY; y++) {
        let block = BLOCKS.DIRT;
        if (y === surfaceY) block = BLOCKS.GRASS;
        else if (y < surfaceY - 3) block = BLOCKS.STONE;
        world.applyPlace(wx, y, wz, block);
      }

      const clearHeight = (dist <= r) ? 20 : 5;
      for (let y = surfaceY + 1; y <= surfaceY + clearHeight; y++) {
        world.applyBreak(wx, y, wz);
      }
    }
  }

  // 2. Roads
  for (let x = -r + 2; x <= r - 2; x++) {
    for (let z = -r + 2; z <= r - 2; z++) {
      const dist = Math.sqrt(x*x + z*z);
      const isRing = dist > 20 && dist < 25;
      const isCross = (Math.abs(x) < 4 || Math.abs(z) < 4);

      if (isRing || isCross) {
         const mat = Math.random() > 0.2 ? ((BLOCKS as any).GRAVEL ?? BLOCKS.STONE) : BLOCKS.STONE;
         world.applyPlace(cx + x, gy, cz + z, mat);
      }
    }
  }

  // 3. Centerpiece
  pasteSchematic(world, cx - 3, gy + 1, cz - 3, FOUNTAIN);

  // 4. Buildings
  pasteSchematic(world, cx - 15, gy + 1, cz + 28, HOUSE_SMALL, 2);
  pasteSchematic(world, cx + 28, gy + 1, cz - 15, HOUSE_SMALL, 3);
  pasteSchematic(world, cx - 28, gy + 1, cz + 10, HOUSE_SMALL, 1);
  pasteSchematic(world, cx + 15, gy + 1, cz + 15, MARKET_STALL, 0);
  pasteSchematic(world, cx + 24, gy + 1, cz + 15, MARKET_STALL, 1);

  // 5. Walls
  const wallR = r - 2;
  drawWall(world, cx-10, cz+wallR, cx+10, cz+wallR, gy+1); 
  drawWall(world, cx-10, cz-wallR, cx+10, cz-wallR, gy+1); 
  drawWall(world, cx+wallR, cz-10, cx+wallR, cz+10, gy+1); 
  drawWall(world, cx-wallR, cz-10, cx-wallR, cz+10, gy+1); 
  
  drawWall(world, cx+10, cz+wallR, cx+wallR, cz+10, gy+1); 
  drawWall(world, cx-10, cz+wallR, cx-wallR, cz+10, gy+1); 
  drawWall(world, cx+10, cz-wallR, cx+wallR, cz-10, gy+1); 
  drawWall(world, cx-10, cz-wallR, cx-wallR, cz-10, gy+1); 

  // 6. Vegetation
  for (let i = 0; i < 40; i++) {
    const rx = Math.floor((Math.random() - 0.5) * r * 1.5);
    const rz = Math.floor((Math.random() - 0.5) * r * 1.5);
    
    if (inTownSafeZone(cx+rx, gy, cz+rz)) {
        const floor = world.getBlock(cx+rx, gy, cz+rz);
        const above = world.getBlock(cx+rx, gy+1, cz+rz);
        if (floor === BLOCKS.GRASS && above === BLOCKS.AIR) {
            spawnTree(world, cx+rx, gy+1, cz+rz);
        }
    }
  }

  try {
    fs.writeFileSync(metaPath, JSON.stringify({ version: TOWN_STAMP_VERSION, at: Date.now() }));
  } catch {}

  return { 
      stamped: true, 
      forced: forced, 
      version: TOWN_STAMP_VERSION, 
      opsApplied: 1, 
      blocksTouched: 1, 
      metaPath 
  };
}