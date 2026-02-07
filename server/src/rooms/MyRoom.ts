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
// - Server-authoritative WORLD using WorldStore:
//    - block:break  -> breaks block in WorldStore + inv:add(kind)
//    - block:place  -> validates + consumes hotbar + sets WorldStore
//    - broadcasts block:update {x,y,z,id} to everyone
//    - onJoin sends world:patch (edits near spawn/player)
// - equip.tool synced to selected hotbar slot IF item is tool-compatible
//
// IMPORTANT:
// - World base terrain MUST match client getVoxelID (WorldStore does).
// - Block IDs MUST match client registry (0 air, 1 dirt, 2 grass).
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

// building/mining inventory logic
type InvConsumeHotbarMsg = { qty?: number };
type InvAddMsg = { kind: string; qty?: number };

// SERVER-AUTH world actions
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
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return v | 0;
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
// world helpers (kind <-> id)
// ------------------------------------------------------------

function blockIdToKind(blockId: number): string {
  const id = i32(blockId, 0);
  if (id === BLOCKS.DIRT) return "block:dirt";
  if (id === BLOCKS.GRASS) return "block:grass";
  return "";
}

function kindToBlockId(kind: string): number {
  if (kind === "block:dirt") return BLOCKS.DIRT;
  if (kind === "block:grass") return BLOCKS.GRASS;
  return 0;
}

function isPlaceableBlockId(id: number) {
  return id === BLOCKS.DIRT || id === BLOCKS.GRASS;
}

function dist3(ax: number, ay: number, az: number, bx: number, by: number, bz: number) {
  const dx = ax - bx;
  const dy = ay - by;
  const dz = az - bz;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function insidePlayerAABB(px: number, py: number, pz: number, x: number, y: number, z: number) {
  const dx = Math.abs(x + 0.5 - px);
  const dz = Math.abs(z + 0.5 - pz);
  const dy = Math.abs(y + 0.5 - (py + 0.9));
  return dx < 0.45 && dz < 0.45 && dy < 1.0;
}

// ------------------------------------------------------------
// room
// ------------------------------------------------------------

export class MyRoom extends Room {
  public maxClients = 16;
  public state!: MyRoomState;

  private world!: WorldStore;

  public onCreate(options: any) {
    this.setState(new MyRoomState());
    this.world = new WorldStore({ minCoord: -100000, maxCoord: 100000 });

    console.log("room", this.roomId, "created with options:", options);

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
      });
    }, TICK_MS);

    // --------------------------------------------------------
    // Messages
    // --------------------------------------------------------

    this.onMessage("move", (client: Client, msg: MoveMsg) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;

      if (!isFiniteNum(msg?.x) || !isFiniteNum(msg?.y) || !isFiniteNum(msg?.z)) return;

      const sx = this.world.sanitizeCoord(msg.x);
      const sy = this.world.sanitizeCoord(msg.y);
      const sz = this.world.sanitizeCoord(msg.z);

      p.x = sx;
      p.y = sy;
      p.z = sz;

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

    // ---- CONSUME from selected hotbar slot (blocks only)
    this.onMessage("inv:consumeHotbar", (client: Client, msg: InvConsumeHotbarMsg) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;

      const qtyReq = clamp(Math.floor(Number(msg?.qty ?? 1)), 1, 64);

      const took = consumeFromHotbar(p, qtyReq);
      if (took > 0) syncEquipToolToHotbar(p);
    });

    // ---- ADD items to inventory (blocks only; stacking)
    this.onMessage("inv:add", (client: Client, msg: InvAddMsg) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;

      const kind = String(msg?.kind || "");
      if (!isBlockKind(kind)) return;

      const qtyReq = clamp(Math.floor(Number(msg?.qty ?? 1)), 1, 64);

      addKindToInventory(p, kind, qtyReq);
      syncEquipToolToHotbar(p);
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

    // ---- SERVER-AUTH WORLD: break block
    this.onMessage("block:break", (client: Client, msg: BlockBreakMsg) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;

      const x = this.world.sanitizeCoord(msg?.x);
      const y = this.world.sanitizeCoord(msg?.y);
      const z = this.world.sanitizeCoord(msg?.z);

      const reach = 8.0;
      const d = dist3(p.x, p.y + 1.2, p.z, x + 0.5, y + 0.5, z + 0.5);
      if (d > reach) return;

      const prev = this.world.getBlock(x, y, z);
      if (!prev || prev === BLOCKS.AIR) return;

      const res = this.world.applyBreak(x, y, z);

      const kind = blockIdToKind(prev);
      if (kind) addKindToInventory(p, kind, 1);

      syncEquipToolToHotbar(p);

      this.broadcast("block:update", { x, y, z, id: res.newId });
    });

    // ---- SERVER-AUTH WORLD: place block
    this.onMessage("block:place", (client: Client, msg: BlockPlaceMsg) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;

      const x = this.world.sanitizeCoord(msg?.x);
      const y = this.world.sanitizeCoord(msg?.y);
      const z = this.world.sanitizeCoord(msg?.z);

      const existing = this.world.getBlock(x, y, z);
      if (existing !== BLOCKS.AIR) return;

      const reach = 8.0;
      const d = dist3(p.x, p.y + 1.2, p.z, x + 0.5, y + 0.5, z + 0.5);
      if (d > reach) return;

      if (insidePlayerAABB(p.x, p.y, p.z, x, y, z)) return;

      let blockId = i32(msg?.blockId, 0);
      const kind = String(msg?.kind || "");

      if (kind && isBlockKind(kind)) {
        const mapped = kindToBlockId(kind);
        if (mapped) blockId = mapped;
      }

      if (!isPlaceableBlockId(blockId)) return;

      const took = consumeFromHotbar(p, 1);
      if (took <= 0) return;

      const res = this.world.applyPlace(x, y, z, blockId);

      syncEquipToolToHotbar(p);

      this.broadcast("block:update", { x, y, z, id: res.newId });
    });

    // debug
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

    // Send world edits near player so late joiners see builds
    const PATCH_RADIUS = 160;
    const patch = this.world.encodePatchAround({ x: p.x, y: p.y, z: p.z }, PATCH_RADIUS, { limit: 5000 });
    client.send("world:patch", patch);
  }

  public onLeave(client: Client, code: CloseCode) {
    console.log(client.sessionId, "left!", code);
    this.state.players.delete(client.sessionId);
  }

  public onDispose() {
    console.log("room", this.roomId, "disposing...");
  }
}
