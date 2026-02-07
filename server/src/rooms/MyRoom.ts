// ============================================================
// rooms/MyRoom.ts  (FULL REWRITE - NO OMITS, ALL LOGIC INCLUDED)
// ------------------------------------------------------------
// Includes:
// - Typed room state (MyRoomState)
// - Player join/leave
// - Move replication + sanity clamps
// - Stamina regen/drain (server authoritative) + sprint toggle
// - Swing (stamina cost + timed swinging flag)
// - Hotbar selection (0..8) (server authoritative)
// - Inventory + equipment slot moves (drag/drop), stacking, split
//
// - SERVER-AUTHORITATIVE WORLD (WorldStore persistence)
//   - Base terrain deterministic (client matches)
//   - Stores edits only (placed/broken blocks) and persists them
//   - On join: send world:patch around spawn/player
//   - On change: send block:update {x,y,z,id} to subscribed clients
//
// - Secure server break/place (reach + rate limit + inventory checks)
//   - block:break {x,y,z}
//   - block:place {x,y,z,kind}
//   - server validates reach + target conditions + inventory
//   - server applies to WorldStore then sends block:update
//   - server sends block:reject with reason (for UI console)
//
// - Chunk subscriptions (performance/scaling)
//   - chunk:sub {cx,cz}   (chunk coord in XZ)
//   - chunk:unsub {cx,cz}
//   - server tracks per-client subscriptions
//   - server sends world:patch for that chunk when subscribing
//   - server only sends block:update to clients subscribed to that chunk
//
// - Mining progress + tool durability (game feel)
//   - mine:start {x,y,z}  (client holds mouse down)
//   - mine:stop {}
//   - server advances mining progress in simulation tick
//   - break occurs when progress >= 1 and still valid
//   - tool durability decreases on successful break
//   - mine:progress {x,y,z,p} sent to miner client (optional UI)
//
// Notes:
// - Requires WorldStore at: server/world/WorldStore.ts (your rewritten one)
// - Block IDs MUST match client registry: 0 air, 1 dirt, 2 grass
// ============================================================

import { Room, Client, CloseCode } from "colyseus";
import { MyRoomState, PlayerState, ItemState } from "./schema/MyRoomState.js";
import { WorldStore, BLOCKS } from "./world/WorldStore.js";

type JoinOptions = { name?: string };

type MoveMsg = {
  x: number;
  y: number;
  z: number;
  yaw?: number;
  pitch?: number;
  viewMode?: number;
};

type SprintMsg = { on: boolean };
type SwingMsg = { t?: number };
type HotbarSetMsg = { index: number };

type InvMoveMsg = { from: string; to: string };
type InvSplitMsg = { slot: string };

type ChunkSubMsg = { cx: number; cz: number };
type BlockBreakMsg = { x: number; y: number; z: number };
type BlockPlaceMsg = { x: number; y: number; z: number; kind: string };
type MineStartMsg = { x: number; y: number; z: number };
type MineStopMsg = {};

// ------------------------------------------------------------
// utils
// ------------------------------------------------------------

function isFiniteNum(n: any): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

function nowMs() {
  return Date.now();
}

function i32(n: any, fallback = 0) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return v | 0;
}

function distSq(ax: number, ay: number, az: number, bx: number, by: number, bz: number) {
  const dx = ax - bx;
  const dy = ay - by;
  const dz = az - bz;
  return dx * dx + dy * dy + dz * dz;
}

function chunkKey(cx: number, cz: number) {
  return `${cx | 0}|${cz | 0}`;
}

function chunkOfWorldXZ(x: number, z: number, chunkSize: number) {
  const cx = Math.floor((x | 0) / chunkSize);
  const cz = Math.floor((z | 0) / chunkSize);
  return { cx, cz };
}

function aabbForChunkXZ(cx: number, cz: number, chunkSize: number) {
  const ox = (cx | 0) * chunkSize;
  const oz = (cz | 0) * chunkSize;
  return {
    min: { x: ox, y: -100000, z: oz },
    max: { x: ox + chunkSize - 1, y: 100000, z: oz + chunkSize - 1 },
  };
}

// ------------------------------------------------------------
// slots + inventory
// ------------------------------------------------------------

type EquipKey = "head" | "chest" | "legs" | "feet" | "tool" | "offhand";

type SlotRef =
  | { kind: "inv"; index: number }
  | { kind: "eq"; key: EquipKey };

function parseSlotRef(s: any): SlotRef | null {
  if (typeof s !== "string") return null;

  if (s.startsWith("inv:")) {
    const idx = Number(s.slice(4));
    if (!Number.isInteger(idx) || idx < 0) return null;
    return { kind: "inv", index: idx };
  }

  if (s.startsWith("eq:")) {
    const key = s.slice(3) as EquipKey;
    const allowed = new Set<EquipKey>(["head", "chest", "legs", "feet", "tool", "offhand"]);
    if (!allowed.has(key)) return null;
    return { kind: "eq", key };
  }

  return null;
}

function getTotalSlots(p: PlayerState) {
  const cols = isFiniteNum(p.inventory?.cols) ? p.inventory.cols : 9;
  const rows = isFiniteNum(p.inventory?.rows) ? p.inventory.rows : 4;
  return Math.max(1, cols * rows);
}

function ensureSlotsLength(p: PlayerState) {
  const total = getTotalSlots(p);
  while (p.inventory.slots.length < total) p.inventory.slots.push("");
  while (p.inventory.slots.length > total) p.inventory.slots.pop();
}

function getSlotUid(p: PlayerState, slot: SlotRef): string {
  if (slot.kind === "inv") {
    ensureSlotsLength(p);
    const total = getTotalSlots(p);
    if (slot.index < 0 || slot.index >= total) return "";
    return String(p.inventory.slots[slot.index] || "");
  } else {
    return String((p.equip as any)[slot.key] || "");
  }
}

function setSlotUid(p: PlayerState, slot: SlotRef, uid: string) {
  uid = uid ? String(uid) : "";
  if (slot.kind === "inv") {
    ensureSlotsLength(p);
    const total = getTotalSlots(p);
    if (slot.index < 0 || slot.index >= total) return;
    p.inventory.slots[slot.index] = uid;
  } else {
    (p.equip as any)[slot.key] = uid;
  }
}

// ------------------------------------------------------------
// item rules
// ------------------------------------------------------------

function isEquipSlotCompatible(slotKey: EquipKey, itemKind: string) {
  if (!itemKind) return true;
  const k = itemKind.toLowerCase();

  if (slotKey === "tool") {
    return k.startsWith("tool:") || k.includes("pickaxe") || k.includes("axe") || k.includes("sword");
  }
  if (slotKey === "offhand") return true;

  if (slotKey === "head") return k.includes("armor:head") || k.includes("helmet");
  if (slotKey === "chest") return k.includes("armor:chest") || k.includes("chestplate");
  if (slotKey === "legs") return k.includes("armor:legs") || k.includes("leggings");
  if (slotKey === "feet") return k.includes("armor:feet") || k.includes("boots");

  return true;
}

function maxStackForKind(kind: string) {
  const k = (kind || "").toLowerCase();
  if (!k) return 64;
  if (k.startsWith("tool:") || k.includes("pickaxe") || k.includes("axe") || k.includes("sword")) return 1;
  return 64;
}

function isBlockKind(kind: string) {
  return typeof kind === "string" && kind.startsWith("block:");
}

function kindToBlockId(kind: string) {
  if (kind === "block:dirt") return BLOCKS.DIRT;
  if (kind === "block:grass") return BLOCKS.GRASS;
  return BLOCKS.AIR;
}

function blockIdToKind(id: number) {
  if (id === BLOCKS.DIRT) return "block:dirt";
  if (id === BLOCKS.GRASS) return "block:grass";
  return "";
}

function isToolKind(kind: string) {
  const k = (kind || "").toLowerCase();
  return k.startsWith("tool:") || k.includes("pickaxe") || k.includes("axe") || k.includes("sword");
}

// ------------------------------------------------------------
// hotbar + equip sync
// ------------------------------------------------------------

function normalizeHotbarIndex(i: any) {
  const n = Number(i);
  if (!Number.isFinite(n)) return 0;
  return clamp(Math.floor(n), 0, 8);
}

function syncEquipToolToHotbar(p: PlayerState) {
  ensureSlotsLength(p);

  const idx = normalizeHotbarIndex(p.hotbarIndex);
  const uid = String(p.inventory.slots[idx] || "");
  if (!uid) {
    p.equip.tool = "";
    return;
  }

  const it = p.items.get(uid);
  if (!it) {
    p.equip.tool = "";
    return;
  }

  if (!isEquipSlotCompatible("tool", String(it.kind || ""))) {
    p.equip.tool = "";
    return;
  }

  p.equip.tool = uid;
}

// ------------------------------------------------------------
// inventory add/consume helpers
// ------------------------------------------------------------

function makeUid(sessionId: string, tag: string) {
  return `${sessionId}:${tag}:${nowMs()}:${Math.floor(Math.random() * 1e9)}`;
}

function firstEmptyInvIndex(p: PlayerState) {
  ensureSlotsLength(p);
  for (let i = 0; i < p.inventory.slots.length; i++) {
    if (!String(p.inventory.slots[i] || "")) return i;
  }
  return -1;
}

function findStackableUid(p: PlayerState, kind: string) {
  ensureSlotsLength(p);

  const maxStack = maxStackForKind(kind);
  if (maxStack <= 1) return "";

  for (let i = 0; i < p.inventory.slots.length; i++) {
    const uid = String(p.inventory.slots[i] || "");
    if (!uid) continue;

    const it = p.items.get(uid);
    if (!it) continue;

    if (String(it.kind || "") !== kind) continue;

    const qty = isFiniteNum(it.qty) ? it.qty : 0;
    if (qty < maxStack) return uid;
  }

  return "";
}

function addKindToInventory(p: PlayerState, kind: string, qty: number) {
  ensureSlotsLength(p);
  if (!kind || qty <= 0) return 0;

  const maxStack = maxStackForKind(kind);
  let remaining = qty;

  // stack into existing
  while (remaining > 0) {
    const stackUid = findStackableUid(p, kind);
    if (!stackUid) break;

    const it = p.items.get(stackUid);
    if (!it) break;

    const cur = isFiniteNum(it.qty) ? it.qty : 0;
    const space = Math.max(0, maxStack - cur);
    if (space <= 0) break;

    const add = Math.min(space, remaining);
    it.qty = cur + add;
    remaining -= add;
  }

  // create new stacks
  while (remaining > 0) {
    const idx = firstEmptyInvIndex(p);
    if (idx === -1) break;

    const add = Math.min(maxStack, remaining);
    remaining -= add;

    const uid = makeUid(p.id || "player", "loot");
    const it2 = new ItemState();
    it2.uid = uid;
    it2.kind = kind;
    it2.qty = add;

    p.items.set(uid, it2);
    p.inventory.slots[idx] = uid;
  }

  return qty - remaining;
}

function consumeSelectedHotbarBlock(p: PlayerState, expectedKind?: string) {
  ensureSlotsLength(p);

  const idx = normalizeHotbarIndex(p.hotbarIndex);
  const uid = String(p.inventory.slots[idx] || "");
  if (!uid) return { ok: false, reason: "empty_hotbar", idx, uid: "", kind: "" };

  const it = p.items.get(uid);
  if (!it) return { ok: false, reason: "missing_item", idx, uid, kind: "" };

  const kind = String(it.kind || "");
  if (!isBlockKind(kind)) return { ok: false, reason: "not_a_block", idx, uid, kind };

  if (expectedKind && kind !== expectedKind) {
    return { ok: false, reason: "hotbar_kind_mismatch", idx, uid, kind };
  }

  const qty = isFiniteNum(it.qty) ? it.qty : 0;
  if (qty <= 0) return { ok: false, reason: "no_qty", idx, uid, kind };

  it.qty = qty - 1;
  if (it.qty <= 0) {
    p.inventory.slots[idx] = "";
    p.items.delete(uid);
  }

  return { ok: true, idx, uid, kind };
}

function damageEquippedToolOnBreak(p: PlayerState, amount = 1) {
  const uid = String(p.equip?.tool || "");
  if (!uid) return;

  const it = p.items.get(uid);
  if (!it) return;

  const kind = String(it.kind || "");
  if (!isToolKind(kind)) return;

  const maxD = isFiniteNum(it.maxDurability) ? it.maxDurability : 0;
  if (maxD <= 0) return;

  const cur = isFiniteNum(it.durability) ? it.durability : maxD;
  const next = cur - Math.max(1, amount | 0);

  it.durability = clamp(next, 0, maxD);

  if (it.durability <= 0) {
    const total = getTotalSlots(p);
    for (let i = 0; i < total; i++) {
      if (String(p.inventory.slots[i] || "") === uid) p.inventory.slots[i] = "";
    }
    for (const k of ["head", "chest", "legs", "feet", "tool", "offhand"] as EquipKey[]) {
      if (String((p.equip as any)[k] || "") === uid) (p.equip as any)[k] = "";
    }
    p.items.delete(uid);
  }
}

// ------------------------------------------------------------
// server security: rate limit + reach checks
// ------------------------------------------------------------

class RateLimiter {
  private lastAt = new Map<string, number>();
  private minIntervalMs: number;

  constructor(minIntervalMs: number) {
    this.minIntervalMs = Math.max(1, minIntervalMs | 0);
  }

  public allow(key: string) {
    const t = nowMs();
    const prev = this.lastAt.get(key) || 0;
    if (t - prev < this.minIntervalMs) return false;
    this.lastAt.set(key, t);
    return true;
  }
}

function playerEyePos(p: PlayerState) {
  return { x: p.x, y: p.y + 0.9, z: p.z };
}

function withinReach(p: PlayerState, bx: number, by: number, bz: number, maxDist: number) {
  const eye = playerEyePos(p);
  const cx = bx + 0.5;
  const cy = by + 0.5;
  const cz = bz + 0.5;
  return distSq(eye.x, eye.y, eye.z, cx, cy, cz) <= maxDist * maxDist;
}

// ------------------------------------------------------------
// mining progress (server tick driven)
// ------------------------------------------------------------

type MiningSession = {
  active: boolean;
  x: number;
  y: number;
  z: number;
  progress: number; // 0..1
};

function hardnessForBlockId(id: number) {
  if (id === BLOCKS.DIRT) return 0.45; // seconds (baseline)
  if (id === BLOCKS.GRASS) return 0.55;
  return 0.6;
}

function toolSpeedMultiplier(p: PlayerState) {
  const uid = String(p.equip?.tool || "");
  if (!uid) return 1.0;

  const it = p.items.get(uid);
  if (!it) return 1.0;

  const k = String(it.kind || "").toLowerCase();
  if (!k) return 1.0;

  if (k.includes("pickaxe")) return 2.3;
  if (k.includes("axe")) return 1.6;
  if (k.includes("shovel")) return 2.0;
  if (k.startsWith("tool:")) return 1.35;

  return 1.0;
}

// ------------------------------------------------------------
// room
// ------------------------------------------------------------

export class MyRoom extends Room {
  public maxClients = 16;
  public state!: MyRoomState;

  // world persistence
  private world!: WorldStore;

  // chunk subscriptions
  private readonly CHUNK_SIZE = 32; // align with noa chunkSize
  private subsByClient = new Map<string, Set<string>>();

  // server security
  private rlBreak = new RateLimiter(90);
  private rlPlace = new RateLimiter(90);
  private rlSub = new RateLimiter(80);

  // mining sessions
  private miningByClient = new Map<string, MiningSession>();

  public onCreate(options: any) {
    this.setState(new MyRoomState());
    console.log("room", this.roomId, "created with options:", options);

    this.world = new WorldStore({
      savePath: `./world_${this.roomId}.json`,
    });

    // ---- Simulation tick
    const TICK_MS = 50; // 20 Hz
    const STAMINA_DRAIN_PER_SEC = 18;
    const STAMINA_REGEN_PER_SEC = 12;

    const SWING_COST = 8;
    const SWING_FLAG_MS = 250;

    const lastSwingAt = new Map<string, number>();

    this.setSimulationInterval(() => {
      const dt = TICK_MS / 1000;

      this.state.players.forEach((p: PlayerState, sid: string) => {
        ensureSlotsLength(p);

        // clamp stats
        p.maxHp = clamp(isFiniteNum(p.maxHp) ? p.maxHp : 20, 1, 200);
        p.maxStamina = clamp(isFiniteNum(p.maxStamina) ? p.maxStamina : 100, 1, 1000);

        p.hp = clamp(isFiniteNum(p.hp) ? p.hp : p.maxHp, 0, p.maxHp);
        p.stamina = clamp(isFiniteNum(p.stamina) ? p.stamina : p.maxStamina, 0, p.maxStamina);

        // sprint drain/regen
        if (p.sprinting) {
          const drain = STAMINA_DRAIN_PER_SEC * dt;
          p.stamina = clamp(p.stamina - drain, 0, p.maxStamina);
          if (p.stamina <= 0.001) p.sprinting = false;
        } else {
          const regen = STAMINA_REGEN_PER_SEC * dt;
          p.stamina = clamp(p.stamina + regen, 0, p.maxStamina);
        }

        // swing flag timeout
        const t0 = lastSwingAt.get(sid) || 0;
        if (p.swinging && nowMs() - t0 > SWING_FLAG_MS) p.swinging = false;

        // hotbar + equip sync
        p.hotbarIndex = normalizeHotbarIndex(p.hotbarIndex);
        syncEquipToolToHotbar(p);

        // mining progress
        const ms = this.miningByClient.get(sid);
        if (ms && ms.active) {
          const stillReach = withinReach(p, ms.x, ms.y, ms.z, 8.0);
          if (!stillReach) {
            ms.active = false;
            ms.progress = 0;
            const c = clientBySession(this, sid);
            c?.send("mine:progress", { x: ms.x, y: ms.y, z: ms.z, p: 0 });
            return;
          }

          const curId = this.world.getBlock(ms.x, ms.y, ms.z);
          if (curId === BLOCKS.AIR) {
            ms.active = false;
            ms.progress = 0;
            const c = clientBySession(this, sid);
            c?.send("mine:progress", { x: ms.x, y: ms.y, z: ms.z, p: 0 });
            return;
          }

          const hard = Math.max(0.05, hardnessForBlockId(curId));
          const mult = toolSpeedMultiplier(p);
          const rate = (1 / hard) * mult; // progress per second

          ms.progress = clamp(ms.progress + rate * dt, 0, 1);

          const c = clientBySession(this, sid);
          c?.send("mine:progress", { x: ms.x, y: ms.y, z: ms.z, p: ms.progress });

          if (ms.progress >= 1) {
            const prevId = curId;

            this.world.applyBreak(ms.x, ms.y, ms.z);

            const kind = blockIdToKind(prevId);
            if (kind) addKindToInventory(p, kind, 1);

            damageEquippedToolOnBreak(p, 1);
            syncEquipToolToHotbar(p);

            this.broadcastBlockUpdate(ms.x, ms.y, ms.z, BLOCKS.AIR);

            ms.active = false;
            ms.progress = 0;
            c?.send("mine:progress", { x: ms.x, y: ms.y, z: ms.z, p: 0 });
          }
        }
      });
    }, TICK_MS);

    // --------------------------------------------------------
    // Messages
    // --------------------------------------------------------

    this.onMessage("move", (client: Client, msg: MoveMsg) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;

      if (!isFiniteNum(msg?.x) || !isFiniteNum(msg?.y) || !isFiniteNum(msg?.z)) return;

      p.x = clamp(msg.x, -100000, 100000);
      p.y = clamp(msg.y, -100000, 100000);
      p.z = clamp(msg.z, -100000, 100000);

      if (isFiniteNum(msg.yaw)) p.yaw = msg.yaw;
      if (isFiniteNum(msg.pitch)) p.pitch = clamp(msg.pitch, -Math.PI / 2, Math.PI / 2);
    });

    this.onMessage("sprint", (client: Client, msg: SprintMsg) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;

      const on = !!msg?.on;
      if (on) {
        if (p.stamina > 2) p.sprinting = true;
      } else {
        p.sprinting = false;
      }
    });

    this.onMessage("swing", (client: Client, _msg: SwingMsg) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;

      if (p.stamina < SWING_COST) return;

      p.stamina = clamp(p.stamina - SWING_COST, 0, p.maxStamina);
      p.swinging = true;
      lastSwingAt.set(client.sessionId, nowMs());
    });

    this.onMessage("hotbar:set", (client: Client, msg: HotbarSetMsg) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;

      p.hotbarIndex = normalizeHotbarIndex(msg?.index);
      syncEquipToolToHotbar(p);
    });

    // ---- Chunk subscriptions
    this.onMessage("chunk:sub", (client: Client, msg: ChunkSubMsg) => {
      if (!this.rlSub.allow(client.sessionId + ":sub")) return;

      const cx = i32(msg?.cx, 0);
      const cz = i32(msg?.cz, 0);

      let set = this.subsByClient.get(client.sessionId);
      if (!set) {
        set = new Set<string>();
        this.subsByClient.set(client.sessionId, set);
      }

      const k = chunkKey(cx, cz);
      if (set.has(k)) return;
      set.add(k);

      const aabb = aabbForChunkXZ(cx, cz, this.CHUNK_SIZE);
      const patch = this.world.encodeEditsPatch(aabb.min, aabb.max, { limit: 5000 });
      client.send("world:patch", patch);
    });

    this.onMessage("chunk:unsub", (client: Client, msg: ChunkSubMsg) => {
      const cx = i32(msg?.cx, 0);
      const cz = i32(msg?.cz, 0);

      const set = this.subsByClient.get(client.sessionId);
      if (!set) return;

      set.delete(chunkKey(cx, cz));
    });

    // ---- Secure break/place (instant)
    this.onMessage("block:break", (client: Client, msg: BlockBreakMsg) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;

      if (!this.rlBreak.allow(client.sessionId + ":break")) {
        client.send("block:reject", { op: "break", reason: "rate_limit" });
        return;
      }

      const x = this.world.sanitizeCoord(msg?.x);
      const y = this.world.sanitizeCoord(msg?.y);
      const z = this.world.sanitizeCoord(msg?.z);

      if (!withinReach(p, x, y, z, 8.0)) {
        client.send("block:reject", { op: "break", reason: "out_of_reach", x, y, z });
        return;
      }

      const curId = this.world.getBlock(x, y, z);
      if (curId === BLOCKS.AIR) {
        client.send("block:reject", { op: "break", reason: "already_air", x, y, z });
        return;
      }

      this.world.applyBreak(x, y, z);

      const kind = blockIdToKind(curId);
      if (kind) addKindToInventory(p, kind, 1);

      damageEquippedToolOnBreak(p, 1);
      syncEquipToolToHotbar(p);

      this.broadcastBlockUpdate(x, y, z, BLOCKS.AIR);
    });

    this.onMessage("block:place", (client: Client, msg: BlockPlaceMsg) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;

      if (!this.rlPlace.allow(client.sessionId + ":place")) {
        client.send("block:reject", { op: "place", reason: "rate_limit" });
        return;
      }

      const kind = String(msg?.kind || "");
      if (!isBlockKind(kind)) {
        client.send("block:reject", { op: "place", reason: "not_a_block_kind", kind });
        return;
      }

      const id = kindToBlockId(kind);
      if (!id) {
        client.send("block:reject", { op: "place", reason: "unknown_block_kind", kind });
        return;
      }

      const x = this.world.sanitizeCoord(msg?.x);
      const y = this.world.sanitizeCoord(msg?.y);
      const z = this.world.sanitizeCoord(msg?.z);

      if (!withinReach(p, x, y, z, 8.0)) {
        client.send("block:reject", { op: "place", reason: "out_of_reach", x, y, z });
        return;
      }

      const curId = this.world.getBlock(x, y, z);
      if (curId !== BLOCKS.AIR) {
        client.send("block:reject", { op: "place", reason: "occupied", x, y, z });
        return;
      }

      const consumed = consumeSelectedHotbarBlock(p, kind);
      if (!consumed.ok) {
        client.send("block:reject", { op: "place", reason: consumed.reason, ...consumed });
        return;
      }

      syncEquipToolToHotbar(p);

      this.world.applyPlace(x, y, z, id);

      this.broadcastBlockUpdate(x, y, z, id);
    });

    // ---- Mining progress
    this.onMessage("mine:start", (client: Client, msg: MineStartMsg) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;

      const x = this.world.sanitizeCoord(msg?.x);
      const y = this.world.sanitizeCoord(msg?.y);
      const z = this.world.sanitizeCoord(msg?.z);

      if (!withinReach(p, x, y, z, 8.0)) {
        client.send("block:reject", { op: "mine", reason: "out_of_reach", x, y, z });
        return;
      }

      const curId = this.world.getBlock(x, y, z);
      if (curId === BLOCKS.AIR) {
        client.send("block:reject", { op: "mine", reason: "already_air", x, y, z });
        return;
      }

      this.miningByClient.set(client.sessionId, { active: true, x, y, z, progress: 0 });
      client.send("mine:progress", { x, y, z, p: 0 });
    });

    this.onMessage("mine:stop", (client: Client, _msg: MineStopMsg) => {
      const ms = this.miningByClient.get(client.sessionId);
      if (!ms) return;
      ms.active = false;
      ms.progress = 0;
      client.send("mine:progress", { x: ms.x, y: ms.y, z: ms.z, p: 0 });
    });

    // ---- Inventory slot moves / stacking / swapping
    this.onMessage("inv:move", (client: Client, msg: InvMoveMsg) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;

      const from = parseSlotRef(msg?.from);
      const to = parseSlotRef(msg?.to);
      if (!from || !to) return;

      ensureSlotsLength(p);
      const total = getTotalSlots(p);

      if (from.kind === "inv" && (from.index < 0 || from.index >= total)) return;
      if (to.kind === "inv" && (to.index < 0 || to.index >= total)) return;

      const fromUid = getSlotUid(p, from);
      const toUid = getSlotUid(p, to);

      if (!fromUid && !toUid) return;
      if (fromUid === toUid && fromUid) return;

      const fromItem = fromUid ? p.items.get(fromUid) : null;
      const toItem = toUid ? p.items.get(toUid) : null;

      // equipment compatibility checks
      if (to.kind === "eq") {
        const toKey = to.key;

        if (fromItem && !isEquipSlotCompatible(toKey, String(fromItem.kind || ""))) return;
        if (toItem && !isEquipSlotCompatible(toKey, String(toItem.kind || ""))) return;
      }

      // destination empty -> move
      if (!toUid) {
        setSlotUid(p, to, fromUid);
        setSlotUid(p, from, "");
        syncEquipToolToHotbar(p);
        return;
      }

      // source empty -> move reverse
      if (!fromUid) {
        setSlotUid(p, from, toUid);
        setSlotUid(p, to, "");
        syncEquipToolToHotbar(p);
        return;
      }

      // try stacking if same kind and stackable
      if (fromItem && toItem && String(fromItem.kind) === String(toItem.kind)) {
        const maxStack = maxStackForKind(String(toItem.kind));
        if (maxStack > 1) {
          const toQty = isFiniteNum(toItem.qty) ? toItem.qty : 0;
          const fromQty = isFiniteNum(fromItem.qty) ? fromItem.qty : 0;

          const space = maxStack - toQty;
          if (space > 0) {
            const moveQty = Math.min(space, fromQty);

            toItem.qty = toQty + moveQty;
            fromItem.qty = fromQty - moveQty;

            if ((fromItem.qty || 0) <= 0) {
              setSlotUid(p, from, "");
              p.items.delete(fromUid);
            }

            syncEquipToolToHotbar(p);
            return;
          }
        }
      }

      // otherwise swap
      setSlotUid(p, to, fromUid);
      setSlotUid(p, from, toUid);
      syncEquipToolToHotbar(p);
    });

    // ---- Split stack in half into first empty slot
    this.onMessage("inv:split", (client: Client, msg: InvSplitMsg) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;

      const slot = parseSlotRef(msg?.slot);
      if (!slot || slot.kind !== "inv") return;

      ensureSlotsLength(p);
      const total = getTotalSlots(p);
      if (slot.index < 0 || slot.index >= total) return;

      const uid = getSlotUid(p, slot);
      if (!uid) return;

      const it = p.items.get(uid);
      if (!it) return;

      const qty = isFiniteNum(it.qty) ? it.qty : 0;
      if (qty <= 1) return;

      const emptyIdx = firstEmptyInvIndex(p);
      if (emptyIdx === -1) return;

      const take = Math.floor(qty / 2);
      const remain = qty - take;
      if (take <= 0 || remain <= 0) return;

      it.qty = remain;

      const newUid = makeUid(client.sessionId, "split");
      const it2 = new ItemState();
      it2.uid = newUid;
      it2.kind = String(it.kind || "");
      it2.qty = take;
      it2.durability = isFiniteNum(it.durability) ? it.durability : 0;
      it2.maxDurability = isFiniteNum(it.maxDurability) ? it.maxDurability : 0;
      it2.meta = String(it.meta || "");

      p.items.set(newUid, it2);
      p.inventory.slots[emptyIdx] = newUid;

      syncEquipToolToHotbar(p);
    });

    // debug
    this.onMessage("hello", (client: Client, message: any) => {
      console.log(client.sessionId, "said hello:", message);
      client.send("hello_ack", { ok: true, serverTime: Date.now() });
    });
  }

  public onJoin(client: Client, options: JoinOptions) {
    console.log(client.sessionId, "joined!", "options:", options);

    if (!this.subsByClient.get(client.sessionId)) this.subsByClient.set(client.sessionId, new Set());

    const p = new PlayerState();
    p.id = client.sessionId;

    if (options && typeof options.name === "string" && options.name.trim()) p.name = options.name.trim();
    else p.name = "Steve";

    // spawn
    p.x = 0;
    p.y = 10;
    p.z = 0;
    p.yaw = 0;
    p.pitch = 0;

    // stats
    p.maxHp = 20;
    p.hp = 20;
    p.maxStamina = 100;
    p.stamina = 100;
    p.sprinting = false;
    p.swinging = false;

    // inventory size
    p.inventory.cols = 9;
    p.inventory.rows = 4;
    ensureSlotsLength(p);

    // hotbar
    p.hotbarIndex = 2;

    // starter items
    const dirtUid = makeUid(client.sessionId, "dirt");
    const grassUid = makeUid(client.sessionId, "grass");
    const toolUid = makeUid(client.sessionId, "tool");

    const dirt = new ItemState();
    dirt.uid = dirtUid;
    dirt.kind = "block:dirt";
    dirt.qty = 32;

    const grass = new ItemState();
    grass.uid = grassUid;
    grass.kind = "block:grass";
    grass.qty = 16;

    const tool = new ItemState();
    tool.uid = toolUid;
    tool.kind = "tool:pickaxe_wood";
    tool.qty = 1;
    tool.durability = 59;
    tool.maxDurability = 59;

    p.items.set(dirtUid, dirt);
    p.items.set(grassUid, grass);
    p.items.set(toolUid, tool);

    // hotbar slots 0,1,2
    p.inventory.slots[0] = dirtUid;
    p.inventory.slots[1] = grassUid;
    p.inventory.slots[2] = toolUid;

    syncEquipToolToHotbar(p);

    this.state.players.set(client.sessionId, p);

    client.send("welcome", {
      roomId: this.roomId,
      sessionId: client.sessionId,
    });

    // initial patch around player
    const patch = this.world.encodePatchAround({ x: p.x | 0, y: p.y | 0, z: p.z | 0 }, 160, { limit: 5000 });
    client.send("world:patch", patch);

    // auto-subscribe a small chunk radius so block updates route immediately
    const baseCx = Math.floor((p.x | 0) / this.CHUNK_SIZE);
    const baseCz = Math.floor((p.z | 0) / this.CHUNK_SIZE);
    const r = 2;
    const set = this.subsByClient.get(client.sessionId)!;
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        set.add(chunkKey(baseCx + dx, baseCz + dz));
      }
    }
  }

  public onLeave(client: Client, code: CloseCode) {
    console.log(client.sessionId, "left!", code);

    this.state.players.delete(client.sessionId);
    this.subsByClient.delete(client.sessionId);
    this.miningByClient.delete(client.sessionId);
  }

  public onDispose() {
    console.log("room", this.roomId, "disposing...");
  }

  // ----------------------------------------------------------
  // Helpers
  // ----------------------------------------------------------

  private broadcastBlockUpdate(x: number, y: number, z: number, id: number) {
    const { cx, cz } = chunkOfWorldXZ(x, z, this.CHUNK_SIZE);
    const ck = chunkKey(cx, cz);

    this.clients.forEach((c) => {
      const set = this.subsByClient.get(c.sessionId);
      if (!set) return;
      if (!set.has(ck)) return;
      c.send("block:update", { x, y, z, id });
    });
  }
}

// ------------------------------------------------------------
// helper: find client by session id
// ------------------------------------------------------------

function clientBySession(room: Room, sessionId: string) {
  const c = room.clients.find((cc) => cc.sessionId === sessionId);
  return c || null;
}
