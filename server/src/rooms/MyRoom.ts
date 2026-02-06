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
// - SERVER-AUTHORITATIVE WORLD (blocks) using sparse override store:
//    - Procedural base terrain (matches your client: sin/cos dirt+grass layering)
//    - Store only edits in a Map, broadcast edits via "block:update"
// - Mining:
//    - client sends "block:break" -> server validates reach -> sets block to 0
//    - server adds block item to inventory (stacking)
// - Building:
//    - client sends "block:place" -> server validates reach + empty -> consumes from hotbar
//    - server places block and broadcasts
// - Backwards compatible inventory messages still exist:
//    inv:consumeHotbar  / inv:add
// - equip.tool synced to selected hotbar slot IF item is tool-compatible
// ============================================================

import { Room, Client, CloseCode } from "colyseus";
import { MyRoomState, PlayerState, ItemState } from "./schema/MyRoomState.js";

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

// Backwards compatible inventory logic (keep if your client still calls these)
type InvConsumeHotbarMsg = { qty?: number };
type InvAddMsg = { kind: string; qty?: number };

// New world-authoritative actions
type BlockBreakMsg = { x: number; y: number; z: number };
type BlockPlaceMsg = { x: number; y: number; z: number; blockId?: number; kind?: string };

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
  const x = Number(n);
  return Number.isFinite(x) ? (x | 0) : fallback;
}

function key3(x: number, y: number, z: number) {
  return `${x | 0},${y | 0},${z | 0}`;
}

// ------------------------------------------------------------
// WORLD (server authoritative, sparse override store)
// ------------------------------------------------------------
//
// We keep a procedural "base world" (same as your client getVoxelID),
// and store edits in a Map. This means the server doesn't need to hold
// infinite chunks in memory to begin with.
//
// IMPORTANT: Keep block IDs consistent with your client registry.
// In your client:
//   dirtID = registerBlock(1, ...)
//   grassID = registerBlock(2, ...)
// So here:
//   1 = dirt, 2 = grass, 0 = air
//

const BLOCK = {
  AIR: 0,
  DIRT: 1,
  GRASS: 2,
} as const;

function getBaseVoxelID(x: number, y: number, z: number) {
  // Mirror the client exactly:
  // const height = 2 * Math.sin(x / 10) + 3 * Math.cos(z / 20);
  // if (y < height - 1) dirt
  // else if (y < height) grass
  // else air
  const height = 2 * Math.sin(x / 10) + 3 * Math.cos(z / 20);
  if (y < height - 1) return BLOCK.DIRT;
  if (y < height) return BLOCK.GRASS;
  return BLOCK.AIR;
}

function blockIdToKind(id: number) {
  if (id === BLOCK.DIRT) return "block:dirt";
  if (id === BLOCK.GRASS) return "block:grass";
  return "";
}

function kindToBlockId(kind: string) {
  if (kind === "block:dirt") return BLOCK.DIRT;
  if (kind === "block:grass") return BLOCK.GRASS;
  return 0;
}

function isBlockIdPlaceable(id: number) {
  return id === BLOCK.DIRT || id === BLOCK.GRASS;
}

class WorldStore {
  // sparse overrides: only store edits (including air removals)
  private overrides = new Map<string, number>();

  get(x: number, y: number, z: number) {
    const k = key3(x, y, z);
    if (this.overrides.has(k)) return this.overrides.get(k)!;
    return getBaseVoxelID(x, y, z);
  }

  set(x: number, y: number, z: number, id: number) {
    const k = key3(x, y, z);
    // store the override even if it matches base? we can avoid storing if equal.
    const base = getBaseVoxelID(x, y, z);
    if (id === base) {
      this.overrides.delete(k);
    } else {
      this.overrides.set(k, id | 0);
    }
  }
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

    const uid = makeUid(String(p.id || "player"), "loot");
    const it2 = new ItemState();
    it2.uid = uid;
    it2.kind = kind;
    it2.qty = add;

    p.items.set(uid, it2);
    p.inventory.slots[idx] = uid;
  }

  return qty - remaining;
}

function consumeFromHotbar(p: PlayerState, qty: number) {
  ensureSlotsLength(p);

  const idx = normalizeHotbarIndex(p.hotbarIndex);
  const uid = String(p.inventory.slots[idx] || "");
  if (!uid) return 0;

  const it = p.items.get(uid);
  if (!it) return 0;

  const kind = String(it.kind || "");
  if (!isBlockKind(kind)) return 0;

  const cur = isFiniteNum(it.qty) ? it.qty : 0;
  if (cur <= 0) return 0;

  const take = Math.min(cur, qty);
  it.qty = cur - take;

  if (it.qty <= 0) {
    p.inventory.slots[idx] = "";
    p.items.delete(uid);
  }

  return take;
}

// ------------------------------------------------------------
// server-side validation for block actions
// ------------------------------------------------------------

function isValidBlockCoord(x: number, y: number, z: number) {
  // keep same broad clamp as movement
  return (
    Number.isInteger(x) &&
    Number.isInteger(y) &&
    Number.isInteger(z) &&
    x >= -100000 &&
    x <= 100000 &&
    y >= -100000 &&
    y <= 100000 &&
    z >= -100000 &&
    z <= 100000
  );
}

function dist3(ax: number, ay: number, az: number, bx: number, by: number, bz: number) {
  const dx = ax - bx;
  const dy = ay - by;
  const dz = az - bz;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// ------------------------------------------------------------
// room
// ------------------------------------------------------------

export class MyRoom extends Room {
  public maxClients = 16;
  public state!: MyRoomState;

  private world = new WorldStore();

  public onCreate(options: any) {
    this.setState(new MyRoomState());
    console.log("room", this.roomId, "created with options:", options);

    // ---- Simulation tick
    const TICK_MS = 50; // 20 Hz
    const STAMINA_DRAIN_PER_SEC = 18;
    const STAMINA_REGEN_PER_SEC = 12;

    const SWING_COST = 8;
    const SWING_FLAG_MS = 250;

    const lastSwingAt = new Map<string, number>();

    // simple per-player rate limit for block edits
    const lastBlockEditAt = new Map<string, number>();
    const MIN_BLOCK_EDIT_INTERVAL_MS = 55; // ~18 edits/sec max

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
      });
    }, TICK_MS);

    // --------------------------------------------------------
    // Messages: player movement
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

    // --------------------------------------------------------
    // Messages: SERVER-AUTHORITATIVE WORLD EDITS
    // --------------------------------------------------------

    const canEditBlockNow = (sid: string) => {
      const t = nowMs();
      const prev = (lastBlockEditAt.get(sid) || 0) | 0;
      if (t - prev < MIN_BLOCK_EDIT_INTERVAL_MS) return false;
      lastBlockEditAt.set(sid, t);
      return true;
    };

    const withinReach = (p: PlayerState, x: number, y: number, z: number) => {
      // use "eye position" approximation
      const ex = safeCoord(p.x);
      const ey = safeCoord(p.y + 1.6);
      const ez = safeCoord(p.z);
      const bx = x + 0.5;
      const by = y + 0.5;
      const bz = z + 0.5;
      return dist3(ex, ey, ez, bx, by, bz) <= 8.0;
    };

    function safeCoord(n: any) {
      const v = Number(n);
      return Number.isFinite(v) ? v : 0;
    }

    // break block (mining)
    this.onMessage("block:break", (client: Client, msg: BlockBreakMsg) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;

      const x = i32(msg?.x);
      const y = i32(msg?.y);
      const z = i32(msg?.z);

      if (!isValidBlockCoord(x, y, z)) return;
      if (!canEditBlockNow(client.sessionId)) return;
      if (!withinReach(p, x, y, z)) return;

      const existing = this.world.get(x, y, z);
      if (existing === BLOCK.AIR) return;

      // set to air
      this.world.set(x, y, z, BLOCK.AIR);

      // add to inventory (blocks only)
      const kind = blockIdToKind(existing);
      if (kind) addKindToInventory(p, kind, 1);

      syncEquipToolToHotbar(p);

      // broadcast authoritative update
      this.broadcast("block:update", { x, y, z, id: BLOCK.AIR });
    });

    // place block (building)
    this.onMessage("block:place", (client: Client, msg: BlockPlaceMsg) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;

      const x = i32(msg?.x);
      const y = i32(msg?.y);
      const z = i32(msg?.z);

      if (!isValidBlockCoord(x, y, z)) return;
      if (!canEditBlockNow(client.sessionId)) return;
      if (!withinReach(p, x, y, z)) return;

      // must be empty
      const existing = this.world.get(x, y, z);
      if (existing !== BLOCK.AIR) return;

      // Determine blockId:
      // Prefer msg.blockId if provided; else allow msg.kind.
      let blockId = 0;
      if (isFiniteNum(msg?.blockId)) blockId = msg.blockId | 0;
      if (!blockId && typeof msg?.kind === "string") blockId = kindToBlockId(msg.kind);

      // If client didn't specify, use selected hotbar item kind:
      // (This makes the server resilient even if client forgets to include blockId.)
      if (!blockId) {
        ensureSlotsLength(p);
        const idx = normalizeHotbarIndex(p.hotbarIndex);
        const uid = String(p.inventory.slots[idx] || "");
        const it = uid ? p.items.get(uid) : null;
        const kind = String(it?.kind || "");
        blockId = kindToBlockId(kind);
      }

      if (!isBlockIdPlaceable(blockId)) return;

      // consume from hotbar (blocks only)
      const took = consumeFromHotbar(p, 1);
      if (took !== 1) {
        syncEquipToolToHotbar(p);
        return;
      }

      this.world.set(x, y, z, blockId);
      syncEquipToolToHotbar(p);

      this.broadcast("block:update", { x, y, z, id: blockId });
    });

    // --------------------------------------------------------
    // Messages: Backwards compatible inventory helpers
    // (You can keep these, but your client should not use them
    //  to drive block truth anymore.)
    // --------------------------------------------------------

    this.onMessage("inv:consumeHotbar", (client: Client, msg: InvConsumeHotbarMsg) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;

      const qtyReq = clamp(Math.floor(Number(msg?.qty ?? 1)), 1, 64);

      const took = consumeFromHotbar(p, qtyReq);
      if (took > 0) syncEquipToolToHotbar(p);
    });

    this.onMessage("inv:add", (client: Client, msg: InvAddMsg) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;

      const kind = String(msg?.kind || "");
      if (!isBlockKind(kind)) return;

      const qtyReq = clamp(Math.floor(Number(msg?.qty ?? 1)), 1, 64);

      addKindToInventory(p, kind, qtyReq);
      syncEquipToolToHotbar(p);
    });

    // --------------------------------------------------------
    // Messages: Inventory slot moves / stacking / swapping
    // --------------------------------------------------------

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

    // --------------------------------------------------------
    // Messages: Split stack in half into first empty slot
    // --------------------------------------------------------

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

      // find empty slot
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

    // --------------------------------------------------------
    // Debug
    // --------------------------------------------------------

    this.onMessage("hello", (client: Client, message: any) => {
      console.log(client.sessionId, "said hello:", message);
      client.send("hello_ack", { ok: true, serverTime: Date.now() });
    });
  }

  public onJoin(client: Client, options: JoinOptions) {
    console.log(client.sessionId, "joined!", "options:", options);

    const p = new PlayerState();
    p.id = client.sessionId;

    if (options && typeof options.name === "string" && options.name.trim()) {
      p.name = options.name.trim();
    } else {
      p.name = "Steve";
    }

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

    // place into hotbar slots 0,1,2
    p.inventory.slots[0] = dirtUid;
    p.inventory.slots[1] = grassUid;
    p.inventory.slots[2] = toolUid;

    // sync equip.tool based on hotbar selection
    syncEquipToolToHotbar(p);

    this.state.players.set(client.sessionId, p);

    client.send("welcome", {
      roomId: this.roomId,
      sessionId: client.sessionId,
    });
  }

  public onLeave(client: Client, code: CloseCode) {
    console.log(client.sessionId, "left!", code);
    this.state.players.delete(client.sessionId);
  }

  public onDispose() {
    console.log("room", this.roomId, "disposing...");
  }
}
