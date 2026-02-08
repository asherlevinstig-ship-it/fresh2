// ============================================================
// src/world/regions/applyBlueprint.ts
// ------------------------------------------------------------
// Town of Beginnings: flat safe-zone + prebuilt blueprint stamp
//
// Goals:
// - Deterministic stamp that runs once per world version.
// - Perfectly flat ground in town radius (optional).
// - Safe zone query helper: inTownSafeZone(x,y,z) for server checks.
// - NO TypeScript inference traps (no never[]), explicit unions.
// ============================================================

import * as fs from "fs";
import * as path from "path";
import { WorldStore, BLOCKS, type BlockId } from "../WorldStore.js";

// -----------------------------
// Types
// -----------------------------

export type Vec3i = { x: number; y: number; z: number };

export type TownRegion = {
  center: { x: number; z: number };
  radius: number;
  yMin: number;
  yMax: number;
};

// Fill (place blocks)
export type TownFillOp = {
  kind: "fill";
  id: BlockId;
  min: Vec3i;
  max: Vec3i;
  onlyIfAir?: boolean; // if true, do not overwrite existing non-air
  overwrite?: boolean; // if true, force overwrite (break -> place)
};

// Clear (set to air)
export type TownClearOp = {
  kind: "clear";
  min: Vec3i;
  max: Vec3i;
};

// Union
export type TownOp = TownFillOp | TownClearOp;

export type StampResult = {
  stamped: boolean;
  version: string;
  opsApplied: number;
  blocksTouched: number;
};

// -----------------------------
// Town config (edit these freely)
// -----------------------------

// The “safe zone” is an XZ circle; yMin/yMax define vertical enforcement.
// Keep it generous so players can’t build under/over the town.
export const TOWN_SAFE_ZONE: TownRegion = {
  center: { x: 0, z: 0 },
  radius: 42,
  yMin: -64,
  yMax: 128,
};

// This is the *flat* ground level the town sits on.
export const TOWN_GROUND_Y = 10;

// Stamp version: bump this string whenever you change the blueprint.
// (It will stamp again when version changes.)
export const TOWN_STAMP_VERSION = "town_v1_flat_002";


// Where we store whether it’s already stamped (in server cwd)
function stampMetaPath() {
  return path.join(process.cwd(), "town_stamp.json");
}

// -----------------------------
// Helpers
// -----------------------------

function clampInt(n: number, a: number, b: number) {
  n = n | 0;
  return Math.max(a, Math.min(b, n));
}

function inRange(n: number, a: number, b: number) {
  return n >= a && n <= b;
}

function distXZ(ax: number, az: number, bx: number, bz: number) {
  const dx = ax - bx;
  const dz = az - bz;
  return Math.sqrt(dx * dx + dz * dz);
}

export function inTownSafeZone(x: number, y: number, z: number) {
  const r = TOWN_SAFE_ZONE;
  if (!inRange(y, r.yMin, r.yMax)) return false;
  return distXZ(x, z, r.center.x, r.center.z) <= r.radius;
}

// Force set a block even if WorldStore.applyPlace only works on AIR.
// We do: if placing non-air and overwrite allowed, break existing then place.
// If placing air, break existing (if any).
function setBlockForce(
  world: WorldStore,
  x: number,
  y: number,
  z: number,
  id: BlockId,
  opts?: { onlyIfAir?: boolean; overwrite?: boolean }
) {
  const onlyIfAir = !!opts?.onlyIfAir;
  const overwrite = !!opts?.overwrite;

  const existing = world.getBlock(x, y, z);

  // If we're clearing to AIR
  if (id === BLOCKS.AIR) {
    if (existing !== BLOCKS.AIR) {
      world.applyBreak(x, y, z);
      return 1;
    }
    return 0;
  }

  // Placing solid block
  if (existing !== BLOCKS.AIR) {
    if (onlyIfAir) return 0; // skip
    if (overwrite) {
      world.applyBreak(x, y, z);
    } else {
      // if not overwriting, don't touch occupied
      return 0;
    }
  }

  // Now it should be AIR (or we allow applyPlace to decide)
  world.applyPlace(x, y, z, id);
  return 1;
}

function volume(min: Vec3i, max: Vec3i) {
  const dx = Math.max(0, (max.x - min.x + 1) | 0);
  const dy = Math.max(0, (max.y - min.y + 1) | 0);
  const dz = Math.max(0, (max.z - min.z + 1) | 0);
  return dx * dy * dz;
}

// -----------------------------
// Blueprint definition
// -----------------------------
//
// Keep it simple and explicit. No fancy inference.
// Everything uses the TownOp union.
//
// The order matters: clear → ground → structures.
//

export function townOfBeginningsBlueprint(): TownOp[] {
  const cx = TOWN_SAFE_ZONE.center.x | 0;
  const cz = TOWN_SAFE_ZONE.center.z | 0;
  const r = TOWN_SAFE_ZONE.radius | 0;

  const minX = cx - r;
  const maxX = cx + r;
  const minZ = cz - r;
  const maxZ = cz + r;

  // “Town box” we’ll clear + flatten.
  // We clear from ground up (to remove trees/terrain poking into town).
  const CLEAR_Y_MIN = TOWN_GROUND_Y;
  const CLEAR_Y_MAX = TOWN_GROUND_Y + 40;

  // Build a small “starter plaza” in the center.
  const plazaR = 8;
  const plazaMin = { x: cx - plazaR, y: TOWN_GROUND_Y, z: cz - plazaR };
  const plazaMax = { x: cx + plazaR, y: TOWN_GROUND_Y, z: cz + plazaR };

  // A tiny “spawn marker” pillar
  const pillarX = cx;
  const pillarZ = cz;

  // A basic “starter hut” rectangle
  const hutMin = { x: cx + 12, y: TOWN_GROUND_Y + 1, z: cz - 6 };
  const hutMax = { x: cx + 20, y: TOWN_GROUND_Y + 4, z: cz + 6 };

  const doorX = cx + 12;
  const doorZ = cz;

  // Explicitly type ops as TownOp[]
  const ops: TownOp[] = [];

  // 1) Clear volume above the flat ground
  ops.push({
    kind: "clear",
    min: { x: minX, y: CLEAR_Y_MIN, z: minZ },
    max: { x: maxX, y: CLEAR_Y_MAX, z: maxZ },
  });

  // 2) Lay perfectly-flat grass ground across the town box (one layer)
  ops.push({
    kind: "fill",
    id: BLOCKS.GRASS,
    min: { x: minX, y: TOWN_GROUND_Y, z: minZ },
    max: { x: maxX, y: TOWN_GROUND_Y, z: maxZ },
    overwrite: true,
  });

  // 3) Add a plaza of planks
  ops.push({
    kind: "fill",
    id: (BLOCKS as any).PLANKS ?? BLOCKS.LOG,
    min: plazaMin,
    max: plazaMax,
    overwrite: true,
  });

  // 4) Spawn marker (stone + torch placeholder)
  ops.push({
    kind: "fill",
    id: BLOCKS.STONE,
    min: { x: pillarX, y: TOWN_GROUND_Y + 1, z: pillarZ },
    max: { x: pillarX, y: TOWN_GROUND_Y + 3, z: pillarZ },
    overwrite: true,
  });

  // 5) Starter hut shell (wood)
  ops.push({
    kind: "fill",
    id: (BLOCKS as any).PLANKS ?? BLOCKS.LOG,
    min: hutMin,
    max: hutMax,
    overwrite: true,
  });

  // 6) Hollow the hut interior (air)
  ops.push({
    kind: "clear",
    min: { x: hutMin.x + 1, y: hutMin.y + 1, z: hutMin.z + 1 },
    max: { x: hutMax.x - 1, y: hutMax.y - 1, z: hutMax.z - 1 },
  });

  // 7) Cut a doorway
  ops.push({
    kind: "clear",
    min: { x: doorX, y: TOWN_GROUND_Y + 1, z: doorZ },
    max: { x: doorX, y: TOWN_GROUND_Y + 2, z: doorZ },
  });

  // 8) Place crafting table + chest inside (if IDs exist)
  const CRAFTING_TABLE = (BLOCKS as any).CRAFTING_TABLE as BlockId | undefined;
  const CHEST = (BLOCKS as any).CHEST as BlockId | undefined;

  if (CRAFTING_TABLE != null) {
    ops.push({
      kind: "fill",
      id: CRAFTING_TABLE,
      min: { x: hutMin.x + 2, y: TOWN_GROUND_Y + 1, z: hutMin.z + 2 },
      max: { x: hutMin.x + 2, y: TOWN_GROUND_Y + 1, z: hutMin.z + 2 },
      overwrite: true,
    });
  }

  if (CHEST != null) {
    ops.push({
      kind: "fill",
      id: CHEST,
      min: { x: hutMin.x + 3, y: TOWN_GROUND_Y + 1, z: hutMin.z + 2 },
      max: { x: hutMin.x + 3, y: TOWN_GROUND_Y + 1, z: hutMin.z + 2 },
      overwrite: true,
    });
  }

  return ops;
}

// -----------------------------
// Apply ops
// -----------------------------

export function applyTownOps(world: WorldStore, ops: TownOp[], opts?: { verbose?: boolean }) {
  let blocksTouched = 0;
  let opsApplied = 0;

  for (const op of ops) {
    opsApplied++;

    const min = op.min;
    const max = op.max;

    const minX = Math.min(min.x, max.x) | 0;
    const maxX = Math.max(min.x, max.x) | 0;
    const minY = Math.min(min.y, max.y) | 0;
    const maxY = Math.max(min.y, max.y) | 0;
    const minZ = Math.min(min.z, max.z) | 0;
    const maxZ = Math.max(min.z, max.z) | 0;

    if (opts?.verbose) {
      const v = volume({ x: minX, y: minY, z: minZ }, { x: maxX, y: maxY, z: maxZ });
      console.log(`[TOWN] op ${opsApplied}/${ops.length} ${op.kind} vol=${v}`);
    }

    if (op.kind === "clear") {
      for (let x = minX; x <= maxX; x++) {
        for (let y = minY; y <= maxY; y++) {
          for (let z = minZ; z <= maxZ; z++) {
            blocksTouched += setBlockForce(world, x, y, z, BLOCKS.AIR);
          }
        }
      }
      continue;
    }

    // fill
    const onlyIfAir = !!op.onlyIfAir;
    const overwrite = !!op.overwrite;

    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        for (let z = minZ; z <= maxZ; z++) {
          blocksTouched += setBlockForce(world, x, y, z, op.id, { onlyIfAir, overwrite });
        }
      }
    }
  }

  return { opsApplied, blocksTouched };
}

// -----------------------------
// Stamp logic (run once per version)
// -----------------------------

function readStampMeta(): { version: string } | null {
  const p = stampMetaPath();
  if (!fs.existsSync(p)) return null;
  try {
    const raw = fs.readFileSync(p, "utf8");
    const j = JSON.parse(raw);
    if (j && typeof j.version === "string") return { version: j.version };
    return null;
  } catch {
    return null;
  }
}

function writeStampMeta(version: string) {
  const p = stampMetaPath();
  try {
    fs.writeFileSync(p, JSON.stringify({ version, at: Date.now() }, null, 2));
  } catch (e) {
    console.error("[TOWN] Failed to write stamp meta:", e);
  }
}

/**
 * Stamps Town of Beginnings if not already stamped for current version.
 * Safe to call inside Room.onCreate after world load.
 */
export function stampTownOfBeginnings(world: WorldStore, opts?: { verbose?: boolean }): StampResult {
  const meta = readStampMeta();
  if (meta?.version === TOWN_STAMP_VERSION) {
    return { stamped: false, version: TOWN_STAMP_VERSION, opsApplied: 0, blocksTouched: 0 };
  }

  const ops = townOfBeginningsBlueprint();
  const applied = applyTownOps(world, ops, { verbose: opts?.verbose });

  // mark dirty autosave will persist
  writeStampMeta(TOWN_STAMP_VERSION);

  return {
    stamped: true,
    version: TOWN_STAMP_VERSION,
    opsApplied: applied.opsApplied,
    blocksTouched: applied.blocksTouched,
  };
}
