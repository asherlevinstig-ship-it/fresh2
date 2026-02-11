// ============================================================
// src/world/WorldStore.ts  (FULL REWRITE - NO OMITS - NO BREVITY)
// ------------------------------------------------------------
// The Source of Truth for the Voxel World
//
// FEATURES
// - Stores player edits (sparse map) to save memory.
// - Generates terrain procedurally via a generator callback.
// - Handles persistence (load/save JSON) with atomic writes (cross-platform safe).
// - Generates network patches.
//   - encodeEditsAround(): sends ONLY edits (best for client-side procedural worlds)
//   - encodePatchAround(): legacy full scan of non-air blocks (bandwidth heavy)
//
// FIXES / GUARANTEES
// - ATOMIC SAVE: Uses rename/copy fallback for Windows compatibility.
// - VALIDATION: Loads only valid [string, number] entries.
// - SAFE KEYS: Uses Math.floor() instead of bitwise |0 to prevent overflow.
// - BOUNDS: Enforces minCoord/maxCoord on reads/writes (X/Z soft bounds).
// - DIRTY CHECK: Only flags dirty if block ID actually changes.
// - PATCH: Adds edits-only patch encoding to avoid "town invisible" due to scan limits.
// ============================================================

import * as fs from "fs";
import * as path from "path";

// ------------------------------------------------------------
// Block ID Palette
// ------------------------------------------------------------
// This must match IDs expected by the client and MyRoom.ts.

export type BlockId = number;

export const BLOCKS = {
  AIR: 0,
  DIRT: 1,
  GRASS: 2,
  STONE: 3,
  BEDROCK: 4,
  LOG: 5,
  LEAVES: 6,
  PLANKS: 7,

  // Terrain / Biome Specific
  SAND: 8,
  SNOW: 9,
  CLAY: 10,
  GRAVEL: 11,
  MUD: 12,
  ICE: 13,

  // Ores
  COAL_ORE: 14,
  COPPER_ORE: 15,
  IRON_ORE: 16,
  SILVER_ORE: 17,
  GOLD_ORE: 18,
  RUBY_ORE: 19,
  SAPPHIRE_ORE: 20,
  MYTHRIL_ORE: 21,
  DRAGONSTONE: 22,

  // Buildables / Interactables (Synced with Client)
  CRAFTING_TABLE: 30,
  CHEST: 31,
  SLAB_PLANK: 32,
  STAIRS_PLANK: 33,
  DOOR_WOOD: 34,

  // Utility / Fallbacks
  WATER: 90,
  LAVA: 91,
} as const;

// ------------------------------------------------------------
// Types & Config
// ------------------------------------------------------------

/**
 * A function that determines the natural block at (x, y, z).
 * Used to generate terrain on the fly if no player edit exists.
 */
export type WorldGenerator = (x: number, y: number, z: number) => number;

export interface WorldStoreConfig {
  minCoord?: number;
  maxCoord?: number;
  generator?: WorldGenerator;
}

export interface AutosaveConfig {
  path: string;
  minIntervalMs: number;
}

// ------------------------------------------------------------
// WorldStore Class
// ------------------------------------------------------------

export class WorldStore {
  // Sparse map of player edits.
  // Key: "x,y,z" (string)
  // Value: BlockId (number)
  // We only store blocks that differ from the procedural generator.
  private edits = new Map<string, number>();

  // The procedural generation logic (injected from Biomes.ts via MyRoom)
  private generator: WorldGenerator | null = null;

  // World boundaries (soft limits) enforced on X/Z reads/writes
  private minCoord: number;
  private maxCoord: number;

  // Persistence state
  private dirty = false;
  private lastAutosave = 0;
  private autosaveConfig: AutosaveConfig | null = null;

  constructor(cfg?: WorldStoreConfig) {
    this.minCoord = cfg?.minCoord ?? -100000;
    this.maxCoord = cfg?.maxCoord ?? 100000;
    this.generator = cfg?.generator ?? null;
  }

  // ----------------------------------------------------------
  // Internal Helpers
  // ----------------------------------------------------------

  // FIX: Use Math.floor to avoid 32-bit overflow with bitwise operators
  private key(x: number, y: number, z: number): string {
    return `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`;
  }

  private inXZBounds(x: number, z: number): boolean {
    return !(x < this.minCoord || x > this.maxCoord || z < this.minCoord || z > this.maxCoord);
  }

  // ----------------------------------------------------------
  // Core Accessors
  // ----------------------------------------------------------

  /**
   * Retrieves the block ID at a specific coordinate.
   * Logic:
   * 1. Check if a player has modified this block (Edits Map).
   * 2. If not, ask the procedural generator.
   * 3. If no generator, default to AIR.
   */
  public getBlock(x: number, y: number, z: number): number {
    // Bounds Check (Read) - X/Z only (soft bounds)
    if (!this.inXZBounds(x, z)) return BLOCKS.AIR;

    // 1. Check player edits
    const k = this.key(x, y, z);
    const edit = this.edits.get(k);
    if (edit !== undefined) return edit;

    // 2. Check procedural generator
    if (this.generator) return this.generator(x, y, z);

    // 3. Default
    return BLOCKS.AIR;
  }

  /**
   * Sets a block at a specific coordinate (Player Action / Stamp).
   * Logic:
   * 1. If the new ID matches the procedural generator's output, remove the edit (revert to nature).
   * 2. Otherwise, store the new ID in the edits map.
   */
  public setBlock(x: number, y: number, z: number, id: number): void {
    // Bounds Check (Write) - X/Z only (soft bounds)
    if (!this.inXZBounds(x, z)) return;

    const k = this.key(x, y, z);
    const currentId = this.getBlock(x, y, z);

    // Dirty Flag Optimization: no-op if unchanged
    if (currentId === id) return;

    // Optimization: Don't store edits that match the natural world
    if (this.generator) {
      const naturalId = this.generator(x, y, z);
      if (naturalId === id) {
        if (this.edits.has(k)) {
          this.edits.delete(k);
          this.dirty = true;
        }
        return;
      }
    }

    // Store the edit
    this.edits.set(k, id);
    this.dirty = true;
  }

  // ----------------------------------------------------------
  // Room Operations (Helpers for MyRoom.ts)
  // ----------------------------------------------------------

  public applyBreak(x: number, y: number, z: number) {
    this.setBlock(x, y, z, BLOCKS.AIR);
    return { newId: BLOCKS.AIR };
  }

  public applyPlace(x: number, y: number, z: number, id: number) {
    this.setBlock(x, y, z, id);
    return { newId: id };
  }

  // ----------------------------------------------------------
  // Network Patching (Preferred: Edits-Only)
  // ----------------------------------------------------------
  //
  // Why edits-only?
  // - If your client is procedural (noa-engine worldDataNeeded), you do NOT want
  //   to send "all non-air blocks" from server. Underground stone dominates and
  //   hits payload limits before stamped structures (town) are included.
  // - Instead, send ONLY the edits (stamps + player edits) and let the client
  //   generate the baseline terrain locally.
  //
  // Patch Format (flat array):
  // data = [x, y, z, id, x, y, z, id, ...]
  // ----------------------------------------------------------

  /**
   * Encodes ONLY stored edits inside a cubic radius around center.
   * This is the correct patch function for procedural clients.
   */
  public encodeEditsAround(
    center: { x: number; y: number; z: number },
    radius: number,
    opts?: { limit?: number }
  ) {
    const limit = opts?.limit ?? 200000;

    const cx = Math.floor(center.x);
    const cy = Math.floor(center.y);
    const cz = Math.floor(center.z);
    const r = Math.floor(radius);

    const minX = cx - r;
    const maxX = cx + r;
    const minY = cy - r;
    const maxY = cy + r;
    const minZ = cz - r;
    const maxZ = cz + r;

    const data: number[] = [];
    let count = 0;

    for (const [key, id] of this.edits.entries()) {
      // key format: "x,y,z"
      const parts = key.split(",");
      if (parts.length !== 3) continue;

      const x = Number(parts[0]);
      const y = Number(parts[1]);
      const z = Number(parts[2]);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;

      if (x < minX || x > maxX) continue;
      if (y < minY || y > maxY) continue;
      if (z < minZ || z > maxZ) continue;

      data.push(x, y, z, id);
      count++;
      if (count >= limit) break;
    }

    return {
      cx: center.x,
      cy: center.y,
      cz: center.z,
      r: radius,
      data,
      count,
      mode: "edits" as const,
    };
  }

  // ----------------------------------------------------------
  // Network Patching (Legacy: Full Scan of Non-Air)
  // ----------------------------------------------------------
  //
  // WARNING:
  // - This scans every voxel and sends every non-air block.
  // - In normal terrain this is overwhelmingly underground stone/dirt.
  // - Greatly increases CPU and bandwidth.
  // - Will frequently prevent structures (town) from arriving if limit is low,
  //   because underground fills the payload first.
  //
  // Keep only if you need a debugging fallback.
  // ----------------------------------------------------------

  /**
   * Scans a cubic volume around a center point and returns all non-AIR blocks.
   * Returns a flat array patch format { data: number[] }
   * where data = [x, y, z, id, x, y, z, id...]
   */
  public encodePatchAround(
    center: { x: number; y: number; z: number },
    radius: number,
    opts?: { limit?: number }
  ) {
    const limit = opts?.limit ?? 50000;

    const blocks: number[] = [];

    const startX = Math.floor(center.x - radius);
    const endX = Math.floor(center.x + radius);

    // Limit Y scan to reasonable world height to avoid wasting cycles on void/sky
    const startY = Math.max(-64, Math.floor(center.y - radius));
    const endY = Math.min(320, Math.floor(center.y + radius));

    const startZ = Math.floor(center.z - radius);
    const endZ = Math.floor(center.z + radius);

    let count = 0;

    for (let x = startX; x <= endX; x++) {
      for (let z = startZ; z <= endZ; z++) {
        for (let y = startY; y <= endY; y++) {
          const id = this.getBlock(x, y, z);

          // Only send solid blocks to save bandwidth (still massive underground)
          if (id !== BLOCKS.AIR) {
            blocks.push(x, y, z, id);
            count++;
            if (count >= limit) break;
          }
        }
        if (count >= limit) break;
      }
      if (count >= limit) break;
    }

    return {
      cx: center.x,
      cy: center.y,
      cz: center.z,
      r: radius,
      data: blocks,
      count,
      mode: "scan" as const,
    };
  }

  // ----------------------------------------------------------
  // Persistence (Load / Save)
  // ----------------------------------------------------------

  public editsCount(): number {
    return this.edits.size;
  }

  public isDirty(): boolean {
    return this.dirty;
  }

  /**
   * Loads world edits from a JSON file.
   * Expects format: { version: number, timestamp: number, edits: [[key, val], ...] }
   * Validation:
   * - entry must be [string, number]
   * - key is kept as-is (assumes "x,y,z" from this.key)
   * - val must be finite number
   */
  public loadFromFileSync(filePath: string): boolean {
    if (!fs.existsSync(filePath)) return false;

    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const data = JSON.parse(raw);

      if (Array.isArray(data.edits)) {
        this.edits.clear();
        let loadedCount = 0;

        for (const entry of data.edits) {
          if (Array.isArray(entry) && entry.length === 2) {
            const [key, val] = entry;
            if (typeof key === "string" && typeof val === "number" && Number.isFinite(val)) {
              this.edits.set(key, val);
              loadedCount++;
            }
          }
        }

        console.log(`[WorldStore] Validated & Loaded ${loadedCount} edits.`);
        this.dirty = false;
        return true;
      }

      return false;
    } catch (e) {
      console.error(`[WorldStore] Load failed for ${filePath}:`, e);
      return false;
    }
  }

  /**
   * Saves world edits to a JSON file safely (atomic write).
   * Cross-platform atomic save using rename with copy fallback.
   */
  public saveToFileSync(filePath: string): void {
    try {
      const data = {
        version: 1,
        timestamp: Date.now(),
        edits: Array.from(this.edits.entries()),
      };

      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // Write to a temp file first
      const tmp = `${filePath}.tmp.${Date.now()}`;
      fs.writeFileSync(tmp, JSON.stringify(data));

      // Atomic Rename (try-catch for Windows EXDEV or EPERM issues)
      try {
        fs.renameSync(tmp, filePath);
      } catch {
        fs.copyFileSync(tmp, filePath);
        fs.unlinkSync(tmp);
      }

      this.dirty = false;
    } catch (e) {
      console.error(`[WorldStore] Save failed for ${filePath}:`, e);
    }
  }

  // ----------------------------------------------------------
  // Autosave Logic
  // ----------------------------------------------------------

  public configureAutosave(cfg: AutosaveConfig) {
    this.autosaveConfig = cfg;
  }

  public maybeAutosave() {
    if (!this.autosaveConfig || !this.dirty) return;

    const now = Date.now();
    if (now - this.lastAutosave > this.autosaveConfig.minIntervalMs) {
      console.log(`[WorldStore] Autosaving ${this.edits.size} edits...`);
      this.saveToFileSync(this.autosaveConfig.path);
      this.lastAutosave = now;
    }
  }
}
