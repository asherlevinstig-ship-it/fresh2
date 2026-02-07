// ============================================================
// server/world/WorldStore.ts  (FULL REWRITE - NO OMITS, ALL LOGIC INCLUDED)
// ------------------------------------------------------------
// Purpose:
// - Server-authoritative voxel world for a NOA-style Minecraft clone.
// - Deterministic base terrain generation (must match client).
// - Stores ONLY edits (placed/broken blocks) in a compact Map.
// - Supports chunk snapshots + patching for late joiners.
// - OPTIONAL persistence helpers:
//     - saveToFile/loadFromFile (great for local dev / self-host)
//     - serialize/deserialize for plugging into Redis/DB later
//
// IMPORTANT:
// - Block IDs MUST match the client registry:
//     0 = air
//     1 = dirt
//     2 = grass
// - Base terrain function MUST match client getVoxelID(x,y,z):
//     height = 2*sin(x/10) + 3*cos(z/20)
//     if y < height - 1 => dirt
//     else if y < height => grass
//     else air
//
// API:
//   - getBaseBlock(x,y,z) -> number
//   - getBlock(x,y,z) -> number   (edits override base)
//   - setBlock(x,y,z,id) -> number (stores delta vs base)
//   - applyBreak(x,y,z) -> { prevId, newId }
//   - applyPlace(x,y,z,id) -> { prevId, newId }
//   - getEditsInAABB(min,max) -> array of {x,y,z,id}
//   - getAllEdits() -> array of {x,y,z,id}
//   - makeChunkSnapshot(chunkX,chunkY,chunkZ,chunkSize) -> Uint16Array
//   - encodeEditsPatch(min,max,{limit}) -> { edits, truncated }
//   - encodePatchAround(center,radius,{limit}) -> { edits, truncated }
//   - serialize() -> { version, edits:[...] }
//   - applySerialized(data, {replace}) -> void
//   - saveToFile(path) / loadFromFile(path, {replace})
// ============================================================

import * as fs from "node:fs";
import * as path from "node:path";

export type BlockId = number;

export const BLOCKS = {
  AIR: 0,
  DIRT: 1,
  GRASS: 2,
} as const;

export type WorldEdit = { x: number; y: number; z: number; id: BlockId };

type SerializedWorld = {
  version: number;
  edits: WorldEdit[];
};

function isFiniteNum(n: any): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

function i32(n: any, fallback = 0) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return v | 0;
}

/** String key for Map storage */
function keyOf(x: number, y: number, z: number) {
  return `${x}|${y}|${z}`;
}

/** Inverse for utilities / persistence parsing */
function parseKey(k: string): { x: number; y: number; z: number } | null {
  if (typeof k !== "string") return null;
  const parts = k.split("|");
  if (parts.length !== 3) return null;
  const x = Number(parts[0]);
  const y = Number(parts[1]);
  const z = Number(parts[2]);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return { x: x | 0, y: y | 0, z: z | 0 };
}

/**
 * Deterministic base terrain function.
 * MUST match the client.
 */
export function getBaseVoxelID(x: number, y: number, z: number): BlockId {
  const height = 2 * Math.sin(x / 10) + 3 * Math.cos(z / 20);

  if (y < height - 1) return BLOCKS.DIRT;
  if (y < height) return BLOCKS.GRASS;
  return BLOCKS.AIR;
}

/**
 * WorldStore keeps ONLY edits vs base terrain.
 * If an edit matches the base, it is removed (keeps map small).
 */
export class WorldStore {
  private edits: Map<string, BlockId>;

  public readonly minCoord: number;
  public readonly maxCoord: number;

  // Simple dirty flag + throttled autosave support
  private _dirty: boolean = false;
  private _lastSaveAt: number = 0;
  private _autosavePath: string | null = null;
  private _autosaveMinIntervalMs: number = 2500;

  constructor(opts?: { minCoord?: number; maxCoord?: number; seed?: number; autosavePath?: string; autosaveMinIntervalMs?: number }) {
    this.edits = new Map();

    this.minCoord = isFiniteNum(opts?.minCoord) ? (opts!.minCoord as number) : -100000;
    this.maxCoord = isFiniteNum(opts?.maxCoord) ? (opts!.maxCoord as number) : 100000;

    if (typeof opts?.autosavePath === "string" && opts.autosavePath.trim()) {
      this._autosavePath = opts.autosavePath.trim();
    }
    if (isFiniteNum(opts?.autosaveMinIntervalMs)) {
      this._autosaveMinIntervalMs = Math.max(250, (opts!.autosaveMinIntervalMs as number) | 0);
    }
  }

  /** Enable/disable autosave (file). */
  public configureAutosave(opts: { path?: string | null; minIntervalMs?: number }) {
    if (typeof opts.path === "string" && opts.path.trim()) this._autosavePath = opts.path.trim();
    if (opts.path === null) this._autosavePath = null;

    if (isFiniteNum(opts.minIntervalMs)) {
      this._autosaveMinIntervalMs = Math.max(250, (opts.minIntervalMs as number) | 0);
    }
  }

  /** Mark dirty and (optionally) autosave. */
  private markDirty() {
    this._dirty = true;
    this.maybeAutosave();
  }

  /** Autosave if enabled and throttled interval passed. */
  private maybeAutosave() {
    if (!this._autosavePath) return;
    const now = Date.now();
    if (!this._dirty) return;
    if (now - this._lastSaveAt < this._autosaveMinIntervalMs) return;

    try {
      this.saveToFileSync(this._autosavePath);
      this._lastSaveAt = now;
      this._dirty = false;
    } catch {
      // keep dirty; next attempt may succeed
    }
  }

  /** Clamp coords into safe range for sanity */
  public sanitizeCoord(n: any) {
    const v = i32(n, 0);
    return clamp(v, this.minCoord, this.maxCoord) | 0;
  }

  /** Sanitize a full position */
  public sanitizePos(x: any, y: any, z: any) {
    return {
      x: this.sanitizeCoord(x),
      y: this.sanitizeCoord(y),
      z: this.sanitizeCoord(z),
    };
  }

  /** Base block at coordinate (no edits considered) */
  public getBaseBlock(x: number, y: number, z: number): BlockId {
    return getBaseVoxelID(x | 0, y | 0, z | 0);
  }

  /** Final block at coordinate (edits override base) */
  public getBlock(x: number, y: number, z: number): BlockId {
    x |= 0;
    y |= 0;
    z |= 0;
    const k = keyOf(x, y, z);
    const e = this.edits.get(k);
    if (typeof e === "number") return e;
    return this.getBaseBlock(x, y, z);
  }

  /**
   * Set a block at coordinate.
   * Stores only delta vs base terrain.
   * Returns the new final block id.
   */
  public setBlock(x: number, y: number, z: number, id: BlockId): BlockId {
    x |= 0;
    y |= 0;
    z |= 0;
    id = i32(id, BLOCKS.AIR);

    const base = this.getBaseBlock(x, y, z);
    const k = keyOf(x, y, z);

    if (id === base) {
      if (this.edits.has(k)) {
        this.edits.delete(k);
        this.markDirty();
      }
      return base;
    }

    const prev = this.edits.get(k);
    if (prev !== id) {
      this.edits.set(k, id);
      this.markDirty();
    }
    return id;
  }

  /**
   * Break a block (set to AIR).
   * Returns previous and new ids.
   */
  public applyBreak(x: number, y: number, z: number): { prevId: BlockId; newId: BlockId } {
    x |= 0;
    y |= 0;
    z |= 0;
    const prevId = this.getBlock(x, y, z);
    const newId = this.setBlock(x, y, z, BLOCKS.AIR);
    return { prevId, newId };
  }

  /**
   * Place a block (set to given id).
   * Returns previous and new ids.
   */
  public applyPlace(x: number, y: number, z: number, id: BlockId): { prevId: BlockId; newId: BlockId } {
    x |= 0;
    y |= 0;
    z |= 0;
    id = i32(id, BLOCKS.AIR);
    const prevId = this.getBlock(x, y, z);
    const newId = this.setBlock(x, y, z, id);
    return { prevId, newId };
  }

  /** Returns the internal edits Map size */
  public editsCount() {
    return this.edits.size;
  }

  /** Remove all edits (world reset) */
  public clearAllEdits() {
    if (this.edits.size > 0) {
      this.edits.clear();
      this.markDirty();
    }
  }

  /** Get all edits as an array (careful: can be big) */
  public getAllEdits(): WorldEdit[] {
    const out: WorldEdit[] = [];
    for (const [k, id] of this.edits.entries()) {
      const p = parseKey(k);
      if (!p) continue;
      out.push({ x: p.x, y: p.y, z: p.z, id });
    }
    return out;
  }

  /**
   * Get edits inside an axis-aligned bounding box (inclusive).
   */
  public getEditsInAABB(
    min: { x: number; y: number; z: number },
    max: { x: number; y: number; z: number }
  ): WorldEdit[] {
    const minX = Math.min(min.x | 0, max.x | 0);
    const maxX = Math.max(min.x | 0, max.x | 0);
    const minY = Math.min(min.y | 0, max.y | 0);
    const maxY = Math.max(min.y | 0, max.y | 0);
    const minZ = Math.min(min.z | 0, max.z | 0);
    const maxZ = Math.max(min.z | 0, max.z | 0);

    const out: WorldEdit[] = [];

    for (const [k, id] of this.edits.entries()) {
      const p = parseKey(k);
      if (!p) continue;
      if (p.x < minX || p.x > maxX) continue;
      if (p.y < minY || p.y > maxY) continue;
      if (p.z < minZ || p.z > maxZ) continue;
      out.push({ x: p.x, y: p.y, z: p.z, id });
    }

    return out;
  }

  /**
   * Builds a chunk snapshot (base + edits merged) for a given chunk origin.
   * Returns Uint16Array of size chunkSize^3 in X-major order (x -> y -> z).
   */
  public makeChunkSnapshot(
    chunkX: number,
    chunkY: number,
    chunkZ: number,
    chunkSize: number
  ): Uint16Array {
    chunkX |= 0;
    chunkY |= 0;
    chunkZ |= 0;
    chunkSize = Math.max(1, chunkSize | 0);

    const ox = chunkX * chunkSize;
    const oy = chunkY * chunkSize;
    const oz = chunkZ * chunkSize;

    const total = chunkSize * chunkSize * chunkSize;
    const arr = new Uint16Array(total);

    let ptr = 0;
    for (let x = 0; x < chunkSize; x++) {
      for (let y = 0; y < chunkSize; y++) {
        for (let z = 0; z < chunkSize; z++) {
          const wx = ox + x;
          const wy = oy + y;
          const wz = oz + z;
          arr[ptr++] = this.getBlock(wx, wy, wz) & 0xffff;
        }
      }
    }

    return arr;
  }

  /**
   * Encode a patch payload for the client. Keeps it plain JSON.
   * Provide an area; you get back only edits in that area.
   */
  public encodeEditsPatch(
    min: { x: number; y: number; z: number },
    max: { x: number; y: number; z: number },
    opts?: { limit?: number }
  ): { edits: WorldEdit[]; truncated: boolean } {
    const edits = this.getEditsInAABB(min, max);

    const limit = isFiniteNum(opts?.limit) ? Math.max(1, (opts!.limit as number) | 0) : 5000;

    if (edits.length > limit) {
      edits.length = limit;
      return { edits, truncated: true };
    }

    return { edits, truncated: false };
  }

  /**
   * Convenience: encode a patch around a point with radius (block units).
   */
  public encodePatchAround(
    center: { x: number; y: number; z: number },
    radius: number,
    opts?: { limit?: number }
  ): { edits: WorldEdit[]; truncated: boolean } {
    const r = Math.max(1, Math.floor(Number(radius) || 0));
    const min = { x: (center.x | 0) - r, y: (center.y | 0) - r, z: (center.z | 0) - r };
    const max = { x: (center.x | 0) + r, y: (center.y | 0) + r, z: (center.z | 0) + r };
    return this.encodeEditsPatch(min, max, opts);
  }

  // ==========================================================
  // Persistence helpers
  // ==========================================================

  /** Serialize world edits to a JSON-friendly structure. */
  public serialize(): SerializedWorld {
    return {
      version: 1,
      edits: this.getAllEdits(),
    };
  }

  /**
   * Apply serialized data.
   * - replace=true clears existing edits first.
   * - Any edit matching base will be dropped automatically.
   */
  public applySerialized(data: any, opts?: { replace?: boolean }) {
    const replace = !!opts?.replace;

    if (!data || typeof data !== "object") return;
    const ver = Number((data as any).version || 0);
    if (!Number.isFinite(ver) || ver < 1) return;

    const editsArr = (data as any).edits;
    if (!Array.isArray(editsArr)) return;

    if (replace) this.edits.clear();

    for (const e of editsArr) {
      const x = i32(e?.x, 0);
      const y = i32(e?.y, 0);
      const z = i32(e?.z, 0);
      const id = i32(e?.id, BLOCKS.AIR);

      // clamp coords to store bounds
      const sx = clamp(x, this.minCoord, this.maxCoord) | 0;
      const sy = clamp(y, this.minCoord, this.maxCoord) | 0;
      const sz = clamp(z, this.minCoord, this.maxCoord) | 0;

      // store as delta vs base
      const base = this.getBaseBlock(sx, sy, sz);
      const k = keyOf(sx, sy, sz);

      if (id === base) {
        this.edits.delete(k);
      } else {
        this.edits.set(k, id);
      }
    }

    this._dirty = false;
  }

  /** Ensure parent directory exists. */
  private ensureDirForFile(filePath: string) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  /** Save serialized world to disk (sync). */
  public saveToFileSync(filePath: string) {
    const fp = String(filePath || "").trim();
    if (!fp) throw new Error("saveToFileSync: invalid path");

    this.ensureDirForFile(fp);

    const data = this.serialize();
    const json = JSON.stringify(data);

    fs.writeFileSync(fp, json, "utf8");
    this._dirty = false;
    this._lastSaveAt = Date.now();
  }

  /** Load serialized world from disk (sync). */
  public loadFromFileSync(filePath: string, opts?: { replace?: boolean }) {
    const fp = String(filePath || "").trim();
    if (!fp) throw new Error("loadFromFileSync: invalid path");

    if (!fs.existsSync(fp)) return false;

    const raw = fs.readFileSync(fp, "utf8");
    const data = JSON.parse(raw);

    this.applySerialized(data, { replace: opts?.replace ?? true });
    return true;
  }

  /** Save serialized world to disk (async). */
  public async saveToFile(filePath: string) {
    const fp = String(filePath || "").trim();
    if (!fp) throw new Error("saveToFile: invalid path");

    this.ensureDirForFile(fp);

    const data = this.serialize();
    const json = JSON.stringify(data);

    await fs.promises.writeFile(fp, json, "utf8");
    this._dirty = false;
    this._lastSaveAt = Date.now();
  }

  /** Load serialized world from disk (async). */
  public async loadFromFile(filePath: string, opts?: { replace?: boolean }) {
    const fp = String(filePath || "").trim();
    if (!fp) throw new Error("loadFromFile: invalid path");

    try {
      const raw = await fs.promises.readFile(fp, "utf8");
      const data = JSON.parse(raw);
      this.applySerialized(data, { replace: opts?.replace ?? true });
      return true;
    } catch {
      return false;
    }
  }

  /** Whether edits have changed since last save. */
  public isDirty() {
    return !!this._dirty;
  }
}
