// ============================================================
// server/world/WorldStore.ts  (FULL REWRITE - EXPANDED BLOCKS)
// ============================================================
// Purpose:
// - Server-authoritative voxel world.
// - Deterministic base terrain (Bedrock, Stone, Dirt, Grass, Trees).
// - Stores ONLY edits (deltas) to save memory.
// - Full persistence support (JSON file I/O).
// - Expanded block palette for rarity/value progression (ores + gems).
//
// Notes:
// - This file ONLY defines IDs + world storage/patch/persistence.
// - Rarity/value is typically defined in a separate defs table,
//   but we include an optional helper map here (BLOCK_META) so you
//   can start using it immediately without new files.
// - Client must register matching IDs and colors for new blocks.
// ============================================================

import * as fs from "fs";
import * as path from "path";

export type BlockId = number;

// ------------------------------------------------------------
// Block Palette
// ------------------------------------------------------------

export const BLOCKS = {
  AIR: 0,

  // Terrain
  DIRT: 1,
  GRASS: 2,
  STONE: 3,
  BEDROCK: 4,

  // Trees
  LOG: 5,
  LEAVES: 6,

  // Crafted building
  PLANKS: 7,

  // Ores / valuables (progression)
  COAL_ORE: 8,
  COPPER_ORE: 9,
  IRON_ORE: 10,
  SILVER_ORE: 11,
  GOLD_ORE: 12,

  // Gems / fantasy
  RUBY_ORE: 13,
  SAPPHIRE_ORE: 14,
  MYTHRIL_ORE: 15,
  DRAGONSTONE: 16,

  // Convenience crafted blocks (optional; recipe can create these)
  CRAFTING_TABLE: 17,
  CHEST: 18,
  SLAB_PLANK: 19,
  STAIRS_PLANK: 20,
  DOOR_WOOD: 21,
} as const;

export type WorldEdit = { x: number; y: number; z: number; id: BlockId };

type SerializedWorld = {
  version: number;
  edits: WorldEdit[];
};

// ------------------------------------------------------------
// Optional: Simple Metadata (rarity/value) - server-side helpers
// ------------------------------------------------------------

export type Rarity = "common" | "uncommon" | "rare" | "epic" | "legendary";

export const BLOCK_META: Record<number, { kind: string; rarity: Rarity; value: number }> = {
  [BLOCKS.DIRT]: { kind: "block:dirt", rarity: "common", value: 1 },
  [BLOCKS.GRASS]: { kind: "block:grass", rarity: "common", value: 1 },
  [BLOCKS.STONE]: { kind: "block:stone", rarity: "common", value: 2 },
  [BLOCKS.BEDROCK]: { kind: "block:bedrock", rarity: "common", value: 0 },

  [BLOCKS.LOG]: { kind: "block:log", rarity: "common", value: 3 },
  [BLOCKS.LEAVES]: { kind: "block:leaves", rarity: "common", value: 1 },
  [BLOCKS.PLANKS]: { kind: "block:plank", rarity: "common", value: 2 },

  [BLOCKS.COAL_ORE]: { kind: "block:coal_ore", rarity: "common", value: 6 },
  [BLOCKS.COPPER_ORE]: { kind: "block:copper_ore", rarity: "common", value: 9 },

  [BLOCKS.IRON_ORE]: { kind: "block:iron_ore", rarity: "uncommon", value: 16 },
  [BLOCKS.SILVER_ORE]: { kind: "block:silver_ore", rarity: "uncommon", value: 22 },

  [BLOCKS.GOLD_ORE]: { kind: "block:gold_ore", rarity: "rare", value: 40 },

  [BLOCKS.RUBY_ORE]: { kind: "block:ruby_ore", rarity: "rare", value: 70 },
  [BLOCKS.SAPPHIRE_ORE]: { kind: "block:sapphire_ore", rarity: "rare", value: 70 },

  [BLOCKS.MYTHRIL_ORE]: { kind: "block:mythril_ore", rarity: "epic", value: 140 },
  [BLOCKS.DRAGONSTONE]: { kind: "block:dragonstone", rarity: "legendary", value: 300 },

  [BLOCKS.CRAFTING_TABLE]: { kind: "block:crafting_table", rarity: "common", value: 10 },
  [BLOCKS.CHEST]: { kind: "block:chest", rarity: "common", value: 12 },
  [BLOCKS.SLAB_PLANK]: { kind: "block:slab_plank", rarity: "common", value: 1 },
  [BLOCKS.STAIRS_PLANK]: { kind: "block:stairs_plank", rarity: "common", value: 2 },
  [BLOCKS.DOOR_WOOD]: { kind: "block:door_wood", rarity: "common", value: 3 },
};

// ------------------------------------------------------------
// Utils
// ------------------------------------------------------------

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

/** String key for Map storage "x|y|z" */
function keyOf(x: number, y: number, z: number) {
  return `${x}|${y}|${z}`;
}

/** Inverse key parser */
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

// ------------------------------------------------------------
// Deterministic Terrain Logic
// ------------------------------------------------------------

/** Simple pseudo-random hash for deterministic features (trees, ore clusters) */
function hash2(x: number, z: number) {
  let n = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  return n - Math.floor(n);
}

/** Another small hash including y for ore choice */
function hash3(x: number, y: number, z: number) {
  let n = Math.sin(x * 12.9898 + y * 0.123 + z * 78.233) * 43758.5453;
  return n - Math.floor(n);
}

/**
 * Deterministic base terrain function.
 * MUST match the Client's terrain generation logic for baseline terrain.
 *
 * IMPORTANT:
 * - We only add new ore/gem blocks in areas where base is STONE.
 * - If your client still generates only plain stone, that's okay:
 *   server sends edits for placed/broken blocks, but base mismatch can
 *   look different if you ALSO want ores in base terrain. If you want
 *   ores to exist naturally, you MUST mirror this logic client-side too.
 */
export function getBaseVoxelID(x: number, y: number, z: number): BlockId {
  // 1) Bedrock Floor
  if (y < -10) return BLOCKS.BEDROCK;

  // 2) Base Height
  const height = Math.floor(4 * Math.sin(x / 15) + 4 * Math.cos(z / 20));

  // 3) Trees (Deterministic)
  if (y > height && y < height + 8) {
    if (hash2(x, z) > 0.98) {
      const treeBaseY = height + 1;
      const trunkHeight = 4;

      // Trunk
      if (y >= treeBaseY && y < treeBaseY + trunkHeight) {
        return BLOCKS.LOG;
      }

      // Leaves (simple)
      const topY = treeBaseY + trunkHeight - 1;
      if (y >= topY - 1 && y <= topY + 2) {
        if (y > topY) return BLOCKS.LEAVES;
      }
    }
  }

  // 4) Standard Layers
  const deepStone = y < height - 3;
  const dirtLayer = y < height;
  const grassTop = y === height;

  if (deepStone) {
    // --- Ore / gem injection into stone (deterministic) ---
    // Keep it sparse and depth-weighted.

    // Coal: common, near surface down to deep
    const hCoal = hash3(x, y, z);
    if (hCoal > 0.995) return BLOCKS.COAL_ORE;

    // Copper: common-ish
    const hCopper = hash3(x + 11, y - 7, z + 3);
    if (hCopper > 0.996) return BLOCKS.COPPER_ORE;

    // Iron: uncommon, deeper bias
    if (y < height - 6) {
      const hIron = hash3(x - 17, y + 5, z + 19);
      if (hIron > 0.9972) return BLOCKS.IRON_ORE;
    }

    // Silver: uncommon, deeper
    if (y < height - 10) {
      const hSilver = hash3(x + 33, y - 9, z - 21);
      if (hSilver > 0.9978) return BLOCKS.SILVER_ORE;
    }

    // Gold: rare, deep
    if (y < height - 14) {
      const hGold = hash3(x - 41, y + 13, z + 7);
      if (hGold > 0.9983) return BLOCKS.GOLD_ORE;
    }

    // Ruby/Sapphire: rare, deep pockets
    if (y < height - 18) {
      const hGem = hash3(x + 77, y - 23, z + 55);
      if (hGem > 0.99875) return BLOCKS.RUBY_ORE;

      const hGem2 = hash3(x - 91, y + 29, z - 61);
      if (hGem2 > 0.99875) return BLOCKS.SAPPHIRE_ORE;
    }

    // Mythril: epic, very deep
    if (y < height - 26) {
      const hMythril = hash3(x + 123, y - 51, z - 99);
      if (hMythril > 0.9992) return BLOCKS.MYTHRIL_ORE;
    }

    // Dragonstone: legendary, extremely rare, deepest
    if (y < -2) {
      const hDragon = hash3(x - 211, y - 101, z + 177);
      if (hDragon > 0.9996) return BLOCKS.DRAGONSTONE;
    }

    return BLOCKS.STONE;
  }

  if (dirtLayer) return BLOCKS.DIRT;
  if (grassTop) return BLOCKS.GRASS;

  return BLOCKS.AIR;
}

// ------------------------------------------------------------
// WorldStore Class
// ------------------------------------------------------------

export class WorldStore {
  private edits: Map<string, BlockId>;

  public readonly minCoord: number;
  public readonly maxCoord: number;

  // Persistence State
  private _dirty: boolean = false;
  private _lastSaveAt: number = 0;
  private _autosavePath: string | null = null;
  private _autosaveMinIntervalMs: number = 2500;

  constructor(opts?: {
    minCoord?: number;
    maxCoord?: number;
    seed?: number;
    autosavePath?: string;
    autosaveMinIntervalMs?: number;
  }) {
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
  public maybeAutosave() {
    if (!this._autosavePath) return;
    const now = Date.now();
    if (!this._dirty) return;
    if (now - this._lastSaveAt < this._autosaveMinIntervalMs) return;

    try {
      this.saveToFileSync(this._autosavePath);
      this._lastSaveAt = now;
      this._dirty = false;
    } catch (e) {
      console.error("[WORLD] Autosave failed:", e);
    }
  }

  /** Clamp coords into safe range for sanity */
  public sanitizeCoord(n: any) {
    const v = i32(n, 0);
    return clamp(v, this.minCoord, this.maxCoord) | 0;
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
  public makeChunkSnapshot(chunkX: number, chunkY: number, chunkZ: number, chunkSize: number): Uint16Array {
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

      const sx = clamp(x, this.minCoord, this.maxCoord) | 0;
      const sy = clamp(y, this.minCoord, this.maxCoord) | 0;
      const sz = clamp(z, this.minCoord, this.maxCoord) | 0;

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
