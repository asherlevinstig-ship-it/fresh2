// ============================================================
// rooms/world/WorldStore.ts  (FULL REWRITE - NO OMITS)
// ------------------------------------------------------------
// Purpose:
// - Server-authoritative voxel world storage for a Minecraft-like game
// - Uses a procedural base terrain (deterministic) + sparse override map
// - Only stores edited voxels (including air removals), not whole chunks
//
// Key ideas:
// - get(x,y,z): returns override if present, else base terrain voxel id
// - set(x,y,z,id): writes override, but drops it if it matches base terrain
//   (keeps the sparse map small)
// - Optional helpers for batching edits and chunk snapshots (lightweight)
//
// IMPORTANT:
// - Block IDs MUST match client registry.
//   Your client registers:
//     registerBlock(1) dirt
//     registerBlock(2) grass
//   So this store uses:
//     0 = air, 1 = dirt, 2 = grass
// ============================================================

export type Vec3i = { x: number; y: number; z: number };

export const BLOCK = {
  AIR: 0,
  DIRT: 1,
  GRASS: 2,
} as const;

export type BlockId = (typeof BLOCK)[keyof typeof BLOCK];

export type BlockUpdate = { x: number; y: number; z: number; id: number };

// ------------------------------------------------------------
// utils
// ------------------------------------------------------------

function key3(x: number, y: number, z: number) {
  return `${x | 0},${y | 0},${z | 0}`;
}

function parseKey(k: string): Vec3i | null {
  // expects "x,y,z"
  const parts = k.split(",");
  if (parts.length !== 3) return null;
  const x = Number(parts[0]);
  const y = Number(parts[1]);
  const z = Number(parts[2]);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return { x: x | 0, y: y | 0, z: z | 0 };
}

function i32(n: any, fallback = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? (v | 0) : fallback;
}

function clampI32(n: number, a: number, b: number) {
  return Math.max(a | 0, Math.min(b | 0, n | 0)) | 0;
}

// ------------------------------------------------------------
// base terrain (matches your client getVoxelID)
// ------------------------------------------------------------

export function getBaseVoxelID(x: number, y: number, z: number): number {
  // Mirror your client exactly:
  // const height = 2 * Math.sin(x / 10) + 3 * Math.cos(z / 20);
  // if (y < height - 1) return dirt;
  // if (y < height) return grass;
  // return 0;
  const height = 2 * Math.sin(x / 10) + 3 * Math.cos(z / 20);
  if (y < height - 1) return BLOCK.DIRT;
  if (y < height) return BLOCK.GRASS;
  return BLOCK.AIR;
}

// ------------------------------------------------------------
// WorldStore
// ------------------------------------------------------------

export class WorldStore {
  /**
   * Sparse overrides: only stores voxels that differ from base terrain.
   * Keyed by "x,y,z" -> blockId
   */
  private overrides = new Map<string, number>();

  /**
   * Optional bounds guard (helps keep accidental spam from blowing memory).
   * You can disable by setting min/max extremely wide.
   */
  public bounds = {
    minX: -100000,
    maxX: 100000,
    minY: -100000,
    maxY: 100000,
    minZ: -100000,
    maxZ: 100000,
  };

  constructor(init?: { bounds?: Partial<WorldStore["bounds"]> }) {
    if (init?.bounds) {
      this.bounds = { ...this.bounds, ...init.bounds };
    }
  }

  // ----------------------------------------------------------
  // validation
  // ----------------------------------------------------------

  public inBounds(x: number, y: number, z: number) {
    const b = this.bounds;
    return (
      x >= b.minX &&
      x <= b.maxX &&
      y >= b.minY &&
      y <= b.maxY &&
      z >= b.minZ &&
      z <= b.maxZ
    );
  }

  public normalizeCoord(x: any, y: any, z: any): Vec3i | null {
    const ix = i32(x, NaN as any);
    const iy = i32(y, NaN as any);
    const iz = i32(z, NaN as any);
    if (!Number.isFinite(ix) || !Number.isFinite(iy) || !Number.isFinite(iz)) return null;

    // clamp to bounds so callers can safely trust it
    const cx = clampI32(ix, this.bounds.minX, this.bounds.maxX);
    const cy = clampI32(iy, this.bounds.minY, this.bounds.maxY);
    const cz = clampI32(iz, this.bounds.minZ, this.bounds.maxZ);

    return { x: cx, y: cy, z: cz };
  }

  // ----------------------------------------------------------
  // core API
  // ----------------------------------------------------------

  /** Get block id at world coordinate */
  public get(x: number, y: number, z: number): number {
    if (!this.inBounds(x, y, z)) return BLOCK.AIR;

    const k = key3(x, y, z);
    if (this.overrides.has(k)) return this.overrides.get(k)!;

    return getBaseVoxelID(x | 0, y | 0, z | 0);
  }

  /**
   * Set block id at world coordinate.
   * Stores only if it differs from base terrain at that coordinate.
   */
  public set(x: number, y: number, z: number, id: number): void {
    if (!this.inBounds(x, y, z)) return;

    const ix = x | 0;
    const iy = y | 0;
    const iz = z | 0;

    const k = key3(ix, iy, iz);
    const base = getBaseVoxelID(ix, iy, iz);
    const nid = id | 0;

    if (nid === base) {
      this.overrides.delete(k);
    } else {
      this.overrides.set(k, nid);
    }
  }

  /** Remove any override at a coordinate (reverts to base terrain) */
  public clearOverride(x: number, y: number, z: number): void {
    if (!this.inBounds(x, y, z)) return;
    this.overrides.delete(key3(x | 0, y | 0, z | 0));
  }

  /** Check if a coordinate has an override stored */
  public hasOverride(x: number, y: number, z: number): boolean {
    if (!this.inBounds(x, y, z)) return false;
    return this.overrides.has(key3(x | 0, y | 0, z | 0));
  }

  /** Number of overrides stored (useful for debugging/memory tracking) */
  public overrideCount(): number {
    return this.overrides.size;
  }

  /** Clear ALL overrides (resets world back to base terrain) */
  public resetAllOverrides(): void {
    this.overrides.clear();
  }

  // ----------------------------------------------------------
  // batch helpers
  // ----------------------------------------------------------

  /**
   * Apply a list of updates. Returns number applied.
   * (Does not validate block ids - do that outside if needed.)
   */
  public applyUpdates(updates: BlockUpdate[]): number {
    if (!Array.isArray(updates)) return 0;
    let n = 0;
    for (const u of updates) {
      if (!u) continue;
      const x = u.x | 0;
      const y = u.y | 0;
      const z = u.z | 0;
      const id = u.id | 0;
      if (!this.inBounds(x, y, z)) continue;
      this.set(x, y, z, id);
      n++;
    }
    return n;
  }

  /**
   * Enumerate overrides within an AABB region (inclusive).
   * Useful for debugging or generating partial snapshots.
   */
  public getOverridesInRegion(
    minX: number,
    minY: number,
    minZ: number,
    maxX: number,
    maxY: number,
    maxZ: number
  ): BlockUpdate[] {
    const out: BlockUpdate[] = [];

    const a = {
      minX: clampI32(minX | 0, this.bounds.minX, this.bounds.maxX),
      minY: clampI32(minY | 0, this.bounds.minY, this.bounds.maxY),
      minZ: clampI32(minZ | 0, this.bounds.minZ, this.bounds.maxZ),
      maxX: clampI32(maxX | 0, this.bounds.minX, this.bounds.maxX),
      maxY: clampI32(maxY | 0, this.bounds.minY, this.bounds.maxY),
      maxZ: clampI32(maxZ | 0, this.bounds.minZ, this.bounds.maxZ),
    };

    // swap if needed
    if (a.maxX < a.minX) [a.minX, a.maxX] = [a.maxX, a.minX];
    if (a.maxY < a.minY) [a.minY, a.maxY] = [a.maxY, a.minY];
    if (a.maxZ < a.minZ) [a.minZ, a.maxZ] = [a.maxZ, a.minZ];

    for (const [k, id] of this.overrides.entries()) {
      const v = parseKey(k);
      if (!v) continue;

      if (
        v.x >= a.minX &&
        v.x <= a.maxX &&
        v.y >= a.minY &&
        v.y <= a.maxY &&
        v.z >= a.minZ &&
        v.z <= a.maxZ
      ) {
        out.push({ x: v.x, y: v.y, z: v.z, id: id | 0 });
      }
    }

    return out;
  }

  // ----------------------------------------------------------
  // chunk snapshot helpers (optional, simple)
  // ----------------------------------------------------------
  //
  // This creates an uncompressed Uint8Array snapshot for a chunk region.
  // You can send this via Colyseus as ArrayBuffer.
  //
  // Layout: X-major, then Y, then Z:
  // idx = ((x * sy) + y) * sz + z
  //
  // This is "good enough" to start; later you can:
  // - compress (RLE, LZ4, etc)
  // - store palettes (small block ids)
  // - use chunk deltas
  //

  public makeChunkSnapshot(
    chunkX: number,
    chunkY: number,
    chunkZ: number,
    sizeX = 32,
    sizeY = 32,
    sizeZ = 32
  ): Uint8Array {
    const sx = Math.max(1, sizeX | 0);
    const sy = Math.max(1, sizeY | 0);
    const sz = Math.max(1, sizeZ | 0);

    const out = new Uint8Array(sx * sy * sz);

    const baseX = (chunkX | 0) * sx;
    const baseY = (chunkY | 0) * sy;
    const baseZ = (chunkZ | 0) * sz;

    let idx = 0;
    for (let x = 0; x < sx; x++) {
      for (let y = 0; y < sy; y++) {
        for (let z = 0; z < sz; z++) {
          const wx = baseX + x;
          const wy = baseY + y;
          const wz = baseZ + z;
          out[idx++] = this.get(wx, wy, wz) & 0xff;
        }
      }
    }

    return out;
  }

  /**
   * Convert a snapshot back into world edits (writes into overrides).
   * This is mostly useful for loading/saving or debugging tools.
   */
  public applyChunkSnapshot(
    chunkX: number,
    chunkY: number,
    chunkZ: number,
    data: Uint8Array,
    sizeX = 32,
    sizeY = 32,
    sizeZ = 32
  ): number {
    const sx = Math.max(1, sizeX | 0);
    const sy = Math.max(1, sizeY | 0);
    const sz = Math.max(1, sizeZ | 0);

    if (!data || data.length !== sx * sy * sz) return 0;

    const baseX = (chunkX | 0) * sx;
    const baseY = (chunkY | 0) * sy;
    const baseZ = (chunkZ | 0) * sz;

    let idx = 0;
    let applied = 0;

    for (let x = 0; x < sx; x++) {
      for (let y = 0; y < sy; y++) {
        for (let z = 0; z < sz; z++) {
          const wx = baseX + x;
          const wy = baseY + y;
          const wz = baseZ + z;
          const id = data[idx++] | 0;

          if (!this.inBounds(wx, wy, wz)) continue;
          this.set(wx, wy, wz, id);
          applied++;
        }
      }
    }

    return applied;
  }

  // ----------------------------------------------------------
  // simple persistence (optional)
  // ----------------------------------------------------------
  //
  // This serializes ONLY overrides, not the whole world.
  // Great for saving "player-built world" on top of procedural terrain.
  //

  public serializeOverrides(): string {
    // JSON: { "x,y,z": id, ... }
    const obj: Record<string, number> = {};
    for (const [k, v] of this.overrides.entries()) obj[k] = v | 0;
    return JSON.stringify(obj);
  }

  public loadOverrides(serialized: string): number {
    if (typeof serialized !== "string" || !serialized.trim()) return 0;

    let parsed: any;
    try {
      parsed = JSON.parse(serialized);
    } catch {
      return 0;
    }
    if (!parsed || typeof parsed !== "object") return 0;

    let n = 0;
    for (const k of Object.keys(parsed)) {
      const v = parsed[k];
      const xyz = parseKey(k);
      if (!xyz) continue;
      const id = i32(v, NaN as any);
      if (!Number.isFinite(id)) continue;
      if (!this.inBounds(xyz.x, xyz.y, xyz.z)) continue;

      // store as override (set() will drop if equals base)
      this.set(xyz.x, xyz.y, xyz.z, id);
      n++;
    }
    return n;
  }
}
