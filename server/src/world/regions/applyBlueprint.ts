// ============================================================
// src/world/regions/applyBlueprint.ts
// ------------------------------------------------------------
// Town of Beginnings v3.8 (FULL REWRITE)
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
// FIXES vs v3.7:
// - FIX: Rotation math uses normalized dimensions (ragged array safety).
// - FIX: Diagonal walls are truly watertight (fills both gap tiles).
// - FIX: Accurate block modification counts.
// - FIX: Re-stamp safety (avoids clearing builds in the slope region).
// - FIX: Versioning includes config parameters to detect changes.
//
// ============================================================

import * as fs from "fs";
import * as path from "path";
import { WorldStore, BLOCKS } from "../WorldStore.js";

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

// How far (beyond the safe zone) we slope/feather terrain down
const TOWN_SLOPE_WIDTH = 24;

export const TOWN_STAMP_VERSION = "town_v3.8_ragged_fix_watertight";

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
  R: BLOCKS.STONE, // road base (randomized in pasteStructure)
  C: (BLOCKS as any).COAL_ORE ?? BLOCKS.STONE,
  F: BLOCKS.LOG, // framing
  X: BLOCKS.DIRT,
  T: BLOCKS.LOG,
  I: (BLOCKS as any).ICE ?? BLOCKS.STONE,
  O: (BLOCKS as any).GOLD_ORE ?? BLOCKS.STONE,
} as const;

// -----------------------------
// Prefab System
// -----------------------------

type SchematicLayer = string[];
type Schematic = SchematicLayer[];

/**
 * Rotation is intentionally a union type to prevent TS literal narrowing bugs.
 * Renamed to SchematicRotation to ensure no naming collisions.
 */
type SchematicRotation = 0 | 1 | 2 | 3;

// Rotation constants to avoid TS literal narrowing issues
const ROT_0: SchematicRotation = 0;
const ROT_1: SchematicRotation = 1;
const ROT_2: SchematicRotation = 2;
const ROT_3: SchematicRotation = 3;

/**
 * Pastes a 3D ASCII schematic into the world.
 * * FIX: Computes max dimensions first to ensure rotation logic is stable
 * regardless of ragged input strings.
 *
 * Legend:
 * - '.' means "skip/no-op" (do not change anything)
 * - Other chars map to P, default AIR if unknown
 */
function pasteStructure(
  world: WorldStore,
  ox: number,
  oy: number,
  oz: number,
  schematic: Schematic,
  rotation: SchematicRotation = ROT_0
): number {
  let blocksTouched = 0;

  // 1. Normalize Dimensions
  const height = schematic.length;
  let maxDepth = 0;
  let maxWidth = 0;

  for (const layer of schematic) {
      if (layer.length > maxDepth) maxDepth = layer.length;
      for (const row of layer) {
          if (row.length > maxWidth) maxWidth = row.length;
      }
  }

  // 2. Iterate normalized grid
  for (let y = 0; y < height; y++) {
      const layer = schematic[y];
      const worldY = oy + y;

      for (let z = 0; z < maxDepth; z++) {
          const rowStr = z < layer.length ? layer[z] : "";
          
          for (let x = 0; x < maxWidth; x++) {
              const char = x < rowStr.length ? rowStr[x] : "."; // Pad with skip

              if (char === ".") continue;

              // Local coords before rotation
              let lx = x;
              let lz = z;

              // 3. Rotation Logic (Using stable MaxWidth/MaxDepth)
              // 0 = 0 deg, 1 = 90 deg, 2 = 180 deg, 3 = 270 deg
              if (rotation === ROT_1) {
                  // 90 deg: x -> z, z -> inverted x (based on Depth)
                  const t = lx;
                  lx = maxDepth - 1 - lz;
                  lz = t;
              } else if (rotation === ROT_2) {
                  // 180 deg: x -> inverted x, z -> inverted z
                  lx = maxWidth - 1 - lx;
                  lz = maxDepth - 1 - lz;
              } else if (rotation === ROT_3) {
                  // 270 deg: x -> inverted z, z -> x
                  const t = lx;
                  lx = lz;
                  lz = maxWidth - 1 - t;
              }

              const wx = ox + lx;
              const wz = oz + lz;

              // Default mapping
              let blockId = (P as any)[char] ?? BLOCKS.AIR;

              // Road randomization for texture variation
              if (char === "R") {
                  blockId = Math.random() > 0.7
                      ? ((BLOCKS as any).GRAVEL ?? BLOCKS.STONE)
                      : BLOCKS.STONE;
              }

              // Apply only if changed (reduce ops)
              if (world.getBlock(wx, worldY, wz) !== blockId) {
                  if (blockId === BLOCKS.AIR) world.applyBreak(wx, worldY, wz);
                  else world.applyPlace(wx, worldY, wz, blockId);
                  blocksTouched++;
              }
          }
      }
  }

  return blocksTouched;
}

// -----------------------------
// Assets (ASCII Schematics)
// -----------------------------

const HOUSE_SMALL: Schematic = [
  ["LLLLLLL", "LWWWWWL", "LWWWWWL", "LWWWWWL", "LWWWWWL", "LWWWWWL", "LLLLLLL"],
  ["LWWWWWL", "W_____W", "W_____W", "W_____W", "W_____W", "W_____W", "LW_W_WL"],
  ["LWWWWWL", "W_____W", "W_____W", "W_____W", "W_____W", "W_____W", "LWWWWWL"],
  ["LLLLLLL", "LLLLLLL", "LLLLLLL", "LLLLLLL", "LLLLLLL", "LLLLLLL", "LLLLLLL"],
  [".......", ".WWWWW.", ".WWWWW.", ".WWWWW.", ".WWWWW.", ".WWWWW.", "......."],
  [".......", ".......", "..WWW..", "..WWW..", "..WWW..", ".......", "......."],
  [".......", ".......", "...S...", "...O...", ".......", ".......", "......."],
];

const MARKET_STALL: Schematic = [
  ["LL...LL", ".......", ".......", "LL...LL"],
  ["L.....L", ".......", "WWW.WWW", "L.....L"],
  ["L.....L", ".......", ".......", "L.....L"],
  ["VVVVVVV", "VVVVVVV", "VVVVVVV", "VVVVVVV"],
];

const FOUNTAIN: Schematic = [
  [".SSSSS.", "SSSSSSS", "SSSSSSS", "SSSSSSS", "SSSSSSS", "SSSSSSS", ".SSSSS."],
  [".SSSSS.", "SIIIIIS", "SIIIIIS", "SIIOSIS", "SIIIIIS", "SIIIIIS", ".SSSSS."],
  [".......", ".......", ".......", "...S...", ".......", ".......", "......."],
  [".......", ".......", "...O...", "...S...", "...O...", ".......", "......."],
];

// -----------------------------
// Procedural Logic
// -----------------------------

function spawnTree(world: WorldStore, x: number, y: number, z: number): number {
  let touched = 0;
  const height = 4 + Math.floor(Math.random() * 3);

  // trunk
  for (let i = 0; i < height; i++) {
      if (world.getBlock(x, y + i, z) !== BLOCKS.LOG) {
          world.applyPlace(x, y + i, z, BLOCKS.LOG);
          touched++;
      }
  }

  // crown
  const crownY = y + height - 1;
  for (let ly = crownY - 2; ly <= crownY + 1; ly++) {
    const radius = ly === crownY + 1 ? 1 : 2;
    for (let lx = x - radius; lx <= x + radius; lx++) {
      for (let lz = z - radius; lz <= z + radius; lz++) {
        // soften the box corners randomly
        if (
          Math.abs(lx - x) === radius &&
          Math.abs(lz - z) === radius &&
          Math.random() > 0.2
        )
          continue;

        const existing = world.getBlock(lx, ly, lz);
        if (existing === BLOCKS.AIR) {
            world.applyPlace(lx, ly, lz, BLOCKS.LEAVES);
            touched++;
        }
      }
    }
  }
  return touched;
}

function drawColumn(
  world: WorldStore,
  x: number,
  z: number,
  yBase: number,
  crenellation: boolean
): number {
  let touched = 0;
  // underground "skirt" / footing
  for (let y = -2; y < yBase; y++) {
      if (world.getBlock(x, y, z) !== BLOCKS.STONE) {
        world.applyPlace(x, y, z, BLOCKS.STONE);
        touched++;
      }
  }

  // vertical wall
  for (let y = yBase; y < yBase + 5; y++) {
      if (world.getBlock(x, y, z) !== BLOCKS.STONE) {
        world.applyPlace(x, y, z, BLOCKS.STONE);
        touched++;
      }
  }

  // top detail
  if (crenellation) {
      if (world.getBlock(x, yBase + 5, z) !== BLOCKS.STONE) {
        world.applyPlace(x, yBase + 5, z, BLOCKS.STONE);
        touched++;
      }
  }
  return touched;
}

function drawWall(
  world: WorldStore,
  x1: number,
  z1: number,
  x2: number,
  z2: number,
  yBase: number
): number {
  let touched = 0;
  const dx = Math.sign(x2 - x1);
  const dz = Math.sign(z2 - z1);

  let cx = x1;
  let cz = z1;

  const len = Math.max(Math.abs(x2 - x1), Math.abs(z2 - z1));
  const isDiagonal = dx !== 0 && dz !== 0;

  for (let i = 0; i <= len; i++) {
    touched += drawColumn(world, cx, cz, yBase, i % 2 === 0);

    // FIX: Watertight diagonal fill
    // We must fill both adjacent blocks to prevent corner gaps in voxel rendering
    if (isDiagonal && i < len) {
      touched += drawColumn(world, cx + dx, cz, yBase, (i + 1) % 2 === 0);
      touched += drawColumn(world, cx, cz + dz, yBase, (i + 1) % 2 === 0); // Fills the second gap
    }

    cx += dx;
    cz += dz;
  }
  return touched;
}

// -----------------------------
// Main Logic
// -----------------------------

export function stampTownOfBeginnings(
  world: WorldStore,
  opts?: { verbose?: boolean; force?: boolean }
) {
  const metaPath = path.join(process.cwd(), "town_stamp.json");

  let meta: any = null;
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  } catch {
    // ignore missing/invalid meta
  }

  const forced = !!opts?.force;
  
  // FIX: Detect parameter changes
  const cx = TOWN_SAFE_ZONE.center.x;
  const cz = TOWN_SAFE_ZONE.center.z;
  const gy = TOWN_GROUND_Y;
  const r = TOWN_SAFE_ZONE.radius;
  
  const matchesVersion = meta?.version === TOWN_STAMP_VERSION;
  const matchesParams = meta?.radius === r && meta?.groundY === gy && meta?.slopeWidth === TOWN_SLOPE_WIDTH;

  if (!forced && matchesVersion && matchesParams) {
    if (opts?.verbose) console.log(`[TOWN] Already stamped v${TOWN_STAMP_VERSION}`);
    return {
      stamped: false,
      forced: false,
      version: TOWN_STAMP_VERSION,
      opsApplied: 0,
      blocksTouched: 0,
      metaPath,
    };
  }

  if (opts?.verbose) console.log(`[TOWN] Stamping v${TOWN_STAMP_VERSION}...`);

  let totalTouched = 0;

  // ----------------------------------------------------------
  // 1) TERRAFORMING SKIRT
  // ----------------------------------------------------------
  const totalR = r + TOWN_SLOPE_WIDTH;

  for (let x = -totalR; x <= totalR; x++) {
    for (let z = -totalR; z <= totalR; z++) {
      const dist = Math.sqrt(x * x + z * z);
      if (dist > totalR) continue;

      const wx = cx + x;
      const wz = cz + z;

      let surfaceY = gy;

      // outside inner safe zone: slope down
      if (dist > r) {
        const distanceFromEdge = dist - r;
        const drop = Math.floor(distanceFromEdge * 0.7);
        surfaceY = gy - drop;
      }

      // don't terraform too deep (keeps it reasonable)
      if (surfaceY < -5) continue;

      // fill up to surface
      for (let y = -10; y <= surfaceY; y++) {
        let block: number = BLOCKS.DIRT;
        if (y === surfaceY) block = BLOCKS.GRASS;
        else if (y < surfaceY - 3) block = BLOCKS.STONE;
        
        if (world.getBlock(wx, y, wz) !== block) {
            world.applyPlace(wx, y, wz, block);
            totalTouched++;
        }
      }

      // FIX: Re-stamp safety. 
      // Only clear high air INSIDE the safe zone.
      // Outside (slope region), avoid clearing to preserve player builds on the outskirts.
      const clearHeight = dist <= r ? 20 : 0; 
      
      if (clearHeight > 0) {
          for (let y = surfaceY + 1; y <= surfaceY + clearHeight; y++) {
            if (world.getBlock(wx, y, wz) !== BLOCKS.AIR) {
                world.applyBreak(wx, y, wz);
                totalTouched++;
            }
          }
      }
    }
  }

  // ----------------------------------------------------------
  // 2) ROADS (ring + cross)
  // ----------------------------------------------------------
  for (let x = -r + 2; x <= r - 2; x++) {
    for (let z = -r + 2; z <= r - 2; z++) {
      const dist = Math.sqrt(x * x + z * z);

      const isRing = dist > 20 && dist < 25;
      const isCross = Math.abs(x) < 4 || Math.abs(z) < 4;

      if (isRing || isCross) {
        const mat =
          Math.random() > 0.2
            ? ((BLOCKS as any).GRAVEL ?? BLOCKS.STONE)
            : BLOCKS.STONE;
        
        if (world.getBlock(cx + x, gy, cz + z) !== mat) {
            world.applyPlace(cx + x, gy, cz + z, mat);
            totalTouched++;
        }
      }
    }
  }

  // ----------------------------------------------------------
  // 3) CENTERPIECE
  // ----------------------------------------------------------
  totalTouched += pasteStructure(world, cx - 3, gy + 1, cz - 3, FOUNTAIN, ROT_0);

  // ----------------------------------------------------------
  // 4) BUILDINGS
  // ----------------------------------------------------------
  // Fixed literal narrowing using constants
  totalTouched += pasteStructure(world, cx - 15, gy + 1, cz + 28, HOUSE_SMALL, ROT_2);
  totalTouched += pasteStructure(world, cx + 28, gy + 1, cz - 15, HOUSE_SMALL, ROT_3);
  totalTouched += pasteStructure(world, cx - 28, gy + 1, cz + 10, HOUSE_SMALL, ROT_1);

  totalTouched += pasteStructure(world, cx + 15, gy + 1, cz + 15, MARKET_STALL, ROT_0);
  totalTouched += pasteStructure(world, cx + 24, gy + 1, cz + 15, MARKET_STALL, ROT_1);

  // ----------------------------------------------------------
  // 5) WALLS (square + diagonals)
  // ----------------------------------------------------------
  const wallR = r - 2;

  // cardinal edges
  totalTouched += drawWall(world, cx - 10, cz + wallR, cx + 10, cz + wallR, gy + 1);
  totalTouched += drawWall(world, cx - 10, cz - wallR, cx + 10, cz - wallR, gy + 1);
  totalTouched += drawWall(world, cx + wallR, cz - 10, cx + wallR, cz + 10, gy + 1);
  totalTouched += drawWall(world, cx - wallR, cz - 10, cx - wallR, cz + 10, gy + 1);

  // diagonals to corners
  totalTouched += drawWall(world, cx + 10, cz + wallR, cx + wallR, cz + 10, gy + 1);
  totalTouched += drawWall(world, cx - 10, cz + wallR, cx - wallR, cz + 10, gy + 1);
  totalTouched += drawWall(world, cx + 10, cz - wallR, cx + wallR, cz - 10, gy + 1);
  totalTouched += drawWall(world, cx - 10, cz - wallR, cx - wallR, cz - 10, gy + 1);

  // ----------------------------------------------------------
  // 6) VEGETATION
  // ----------------------------------------------------------
  for (let i = 0; i < 40; i++) {
    const rx = Math.floor((Math.random() - 0.5) * r * 1.5);
    const rz = Math.floor((Math.random() - 0.5) * r * 1.5);

    if (inTownSafeZone(cx + rx, gy, cz + rz)) {
      const floor = world.getBlock(cx + rx, gy, cz + rz);
      const above = world.getBlock(cx + rx, gy + 1, cz + rz);
      if (floor === BLOCKS.GRASS && above === BLOCKS.AIR) {
        totalTouched += spawnTree(world, cx + rx, gy + 1, cz + rz);
      }
    }
  }

  // ----------------------------------------------------------
  // META WRITE
  // ----------------------------------------------------------
  try {
    fs.writeFileSync(
      metaPath,
      JSON.stringify({ 
          version: TOWN_STAMP_VERSION, 
          radius: r,
          groundY: gy,
          slopeWidth: TOWN_SLOPE_WIDTH,
          at: Date.now() 
      })
    );
  } catch {
    // ignore write errors
  }

  return {
    stamped: true,
    forced,
    version: TOWN_STAMP_VERSION,
    opsApplied: totalTouched,
    blocksTouched: totalTouched,
    metaPath,
  };
}