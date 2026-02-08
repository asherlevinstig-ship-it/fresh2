// ============================================================
// server/world/regions/applyBlueprint.ts  (FULL - NO OMITS)
// ------------------------------------------------------------
// Purpose:
// - Apply TownOfBeginnings plan ops to WorldStore edits
// - Supports:
//   - fill cylinder / fill box
//   - clear cylinder / clear box (AIR)
//   - place single blocks
// - Has a simple version gate so the town stamps only when version changes
//
// Integration:
// - In MyRoom.onCreate after loading world + configuring autosave:
//     import { stampTownOfBeginnings, inTownSafeZone } from "../world/regions/applyBlueprint.js";
//     stampTownOfBeginnings(MyRoom.WORLD);
// - In block:break/place handlers:
//     if (inTownSafeZone(x,y,z)) reject(...);
//
// Notes:
// - Assumes WorldStore has:
//     getBlock(x,y,z) -> BlockId
//     applyPlace(x,y,z,id) -> { newId: BlockId } (or similar)
//   If you have a faster `setBlock`, this file will use it automatically.
// ============================================================

import * as fs from "fs";
import * as path from "path";

import { WorldStore, BLOCKS, type BlockId } from "../WorldStore.js";
import { buildTownOfBeginningsPlan, inTownSafeZone, type TownPlan, type TownOp } from "./TownOfBeginnings.js";

// ------------------------------------------------------------
// Stamp version gate
// ------------------------------------------------------------

type StampState = {
  townOfBeginnings?: {
    version: number;
    stampedAt: number;
  };
};

function getStampFilePath() {
  // Keep this near your other persistence files; feel free to change location
  return path.join(process.cwd(), "town_stamp.json");
}

function readStampState(): StampState {
  const file = getStampFilePath();
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) || {};
  } catch {
    return {};
  }
}

function writeStampState(state: StampState) {
  const file = getStampFilePath();
  try {
    fs.writeFileSync(file, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error("[TOWN] Failed to write stamp state:", e);
  }
}

// ------------------------------------------------------------
// WorldStore compatibility helpers
// ------------------------------------------------------------

type WorldStoreLike = WorldStore & {
  // optional fast path if you add it
  setBlock?: (x: number, y: number, z: number, id: BlockId) => void;
};

function setBlock(world: WorldStoreLike, x: number, y: number, z: number, id: BlockId) {
  if (typeof world.setBlock === "function") {
    world.setBlock(x, y, z, id);
    return;
  }

  // Fallback: use applyPlace; if applyPlace doesn't overwrite, this may need enhancement.
  // Most WorldStore implementations for edits allow placing into any cell and tracking edits.
  world.applyPlace(x, y, z, id);
}

// ------------------------------------------------------------
// Geometry iterators
// ------------------------------------------------------------

function forEachCylinderXZ(
  centerX: number,
  centerZ: number,
  radius: number,
  fn: (x: number, z: number) => void
) {
  const r = Math.max(0, Math.floor(radius));
  const r2 = r * r;

  for (let x = centerX - r; x <= centerX + r; x++) {
    const dx = x - centerX;
    const dx2 = dx * dx;

    for (let z = centerZ - r; z <= centerZ + r; z++) {
      const dz = z - centerZ;
      if (dx2 + dz * dz <= r2) fn(x, z);
    }
  }
}

function forEachBoxXZ(minX: number, maxX: number, minZ: number, maxZ: number, fn: (x: number, z: number) => void) {
  for (let x = minX; x <= maxX; x++) {
    for (let z = minZ; z <= maxZ; z++) {
      fn(x, z);
    }
  }
}

// ------------------------------------------------------------
// Apply ops
// ------------------------------------------------------------

export type ApplyOptions = {
  // If true, log progress
  verbose?: boolean;

  // Safety: do not stamp if there are already many edits within the town radius
  // (helps prevent overwriting existing worlds accidentally). Default: off.
  maxExistingEditsInArea?: number;

  // If true, force stamp even if version is unchanged
  force?: boolean;
};

function countNonAirInCylinder(world: WorldStoreLike, centerX: number, centerY: number, centerZ: number, radius: number, yMin: number, yMax: number) {
  let count = 0;
  forEachCylinderXZ(centerX, centerZ, radius, (x, z) => {
    for (let y = yMin; y <= yMax; y++) {
      const id = world.getBlock(x, y, z);
      if (id !== BLOCKS.AIR) count++;
    }
  });
  return count;
}

function applyPlaceOp(world: WorldStoreLike, op: Extract<TownOp, { kind: "place" }>) {
  const existing = world.getBlock(op.x, op.y, op.z);
  if (op.onlyIfAir && existing !== BLOCKS.AIR) return;
  setBlock(world, op.x, op.y, op.z, op.id);
}

function applyFillCylinderOp(world: WorldStoreLike, op: Extract<TownOp, { kind: "fill"; shape: "cylinder" }>) {
  const c = op.center!;
  const radius = op.radius || 0;

  const yMin = Math.min(op.yMin, op.yMax);
  const yMax = Math.max(op.yMin, op.yMax);

  forEachCylinderXZ(c.x, c.z, radius, (x, z) => {
    for (let y = yMin; y <= yMax; y++) {
      const existing = world.getBlock(x, y, z);

      if (op.onlyIfAir && existing !== BLOCKS.AIR) continue;
      if (op.overwrite === false && existing !== BLOCKS.AIR) continue;

      setBlock(world, x, y, z, op.id);
    }
  });
}

function applyClearCylinderOp(world: WorldStoreLike, op: Extract<TownOp, { kind: "clear"; shape: "cylinder" }>) {
  const c = op.center!;
  const radius = op.radius || 0;

  const yMin = Math.min(op.yMin, op.yMax);
  const yMax = Math.max(op.yMin, op.yMax);

  forEachCylinderXZ(c.x, c.z, radius, (x, z) => {
    for (let y = yMin; y <= yMax; y++) {
      const existing = world.getBlock(x, y, z);
      if (existing === BLOCKS.AIR) continue;
      // Clear is always overwrite
      setBlock(world, x, y, z, BLOCKS.AIR);
    }
  });
}

function applyFillBoxOp(world: WorldStoreLike, op: Extract<TownOp, { kind: "fill"; shape: "box" }>) {
  const min = op.min!;
  const max = op.max!;

  const minX = Math.min(min.x, max.x);
  const maxX = Math.max(min.x, max.x);
  const minY = Math.min(min.y, max.y);
  const maxY = Math.max(min.y, max.y);
  const minZ = Math.min(min.z, max.z);
  const maxZ = Math.max(min.z, max.z);

  forEachBoxXZ(minX, maxX, minZ, maxZ, (x, z) => {
    for (let y = minY; y <= maxY; y++) {
      const existing = world.getBlock(x, y, z);

      if (op.onlyIfAir && existing !== BLOCKS.AIR) continue;
      if (op.overwrite === false && existing !== BLOCKS.AIR) continue;

      setBlock(world, x, y, z, op.id);
    }
  });
}

function applyClearBoxOp(world: WorldStoreLike, op: Extract<TownOp, { kind: "clear"; shape: "box" }>) {
  const min = op.min!;
  const max = op.max!;

  const minX = Math.min(min.x, max.x);
  const maxX = Math.max(min.x, max.x);
  const minY = Math.min(min.y, max.y);
  const maxY = Math.max(min.y, max.y);
  const minZ = Math.min(min.z, max.z);
  const maxZ = Math.max(min.z, max.z);

  forEachBoxXZ(minX, maxX, minZ, maxZ, (x, z) => {
    for (let y = minY; y <= maxY; y++) {
      const existing = world.getBlock(x, y, z);
      if (existing === BLOCKS.AIR) continue;
      setBlock(world, x, y, z, BLOCKS.AIR);
    }
  });
}

export function applyTownPlan(world: WorldStoreLike, plan: TownPlan, options: ApplyOptions = {}) {
  const verbose = !!options.verbose;

  if (verbose) console.log(`[TOWN] Applying plan "${plan.name}" v${plan.version}...`);

  for (const op of plan.ops) {
    if (op.kind === "place") {
      applyPlaceOp(world, op);
      continue;
    }

    if (op.kind === "fill" && op.shape === "cylinder") {
      applyFillCylinderOp(world, op);
      continue;
    }

    if (op.kind === "clear" && op.shape === "cylinder") {
      applyClearCylinderOp(world, op);
      continue;
    }

    if (op.kind === "fill" && op.shape === "box") {
      applyFillBoxOp(world, op);
      continue;
    }

    if (op.kind === "clear" && op.shape === "box") {
      applyClearBoxOp(world, op);
      continue;
    }
  }

  if (verbose) console.log(`[TOWN] Done applying plan "${plan.name}".`);
}

// ------------------------------------------------------------
// High-level: Stamp Town of Beginnings (version-gated)
// ------------------------------------------------------------

export function stampTownOfBeginnings(world: WorldStoreLike, options: ApplyOptions = {}) {
  const plan = buildTownOfBeginningsPlan();

  // Version gate
  const state = readStampState();
  const stamped = state.townOfBeginnings;

  if (!options.force && stamped && stamped.version === plan.version) {
    if (options.verbose) console.log(`[TOWN] Already stamped v${plan.version}, skipping.`);
    return { ok: true, skipped: true, version: plan.version };
  }

  // Optional safety: if there are many non-air blocks in the core town area,
  // likely a real world exists; prevent stomping unless force.
  if (typeof options.maxExistingEditsInArea === "number" && options.maxExistingEditsInArea >= 0) {
    const nonAir = countNonAirInCylinder(
      world,
      plan.center.x,
      plan.center.y,
      plan.center.z,
      Math.min(plan.safeRadius, 24),
      plan.baseY - 1,
      plan.baseY + 8
    );

    if (nonAir > options.maxExistingEditsInArea && !options.force) {
      console.warn(
        `[TOWN] Abort stamp: core area has ${nonAir} non-air blocks (limit ${options.maxExistingEditsInArea}). Use force to override.`
      );
      return { ok: false, skipped: true, reason: "too_many_existing_blocks", nonAir, limit: options.maxExistingEditsInArea };
    }
  }

  applyTownPlan(world, plan, options);

  // Persist stamp state
  state.townOfBeginnings = { version: plan.version, stampedAt: Date.now() };
  writeStampState(state);

  return { ok: true, skipped: false, version: plan.version };
}

// Re-export safe-zone helper for convenience
export { inTownSafeZone };
