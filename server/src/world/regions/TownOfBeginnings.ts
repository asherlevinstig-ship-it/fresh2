// ============================================================
// server/world/regions/TownOfBeginnings.ts  (FULL - NO OMITS)
// ------------------------------------------------------------
// Purpose:
// - Defines the "Town of Beginnings" safe zone + perfectly-flat foundation
// - Provides deterministic build plan (flatten + clear + structures)
// - Designed to be applied by a stamping utility against WorldStore edits
//
// What this file provides:
// - TOWN constants (center/baseY/radii)
// - inTownSafeZone(x,y,z)
// - buildTownPlan(): returns { version, center, safeRadius, ops }
//   where ops include:
//     - fill operations (set solid blocks over a volume)
//     - clear operations (set AIR over a volume)
//     - place operations (set single blocks / structure blocks)
//
// Notes:
// - Uses BLOCKS + BlockId from WorldStore.ts (import path may differ)
// - PLANKS / crafted blocks are accessed defensively via (BLOCKS as any)
//
// FIXES INCLUDED (no behavior removed):
// - Adds Y-band to inTownSafeZone (matches other implementation style)
// - Keeps all existing ops and structure generation logic intact
// ============================================================

import { BLOCKS, type BlockId } from "../WorldStore.js";

// ------------------------------------------------------------
// Types
// ------------------------------------------------------------

export type Vec3i = { x: number; y: number; z: number };

export type TownPlaceOp = {
  kind: "place";
  x: number;
  y: number;
  z: number;
  id: BlockId;
  onlyIfAir?: boolean; // default true in most stampers
};

export type TownFillOp = {
  kind: "fill";
  shape: "cylinder" | "box";
  id: BlockId;

  // cylinder (XZ circle) + Y range
  center?: Vec3i;
  radius?: number;

  // box
  min?: Vec3i;
  max?: Vec3i;

  // both
  yMin: number;
  yMax: number;

  // stamping behavior hint
  onlyIfAir?: boolean; // for fills (usually false for flatten)
  overwrite?: boolean; // explicit: if true, set regardless
};

export type TownClearOp = {
  kind: "clear";
  shape: "cylinder" | "box";
  id: BlockId; // should be AIR
  center?: Vec3i;
  radius?: number;
  min?: Vec3i;
  max?: Vec3i;
  yMin: number;
  yMax: number;
  overwrite?: boolean; // usually true for clear
};

export type TownOp = TownPlaceOp | TownFillOp | TownClearOp;

export type TownPlan = {
  version: number;
  name: string;
  center: Vec3i;
  safeRadius: number;
  baseY: number; // “ground” level for town (flat surface at baseY)
  ops: TownOp[];
};

// ------------------------------------------------------------
// Configuration
// ------------------------------------------------------------

export const TOWN = {
  name: "Town of Beginnings",
  version: 1,

  // Center of town (also your spawn-ish)
  center: { x: 0, y: 10, z: 0 } as Vec3i,

  // Safe zone radius (no break/place)
  safeRadius: 48,

  // Safe zone vertical band (optional; keeps protection sane underground/sky)
  // If you don't want Y limits, set yMin=-Infinity / yMax=Infinity in your stamper.
  safeYMin: -64,
  safeYMax: 256,

  // Perfectly-flat "build area" radius (foundation + clear)
  // Usually a bit larger than safeRadius so the boundary feels clean
  flatRadius: 56,

  // How deep to fill foundation under baseY (dirt/stone)
  foundationDepth: 6,

  // How high to clear above baseY (removes trees/cacti/terrain clutter)
  clearHeight: 20,

  // Extra clear below baseY (optional) - typically 0
  clearBelow: 0,
} as const;

// ------------------------------------------------------------
// Safe zone test
// ------------------------------------------------------------

export function inTownSafeZone(x: number, y: number, z: number) {
  // FIX: Y-band to match the other safe-zone implementation pattern
  if (y < TOWN.safeYMin || y > TOWN.safeYMax) return false;

  const dx = x - TOWN.center.x;
  const dz = z - TOWN.center.z;
  return dx * dx + dz * dz <= TOWN.safeRadius * TOWN.safeRadius;
}

// ------------------------------------------------------------
// Internal helpers
// ------------------------------------------------------------

function idAir(): BlockId {
  return BLOCKS.AIR;
}

function idDirt(): BlockId {
  return BLOCKS.DIRT;
}

function idGrass(): BlockId {
  return BLOCKS.GRASS;
}

function idStone(): BlockId {
  return BLOCKS.STONE;
}

function idLog(): BlockId {
  return BLOCKS.LOG;
}

function idLeaves(): BlockId {
  return BLOCKS.LEAVES;
}

function idPlanks(): BlockId {
  // Defensive: some projects name it PLANKS, some PLANK, some PLANKS_WOOD, etc.
  return ((BLOCKS as any).PLANKS ??
    (BLOCKS as any).PLANK ??
    (BLOCKS as any).PLANK_WOOD ??
    (BLOCKS as any).WOOD_PLANKS ??
    BLOCKS.LOG) as BlockId;
}

function idCraftingTable(): BlockId {
  return ((BLOCKS as any).CRAFTING_TABLE ?? idPlanks()) as BlockId;
}

function idChest(): BlockId {
  return ((BLOCKS as any).CHEST ?? idPlanks()) as BlockId;
}

function pushPlace(ops: TownOp[], x: number, y: number, z: number, id: BlockId, onlyIfAir = true) {
  ops.push({ kind: "place", x, y, z, id, onlyIfAir });
}

function pushFillCylinder(
  ops: TownOp[],
  center: Vec3i,
  radius: number,
  yMin: number,
  yMax: number,
  id: BlockId,
  overwrite = true
) {
  ops.push({
    kind: "fill",
    shape: "cylinder",
    center,
    radius,
    yMin,
    yMax,
    id,
    overwrite,
  });
}

function pushClearCylinder(ops: TownOp[], center: Vec3i, radius: number, yMin: number, yMax: number) {
  ops.push({
    kind: "clear",
    shape: "cylinder",
    center,
    radius,
    yMin,
    yMax,
    id: idAir(),
    overwrite: true,
  });
}

function pushFillBox(ops: TownOp[], min: Vec3i, max: Vec3i, id: BlockId, overwrite = true) {
  ops.push({
    kind: "fill",
    shape: "box",
    min,
    max,
    yMin: min.y,
    yMax: max.y,
    id,
    overwrite,
  });
}

function pushClearBox(ops: TownOp[], min: Vec3i, max: Vec3i) {
  ops.push({
    kind: "clear",
    shape: "box",
    min,
    max,
    yMin: min.y,
    yMax: max.y,
    id: idAir(),
    overwrite: true,
  });
}

// ------------------------------------------------------------
// Town structure generation (relative to center/baseY)
// ------------------------------------------------------------

function buildStructures(ops: TownOp[], center: Vec3i, baseY: number) {
  const LOG = idLog();
  const LEAVES = idLeaves();
  const PLANKS = idPlanks();
  const GRASS = idGrass();

  // --- Spawn pad (perfectly flat already, but we add a nice border)
  // Pad at y=baseY with a 9x9 grass patch and a log border at y=baseY+1
  const padR = 4;
  for (let x = -padR; x <= padR; x++) {
    for (let z = -padR; z <= padR; z++) {
      pushPlace(ops, center.x + x, baseY, center.z + z, GRASS, false);
    }
  }

  for (let x = -padR; x <= padR; x++) {
    pushPlace(ops, center.x + x, baseY + 1, center.z - padR, LOG, true);
    pushPlace(ops, center.x + x, baseY + 1, center.z + padR, LOG, true);
  }
  for (let z = -padR; z <= padR; z++) {
    pushPlace(ops, center.x - padR, baseY + 1, center.z + z, LOG, true);
    pushPlace(ops, center.x + padR, baseY + 1, center.z + z, LOG, true);
  }

  // --- Path out (planks) heading +Z
  for (let i = 5; i <= 26; i++) {
    pushPlace(ops, center.x + 0, baseY + 1, center.z + i, PLANKS, true);
    if (i % 2 === 0) {
      pushPlace(ops, center.x + 1, baseY + 1, center.z + i, PLANKS, true);
      pushPlace(ops, center.x - 1, baseY + 1, center.z + i, PLANKS, true);
    }
  }

  // --- Pavilion / hall (open sides)
  // Floor: 7x9 planks at y=baseY+1
  const hall = { x0: -3, x1: 3, z0: 8, z1: 16 };
  for (let x = hall.x0; x <= hall.x1; x++) {
    for (let z = hall.z0; z <= hall.z1; z++) {
      pushPlace(ops, center.x + x, baseY + 1, center.z + z, PLANKS, true);
    }
  }

  // Corner pillars (logs) height 4 (y=baseY+2..baseY+5)
  const corners = [
    { x: hall.x0, z: hall.z0 },
    { x: hall.x1, z: hall.z0 },
    { x: hall.x0, z: hall.z1 },
    { x: hall.x1, z: hall.z1 },
  ];
  for (const c of corners) {
    for (let y = baseY + 2; y <= baseY + 5; y++) {
      pushPlace(ops, center.x + c.x, y, center.z + c.z, LOG, true);
    }
  }

  // Roof (planks) at y=baseY+6
  for (let x = hall.x0; x <= hall.x1; x++) {
    for (let z = hall.z0; z <= hall.z1; z++) {
      pushPlace(ops, center.x + x, baseY + 6, center.z + z, PLANKS, true);
    }
  }

  // Decorative beams under roof
  for (let x = hall.x0; x <= hall.x1; x++) {
    pushPlace(ops, center.x + x, baseY + 5, center.z + hall.z0, LOG, true);
    pushPlace(ops, center.x + x, baseY + 5, center.z + hall.z1, LOG, true);
  }

  // Center “welcome” block area (crafting table + chest)
  pushPlace(ops, center.x + 0, baseY + 2, center.z + 12, idCraftingTable(), true);
  pushPlace(ops, center.x + 1, baseY + 2, center.z + 12, idChest(), true);

  // --- Two “lantern posts” (logs + leaves canopy)
  const posts = [{ x: -6, z: 12 }, { x: 6, z: 12 }];
  for (const p of posts) {
    for (let y = baseY + 1; y <= baseY + 4; y++) pushPlace(ops, center.x + p.x, y, center.z + p.z, LOG, true);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        pushPlace(ops, center.x + p.x + dx, baseY + 5, center.z + p.z + dz, LEAVES, true);
      }
    }
  }
}

// ------------------------------------------------------------
// Public: Build the full town plan (flatten + clear + structures)
// ------------------------------------------------------------

export function buildTownOfBeginningsPlan(): TownPlan {
  const center = { ...TOWN.center };
  const baseY = TOWN.center.y;

  const ops: TownOp[] = [];

  // -----------------------------
  // 1) PERFECT FLATTEN FOUNDATION
  // -----------------------------
  // We do:
  // - Cylinder fill for foundation under baseY (stone deeper, dirt nearer)
  // - Cylinder fill for top layer at baseY (grass)
  //
  // This ensures town is perfectly flat regardless of biome height.

  const r = TOWN.flatRadius;
  const depth = Math.max(1, TOWN.foundationDepth);

  // Deep foundation (stone) from baseY - depth .. baseY - 3
  // (if depth is small, this range may collapse; that's fine)
  {
    const yMin = baseY - depth;
    const yMax = baseY - 3;
    if (yMin <= yMax) pushFillCylinder(ops, center, r, yMin, yMax, idStone(), true);
  }

  // Upper foundation (dirt) from baseY - 2 .. baseY - 1
  pushFillCylinder(ops, center, r, baseY - 2, baseY - 1, idDirt(), true);

  // Surface (grass) at baseY
  pushFillCylinder(ops, center, r, baseY, baseY, idGrass(), true);

  // -----------------------------
  // 2) CLEAR VOLUME ABOVE (AIR)
  // -----------------------------
  // Clear vegetation/terrain clutter so the town doesn’t intersect trees/cacti.
  // Clear from baseY+1 to baseY+clearHeight.
  const clearTop = baseY + Math.max(4, TOWN.clearHeight);
  const clearBottom = baseY + 1 - Math.max(0, TOWN.clearBelow);

  pushClearCylinder(ops, center, r, clearBottom, clearTop);

  // Optional: clear a rectangular “vista” down the path direction (+Z),
  // so players see the exit route clearly.
  // (This is just a nice touch; it’s safe even if you remove it.)
  pushClearBox(
    ops,
    { x: center.x - 6, y: baseY + 1, z: center.z + 5 },
    { x: center.x + 6, y: baseY + 10, z: center.z + 40 }
  );

  // -----------------------------
  // 3) STAMP STRUCTURES
  // -----------------------------
  buildStructures(ops, center, baseY);

  return {
    version: TOWN.version,
    name: TOWN.name,
    center,
    safeRadius: TOWN.safeRadius,
    baseY,
    ops,
  };
}
