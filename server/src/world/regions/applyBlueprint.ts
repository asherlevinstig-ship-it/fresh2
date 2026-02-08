// ============================================================
// src/world/regions/applyBlueprint.ts
// ------------------------------------------------------------
// Town of Beginnings (PHASE 1 UPGRADE):
// - Perfectly flat town ground
// - Outer stone walls (2-thick, 8-high)
// - 4 corner towers (5x5, taller)
// - South gate opening + simple arch
// - Inner ring path + spawn-to-hut path
// - Plaza + hut (starter building)
// - Giant cross marker for immediate visibility
// - Stamp meta (versioned) + optional force restamp
// - Safe-zone helper: inTownSafeZone(x,y,z)
//
// IMPORTANT:
// - Explicit union types to avoid TS "never" inference errors.
// - Uses WorldStore applyBreak/applyPlace for correctness.
// - Bumps TOWN_STAMP_VERSION whenever blueprint changes.
//
// FIXES INCLUDED (no behavior removed):
// - FIX: Gate arch clearing now clears UNDER the beam (not the beam itself)
// - FIX: Stamp meta write is atomic (Windows-safe) to avoid corrupt meta + unwanted restamps
// - Small clarity helpers for fill modes (overwrite vs onlyIfAir)
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

export type TownFillOp = {
  kind: "fill";
  id: BlockId;
  min: Vec3i;
  max: Vec3i;
  onlyIfAir?: boolean; // do not overwrite existing
  overwrite?: boolean; // break then place (authoritative)
};

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
// Town Config
// -----------------------------

export const TOWN_SAFE_ZONE: TownRegion = {
  center: { x: 0, z: 0 },
  radius: 42,
  yMin: -64,
  yMax: 256,
};

// Flat ground level
export const TOWN_GROUND_Y = 10;

// Bump when blueprint changes
export const TOWN_STAMP_VERSION = "town_v2_walls_towers_gate_paths_001";

// -----------------------------
// Stamp meta path
// -----------------------------

function stampMetaPath() {
  return path.join(process.cwd(), "town_stamp.json");
}

// -----------------------------
// Math / Region Helpers
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

// -----------------------------
// Atomic write helper (Windows-safe)
// -----------------------------

function writeJsonAtomic(filePath: string, data: any) {
  const dir = path.dirname(filePath);
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch {}

  const tmp = `${filePath}.tmp.${process.pid}.${Math.floor(Math.random() * 1e9)}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));

  try {
    // POSIX: rename replaces; Windows: rename can fail if dest exists.
    fs.renameSync(tmp, filePath);
    return;
  } catch {
    try {
      fs.copyFileSync(tmp, filePath);
      try {
        fs.unlinkSync(tmp);
      } catch {}
      return;
    } catch {
      try {
        fs.rmSync(filePath, { force: true });
      } catch {}
      fs.renameSync(tmp, filePath);
      return;
    }
  }
}

// -----------------------------
// World write helpers
// -----------------------------

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

  // clear
  if (id === BLOCKS.AIR) {
    if (existing !== BLOCKS.AIR) {
      world.applyBreak(x, y, z);
      return 1;
    }
    return 0;
  }

  // fill
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
    minX: (Math.min(min.x, max.x) | 0),
    maxX: (Math.max(min.x, max.x) | 0),
    minY: (Math.min(min.y, max.y) | 0),
    maxY: (Math.max(min.y, max.y) | 0),
    minZ: (Math.min(min.z, max.z) | 0),
    maxZ: (Math.max(min.z, max.z) | 0),
  };
}

function volume(min: Vec3i, max: Vec3i) {
  const b = normalizeBox(min, max);
  const dx = Math.max(0, (b.maxX - b.minX + 1) | 0);
  const dy = Math.max(0, (b.maxY - b.minY + 1) | 0);
  const dz = Math.max(0, (b.maxZ - b.minZ + 1) | 0);
  return dx * dy * dz;
}

// Clear box
function clearBox(min: Vec3i, max: Vec3i): TownClearOp {
  return { kind: "clear", min, max };
}

// Fill box (authoritative overwrite by default)
function fillBox(id: BlockId, min: Vec3i, max: Vec3i, overwrite = true): TownFillOp {
  return { kind: "fill", id, min, max, overwrite };
}

// Fill box only into air (non-destructive)
function fillBoxIfAir(id: BlockId, min: Vec3i, max: Vec3i): TownFillOp {
  return { kind: "fill", id, min, max, onlyIfAir: true, overwrite: false };
}

// -----------------------------
// Blueprint helpers (composed ops)
// -----------------------------

function addWallRingSquare(
  ops: TownOp[],
  opts: {
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
    y0: number;
    y1: number;
    thickness: number;
    id: BlockId;
    gate?: { side: "south" | "north" | "west" | "east"; width: number; height: number; centerOffset?: number };
  }
) {
  const { minX, maxX, minZ, maxZ, y0, y1, thickness, id, gate } = opts;

  // We build 4 strips (north/south/east/west), then "cut" the gate by clearing.

  // North strip
  ops.push(
    fillBox(id, { x: minX, y: y0, z: maxZ - (thickness - 1) }, { x: maxX, y: y1, z: maxZ }, true)
  );

  // South strip
  ops.push(fillBox(id, { x: minX, y: y0, z: minZ }, { x: maxX, y: y1, z: minZ + (thickness - 1) }, true));

  // West strip
  ops.push(
    fillBox(id, { x: minX, y: y0, z: minZ }, { x: minX + (thickness - 1), y: y1, z: maxZ }, true)
  );

  // East strip
  ops.push(
    fillBox(id, { x: maxX - (thickness - 1), y: y0, z: minZ }, { x: maxX, y: y1, z: maxZ }, true)
  );

  // Gate carve (clear opening)
  if (gate) {
    const w = Math.max(1, gate.width | 0);
    const h = Math.max(1, gate.height | 0);
    const off = (gate.centerOffset || 0) | 0;

    if (gate.side === "south") {
      const cx = (((minX + maxX) / 2) | 0) + off;
      const x0 = cx - ((w / 2) | 0);
      const x1 = x0 + w - 1;
      const z0 = minZ;
      const z1 = minZ + (thickness - 1);
      ops.push(clearBox({ x: x0, y: y0, z: z0 }, { x: x1, y: y0 + h - 1, z: z1 }));
    } else if (gate.side === "north") {
      const cx = (((minX + maxX) / 2) | 0) + off;
      const x0 = cx - ((w / 2) | 0);
      const x1 = x0 + w - 1;
      const z0 = maxZ - (thickness - 1);
      const z1 = maxZ;
      ops.push(clearBox({ x: x0, y: y0, z: z0 }, { x: x1, y: y0 + h - 1, z: z1 }));
    } else if (gate.side === "west") {
      const cz = (((minZ + maxZ) / 2) | 0) + off;
      const z0 = cz - ((w / 2) | 0);
      const z1 = z0 + w - 1;
      const x0 = minX;
      const x1 = minX + (thickness - 1);
      ops.push(clearBox({ x: x0, y: y0, z: z0 }, { x: x1, y: y0 + h - 1, z: z1 }));
    } else {
      const cz = (((minZ + maxZ) / 2) | 0) + off;
      const z0 = cz - ((w / 2) | 0);
      const z1 = z0 + w - 1;
      const x0 = maxX - (thickness - 1);
      const x1 = maxX;
      ops.push(clearBox({ x: x0, y: y0, z: z0 }, { x: x1, y: y0 + h - 1, z: z1 }));
    }
  }
}

function addTower(
  ops: TownOp[],
  opts: { cx: number; cz: number; size: number; y0: number; y1: number; id: BlockId; hollow?: boolean }
) {
  const { cx, cz, size, y0, y1, id, hollow } = opts;
  const half = (size / 2) | 0;

  const min = { x: cx - half, y: y0, z: cz - half };
  const max = { x: cx + half, y: y1, z: cz + half };

  ops.push(fillBox(id, min, max, true));

  if (hollow && size >= 3 && y1 - y0 >= 2) {
    ops.push(clearBox({ x: min.x + 1, y: y0 + 1, z: min.z + 1 }, { x: max.x - 1, y: y1 - 1, z: max.z - 1 }));
  }
}

function addArch(
  ops: TownOp[],
  opts: { x0: number; x1: number; z: number; yBase: number; thickness: number; height: number; id: BlockId }
) {
  const { x0, x1, z, yBase, thickness, height, id } = opts;

  // Simple arch: a 2-thick slab above gate + 2 pillars on sides
  const yTop = yBase + height - 1;

  // Top beam (solid)
  ops.push(fillBox(id, { x: x0, y: yTop, z }, { x: x1, y: yTop, z: z + (thickness - 1) }, true));

  // Side pillars (2-wide ends)
  ops.push(fillBox(id, { x: x0, y: yBase, z }, { x: x0 + 1, y: yTop, z: z + (thickness - 1) }, true));
  ops.push(fillBox(id, { x: x1 - 1, y: yBase, z }, { x: x1, y: yTop, z: z + (thickness - 1) }, true));

  // FIX: Clear the opening UNDER the beam (not the beam itself)
  if (x1 - x0 >= 4 && height >= 2) {
    ops.push(
      clearBox(
        { x: x0 + 2, y: yBase, z },
        { x: x1 - 2, y: yTop - 1, z: z + (thickness - 1) }
      )
    );
  }
}

// -----------------------------
// Blueprint
// -----------------------------

export function townOfBeginningsBlueprint(): TownOp[] {
  const cx = TOWN_SAFE_ZONE.center.x | 0;
  const cz = TOWN_SAFE_ZONE.center.z | 0;

  const r = TOWN_SAFE_ZONE.radius | 0;

  // Town floor box
  const minX = cx - r;
  const maxX = cx + r;
  const minZ = cz - r;
  const maxZ = cz + r;

  // Wall ring slightly inside the floor edge
  const wallInset = 4; // how far from edge of town floor to wall
  const wallMinX = minX + wallInset;
  const wallMaxX = maxX - wallInset;
  const wallMinZ = minZ + wallInset;
  const wallMaxZ = maxZ - wallInset;

  const groundY = TOWN_GROUND_Y;

  const CLEAR_Y_MIN = groundY;
  const CLEAR_Y_MAX = groundY + 90;

  const WALL_THICK = 2;
  const WALL_H = 8;
  const wallY0 = groundY + 1;
  const wallY1 = groundY + WALL_H;

  const STONE: BlockId = BLOCKS.STONE;
  const GRASS: BlockId = BLOCKS.GRASS;

  const PLANKS: BlockId = (BLOCKS as any).PLANKS ?? BLOCKS.LOG;
  const GRAVEL: BlockId = (BLOCKS as any).GRAVEL ?? BLOCKS.STONE;

  const CRAFTING_TABLE: BlockId | null = (BLOCKS as any).CRAFTING_TABLE ?? null;
  const CHEST: BlockId | null = (BLOCKS as any).CHEST ?? null;

  const ops: TownOp[] = [];

  // 1) Clear everything above ground inside the whole town square
  ops.push(clearBox({ x: minX, y: CLEAR_Y_MIN, z: minZ }, { x: maxX, y: CLEAR_Y_MAX, z: maxZ }));

  // 2) Flat grass floor (one layer)
  ops.push(fillBox(GRASS, { x: minX, y: groundY, z: minZ }, { x: maxX, y: groundY, z: maxZ }, true));

  // 3) Giant stone cross marker at center (very visible)
  ops.push(fillBox(STONE, { x: cx - 28, y: groundY + 1, z: cz }, { x: cx + 28, y: groundY + 1, z: cz }, true));
  ops.push(fillBox(STONE, { x: cx, y: groundY + 1, z: cz - 28 }, { x: cx, y: groundY + 1, z: cz + 28 }, true));

  // 4) Outer stone walls with south gate opening
  const gateWidth = 5;
  const gateHeight = 4;

  addWallRingSquare(ops, {
    minX: wallMinX,
    maxX: wallMaxX,
    minZ: wallMinZ,
    maxZ: wallMaxZ,
    y0: wallY0,
    y1: wallY1,
    thickness: WALL_THICK,
    id: STONE,
    gate: { side: "south", width: gateWidth, height: gateHeight, centerOffset: 0 },
  });

  // 5) Gate arch just above the opening (south side)
  {
    const gateCenterX = (((wallMinX + wallMaxX) / 2) | 0);
    const x0 = gateCenterX - ((gateWidth / 2) | 0);
    const x1 = x0 + gateWidth - 1;

    // South wall z location (outer edge)
    const z = wallMinZ; // start of south strip
    addArch(ops, {
      x0: x0 - 2, // slightly wider than opening
      x1: x1 + 2,
      z,
      yBase: wallY0,
      thickness: WALL_THICK,
      height: gateHeight + 2,
      id: STONE,
    });
  }

  // 6) Corner towers (5x5, taller), hollow inside
  const towerSize = 5;
  const towerY1 = wallY1 + 4;

  addTower(ops, { cx: wallMinX, cz: wallMinZ, size: towerSize, y0: wallY0, y1: towerY1, id: STONE, hollow: true });
  addTower(ops, { cx: wallMaxX, cz: wallMinZ, size: towerSize, y0: wallY0, y1: towerY1, id: STONE, hollow: true });
  addTower(ops, { cx: wallMinX, cz: wallMaxZ, size: towerSize, y0: wallY0, y1: towerY1, id: STONE, hollow: true });
  addTower(ops, { cx: wallMaxX, cz: wallMaxZ, size: towerSize, y0: wallY0, y1: towerY1, id: STONE, hollow: true });

  // 7) Inner perimeter path ring (gravel) just inside the walls
  ops.push(
    fillBox(
      GRAVEL,
      { x: wallMinX + WALL_THICK, y: groundY, z: wallMinZ + WALL_THICK },
      { x: wallMaxX - WALL_THICK, y: groundY, z: wallMaxZ - WALL_THICK },
      true
    )
  );
  // Hollow middle back to grass (so it's a ring, not full fill)
  ops.push(
    fillBox(
      GRASS,
      { x: wallMinX + WALL_THICK + 2, y: groundY, z: wallMinZ + WALL_THICK + 2 },
      { x: wallMaxX - WALL_THICK - 2, y: groundY, z: wallMaxZ - WALL_THICK - 2 },
      true
    )
  );

  // 8) Plaza at center (planks)
  const plazaR = 10;
  ops.push(fillBox(PLANKS, { x: cx - plazaR, y: groundY, z: cz - plazaR }, { x: cx + plazaR, y: groundY, z: cz + plazaR }, true));

  // 9) Spawn pillar (stone column)
  ops.push(fillBox(STONE, { x: cx, y: groundY + 1, z: cz }, { x: cx, y: groundY + 4, z: cz }, true));

  // 10) Path from south gate to plaza center (gravel)
  {
    const gateCenterX = (((wallMinX + wallMaxX) / 2) | 0);
    const startZ = wallMinZ - 2; // slightly outside the wall for approach
    const endZ = cz + plazaR; // into plaza
    const pathHalf = 1; // 3-wide path
    ops.push(fillBox(GRAVEL, { x: gateCenterX - pathHalf, y: groundY, z: startZ }, { x: gateCenterX + pathHalf, y: groundY, z: endZ }, true));
  }

  // 11) Starter hut near plaza (simple plank shell, hollow)
  const hutMin = { x: cx + 14, y: groundY + 1, z: cz - 6 };
  const hutMax = { x: cx + 22, y: groundY + 5, z: cz + 6 };

  ops.push(fillBox(PLANKS, hutMin, hutMax, true));

  // Hollow interior
  ops.push(clearBox({ x: hutMin.x + 1, y: hutMin.y + 1, z: hutMin.z + 1 }, { x: hutMax.x - 1, y: hutMax.y - 1, z: hutMax.z - 1 }));

  // Doorway facing plaza (west side of hut)
  ops.push(clearBox({ x: hutMin.x, y: groundY + 1, z: cz }, { x: hutMin.x, y: groundY + 2, z: cz }));

  // Hut-to-plaza path (gravel)
  ops.push(fillBox(GRAVEL, { x: cx + 11, y: groundY, z: cz - 1 }, { x: cx + 14, y: groundY, z: cz + 1 }, true));

  // Optional interior blocks (non-destructive by default)
  if (CRAFTING_TABLE != null) {
    ops.push(fillBoxIfAir(CRAFTING_TABLE, { x: hutMin.x + 2, y: groundY + 1, z: hutMin.z + 2 }, { x: hutMin.x + 2, y: groundY + 1, z: hutMin.z + 2 }));
  }
  if (CHEST != null) {
    ops.push(fillBoxIfAir(CHEST, { x: hutMin.x + 3, y: groundY + 1, z: hutMin.z + 2 }, { x: hutMin.x + 3, y: groundY + 1, z: hutMin.z + 2 }));
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
// Stamp meta I/O
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
    // FIX: atomic meta write (Windows-safe)
    writeJsonAtomic(metaPath, { version, at: Date.now() });
  } catch (e) {
    console.error("[TOWN] Failed to write stamp meta:", e);
  }
}

// -----------------------------
// Public stamp entrypoint
// -----------------------------

export function stampTownOfBeginnings(world: WorldStore, opts?: { verbose?: boolean; force?: boolean }): StampResult {
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
