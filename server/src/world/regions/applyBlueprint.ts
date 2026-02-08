// ============================================================
// src/world/regions/applyBlueprint.ts
// ------------------------------------------------------------
// Town of Beginnings: flat safe-zone + prebuilt blueprint stamp
//
// FEATURES:
// - Perfectly flat ground in town radius (box stamp for simplicity)
// - Giant cross marker so you can SEE it immediately
// - Safe zone helper: inTownSafeZone(x,y,z)
// - Stamp meta on disk, versioned
// - FORCE option to restamp even if meta says "already done"
// - Verbose logs including meta path + counts
//
// IMPORTANT:
// - This file avoids TS "never" inference by explicit union types.
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
  overwrite?: boolean; // if true, force overwrite (break then place)
};

// Clear (set to air)
export type TownClearOp = {
  kind: "clear";
  min: Vec3i;
  max: Vec3i;
};

export type TownOp = TownFillOp | TownClearOp;

export type StampResult = {
  stamped: boolean;
  forced: boolean;
  version: string;
  opsApplied: number;
  blocksTouched: number;
  metaPath: string;
};

// -----------------------------
// Town config
// -----------------------------

export const TOWN_SAFE_ZONE: TownRegion = {
  center: { x: 0, z: 0 },
  radius: 42,
  yMin: -64,
  yMax: 256,
};

// Perfectly flat ground level for town
export const TOWN_GROUND_Y = 10;

// Bump this whenever you change the blueprint (or just to restamp)
export const TOWN_STAMP_VERSION = "town_v1_flat_002_marker";

// Where we store stamp metadata
function stampMetaPath() {
  return path.join(process.cwd(), "town_stamp.json");
}

// -----------------------------
// Helpers
// -----------------------------

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

// Some WorldStore implementations only place if AIR.
// We "force" by breaking first when overwrite is true.
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

  // clearing
  if (id === BLOCKS.AIR) {
    if (existing !== BLOCKS.AIR) {
      world.applyBreak(x, y, z);
      return 1;
    }
    return 0;
  }

  // filling
  if (existing !== BLOCKS.AIR) {
    if (onlyIfAir) return 0;
    if (!overwrite) return 0;
    world.applyBreak(x, y, z);
  }

  world.applyPlace(x, y, z, id);
  return 1;
}

function normalizeBox(min: Vec3i, max: Vec3i) {
  return {
    minX: Math.min(min.x, max.x) | 0,
    maxX: Math.max(min.x, max.x) | 0,
    minY: Math.min(min.y, max.y) | 0,
    maxY: Math.max(min.y, max.y) | 0,
    minZ: Math.min(min.z, max.z) | 0,
    maxZ: Math.max(min.z, max.z) | 0,
  };
}

function volume(min: Vec3i, max: Vec3i) {
  const b = normalizeBox(min, max);
  const dx = Math.max(0, (b.maxX - b.minX + 1) | 0);
  const dy = Math.max(0, (b.maxY - b.minY + 1) | 0);
  const dz = Math.max(0, (b.maxZ - b.minZ + 1) | 0);
  return dx * dy * dz;
}

// -----------------------------
// Blueprint
// -----------------------------

export function townOfBeginningsBlueprint(): TownOp[] {
  const cx = TOWN_SAFE_ZONE.center.x | 0;
  const cz = TOWN_SAFE_ZONE.center.z | 0;
  const r = TOWN_SAFE_ZONE.radius | 0;

  const minX = cx - r;
  const maxX = cx + r;
  const minZ = cz - r;
  const maxZ = cz + r;

  // Clear high enough so you don't have trees/terrain poking through
  const CLEAR_Y_MIN = TOWN_GROUND_Y;
  const CLEAR_Y_MAX = TOWN_GROUND_Y + 80;

  const PLANKS: BlockId = (BLOCKS as any).PLANKS ?? BLOCKS.LOG;
  const CRAFTING_TABLE: BlockId | null = (BLOCKS as any).CRAFTING_TABLE ?? null;
  const CHEST: BlockId | null = (BLOCKS as any).CHEST ?? null;

  const ops: TownOp[] = [];

  // 1) Clear everything above the town ground (box clear)
  ops.push({
    kind: "clear",
    min: { x: minX, y: CLEAR_Y_MIN, z: minZ },
    max: { x: maxX, y: CLEAR_Y_MAX, z: maxZ },
  });

  // 2) Flat grass floor (one layer)
  ops.push({
    kind: "fill",
    id: BLOCKS.GRASS,
    min: { x: minX, y: TOWN_GROUND_Y, z: minZ },
    max: { x: maxX, y: TOWN_GROUND_Y, z: maxZ },
    overwrite: true,
  });

  // 3) Giant stone cross marker at center (VERY visible)
  ops.push({
    kind: "fill",
    id: BLOCKS.STONE,
    min: { x: cx - 28, y: TOWN_GROUND_Y + 1, z: cz },
    max: { x: cx + 28, y: TOWN_GROUND_Y + 1, z: cz },
    overwrite: true,
  });
  ops.push({
    kind: "fill",
    id: BLOCKS.STONE,
    min: { x: cx, y: TOWN_GROUND_Y + 1, z: cz - 28 },
    max: { x: cx, y: TOWN_GROUND_Y + 1, z: cz + 28 },
    overwrite: true,
  });

  // 4) Plaza
  const plazaR = 9;
  ops.push({
    kind: "fill",
    id: PLANKS,
    min: { x: cx - plazaR, y: TOWN_GROUND_Y, z: cz - plazaR },
    max: { x: cx + plazaR, y: TOWN_GROUND_Y, z: cz + plazaR },
    overwrite: true,
  });

  // 5) Spawn pillar (stone column)
  ops.push({
    kind: "fill",
    id: BLOCKS.STONE,
    min: { x: cx, y: TOWN_GROUND_Y + 1, z: cz },
    max: { x: cx, y: TOWN_GROUND_Y + 4, z: cz },
    overwrite: true,
  });

  // 6) Starter hut (simple hollow box)
  const hutMin = { x: cx + 12, y: TOWN_GROUND_Y + 1, z: cz - 6 };
  const hutMax = { x: cx + 20, y: TOWN_GROUND_Y + 5, z: cz + 6 };

  ops.push({
    kind: "fill",
    id: PLANKS,
    min: hutMin,
    max: hutMax,
    overwrite: true,
  });

  // Hollow interior
  ops.push({
    kind: "clear",
    min: { x: hutMin.x + 1, y: hutMin.y + 1, z: hutMin.z + 1 },
    max: { x: hutMax.x - 1, y: hutMax.y - 1, z: hutMax.z - 1 },
  });

  // Doorway
  ops.push({
    kind: "clear",
    min: { x: hutMin.x, y: TOWN_GROUND_Y + 1, z: cz },
    max: { x: hutMin.x, y: TOWN_GROUND_Y + 2, z: cz },
  });

  // Optional interior blocks
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

    const b = normalizeBox(op.min, op.max);

    if (opts?.verbose) {
      console.log(
        `[TOWN] op ${opsApplied}/${ops.length} ${op.kind} vol=${volume(op.min, op.max)} box=(${b.minX},${b.minY},${b.minZ})..(${b.maxX},${b.maxY},${b.maxZ})`
      );
    }

    if (op.kind === "clear") {
      for (let x = b.minX; x <= b.maxX; x++) {
        for (let y = b.minY; y <= b.maxY; y++) {
          for (let z = b.minZ; z <= b.maxZ; z++) {
            blocksTouched += setBlockForce(world, x, y, z, BLOCKS.AIR);
          }
        }
      }
      continue;
    }

    // fill
    const onlyIfAir = !!op.onlyIfAir;
    const overwrite = !!op.overwrite;

    for (let x = b.minX; x <= b.maxX; x++) {
      for (let y = b.minY; y <= b.maxY; y++) {
        for (let z = b.minZ; z <= b.maxZ; z++) {
          blocksTouched += setBlockForce(world, x, y, z, op.id, { onlyIfAir, overwrite });
        }
      }
    }
  }

  return { opsApplied, blocksTouched };
}

// -----------------------------
// Stamp meta
// -----------------------------

function readStampMeta(metaPath: string): { version: string } | null {
  if (!fs.existsSync(metaPath)) return null;
  try {
    const raw = fs.readFileSync(metaPath, "utf8");
    const j = JSON.parse(raw);
    if (j && typeof j.version === "string") return { version: j.version };
    return null;
  } catch {
    return null;
  }
}

function writeStampMeta(metaPath: string, version: string) {
  try {
    fs.writeFileSync(metaPath, JSON.stringify({ version, at: Date.now() }, null, 2));
  } catch (e) {
    console.error("[TOWN] Failed to write stamp meta:", e);
  }
}

// -----------------------------
// Public stamp entrypoint
// -----------------------------

export function stampTownOfBeginnings(
  world: WorldStore,
  opts?: { verbose?: boolean; force?: boolean }
): StampResult {
  const metaPath = stampMetaPath();
  const meta = readStampMeta(metaPath);

  const forced = !!opts?.force;

  if (!forced && meta?.version === TOWN_STAMP_VERSION) {
    if (opts?.verbose) {
      console.log(`[TOWN] stamp skipped (already stamped) version=${TOWN_STAMP_VERSION} meta=${metaPath}`);
    }
    return {
      stamped: false,
      forced,
      version: TOWN_STAMP_VERSION,
      opsApplied: 0,
      blocksTouched: 0,
      metaPath,
    };
  }

  if (opts?.verbose) {
    console.log(
      `[TOWN] stamping version=${TOWN_STAMP_VERSION} forced=${forced} meta=${metaPath} previous=${meta?.version || "none"}`
    );
  }

  const ops = townOfBeginningsBlueprint();
  const applied = applyTownOps(world, ops, { verbose: opts?.verbose });

  // Update meta so we don't re-stamp every boot (unless force=true)
  writeStampMeta(metaPath, TOWN_STAMP_VERSION);

  return {
    stamped: true,
    forced,
    version: TOWN_STAMP_VERSION,
    opsApplied: applied.opsApplied,
    blocksTouched: applied.blocksTouched,
    metaPath,
  };
}
