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

type InvMoveMsg = { from: string; to: string };
type InvSplitMsg = { slot: string };

function isFiniteNum(n: any): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

function nowMs() {
  return Date.now();
}

/**
 * Slot id formats from client:
 * - "inv:<index>" e.g. inv:12
 * - "eq:<key>"    e.g. eq:tool, eq:head
 */
type SlotRef =
  | { kind: "inv"; index: number }
  | { kind: "eq"; key: "head" | "chest" | "legs" | "feet" | "tool" | "offhand" };

function parseSlotRef(s: any): SlotRef | null {
  if (typeof s !== "string") return null;

  if (s.startsWith("inv:")) {
    const idx = Number(s.slice(4));
    if (!Number.isInteger(idx) || idx < 0) return null;
    return { kind: "inv", index: idx };
  }

  if (s.startsWith("eq:")) {
    const key = s.slice(3);
    const allowed = new Set(["head", "chest", "legs", "feet", "tool", "offhand"]);
    if (!allowed.has(key)) return null;
    return { kind: "eq", key: key as any };
  }

  return null;
}

function getTotalSlots(p: PlayerState) {
  const cols = isFiniteNum((p as any).inventory?.cols) ? (p as any).inventory.cols : 9;
  const rows = isFiniteNum((p as any).inventory?.rows) ? (p as any).inventory.rows : 4;
  return Math.max(1, cols * rows);
}

function getSlotUid(p: PlayerState, slot: SlotRef): string {
  if (slot.kind === "inv") {
    const total = getTotalSlots(p);
    if (slot.index < 0 || slot.index >= total) return "";
    return String((p as any).inventory.slots[slot.index] || "");
  } else {
    return String((p as any).equip[slot.key] || "");
  }
}

function setSlotUid(p: PlayerState, slot: SlotRef, uid: string) {
  uid = uid ? String(uid) : "";
  if (slot.kind === "inv") {
    const total = getTotalSlots(p);
    if (slot.index < 0 || slot.index >= total) return;
    (p as any).inventory.slots[slot.index] = uid;
  } else {
    (p as any).equip[slot.key] = uid;
  }
}

function isEquipSlotCompatible(slotKey: string, itemKind: string) {
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

export class MyRoom extends Room {
  public maxClients = 16;

  // typed view of state (fixes your TS version mismatch with Room<T>)
  public state!: MyRoomState;

  public onCreate(options: any) {
    this.setState(new MyRoomState());

    console.log("room", this.roomId, "created with options:", options);

    // ---- Simulation tick: stamina regen/drain, swing flag timeout
    const TICK_MS = 50; // 20 Hz
    const STAMINA_DRAIN_PER_SEC = 18;
    const STAMINA_REGEN_PER_SEC = 12;
    const SWING_COST = 8;
    const SWING_FLAG_MS = 250;

    const lastSwingAt = new Map<string, number>();

    this.setSimulationInterval(() => {
      const dt = TICK_MS / 1000;

      this.state.players.forEach((p: PlayerState, sid: string) => {
        p.maxHp = clamp(isFiniteNum(p.maxHp) ? p.maxHp : 20, 1, 200);
        p.maxStamina = clamp(isFiniteNum(p.maxStamina) ? p.maxStamina : 100, 1, 1000);

        p.hp = clamp(isFiniteNum(p.hp) ? p.hp : p.maxHp, 0, p.maxHp);
        p.stamina = clamp(isFiniteNum(p.stamina) ? p.stamina : p.maxStamina, 0, p.maxStamina);

        if (p.sprinting) {
          const drain = STAMINA_DRAIN_PER_SEC * dt;
          p.stamina = clamp(p.stamina - drain, 0, p.maxStamina);
          if (p.stamina <= 0.001) p.sprinting = false;
        } else {
          const regen = STAMINA_REGEN_PER_SEC * dt;
          p.stamina = clamp(p.stamina + regen, 0, p.maxStamina);
        }

        const t0 = lastSwingAt.get(sid) || 0;
        if (p.swinging && nowMs() - t0 > SWING_FLAG_MS) {
          p.swinging = false;
        }
      });
    }, TICK_MS);

    // ---- Messages
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

    this.onMessage("inv:move", (client: Client, msg: InvMoveMsg) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;

      const from = parseSlotRef(msg?.from);
      const to = parseSlotRef(msg?.to);
      if (!from || !to) return;

      const total = getTotalSlots(p);
      if (from.kind === "inv" && (from.index < 0 || from.index >= total)) return;
      if (to.kind === "inv" && (to.index < 0 || to.index >= total)) return;

      const fromUid = getSlotUid(p, from);
      const toUid = getSlotUid(p, to);

      if (!fromUid && !toUid) return;
      if (fromUid === toUid && fromUid) return;

      const fromItem = fromUid ? p.items.get(fromUid) : null;
      const toItem = toUid ? p.items.get(toUid) : null;

      if (to.kind === "eq" && fromItem) {
        if (!isEquipSlotCompatible(String(to.key), String(fromItem.kind || ""))) return;
      }
      if (to.kind === "eq" && toItem) {
        if (!isEquipSlotCompatible(String(to.key), String(toItem.kind || ""))) return;
      }

      // move into empty
      if (!toUid) {
        setSlotUid(p, to, fromUid);
        setSlotUid(p, from, "");
        return;
      }

      // move from empty (reverse)
      if (!fromUid) {
        setSlotUid(p, from, toUid);
        setSlotUid(p, to, "");
        return;
      }

      // stack if same kind and stackable
      if (fromItem && toItem && String(fromItem.kind) === String(toItem.kind)) {
        const maxStack = maxStackForKind(String(toItem.kind));
        if (maxStack > 1) {
          const space = maxStack - (toItem.qty || 0);
          if (space > 0) {
            const moveQty = Math.min(space, fromItem.qty || 0);
            toItem.qty = (toItem.qty || 0) + moveQty;
            fromItem.qty = (fromItem.qty || 0) - moveQty;

            if ((fromItem.qty || 0) <= 0) {
              setSlotUid(p, from, "");
              p.items.delete(fromUid);
            }
            return;
          }
        }
      }

      // swap
      setSlotUid(p, to, fromUid);
      setSlotUid(p, from, toUid);
    });

    this.onMessage("inv:split", (client: Client, msg: InvSplitMsg) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;

      const slot = parseSlotRef(msg?.slot);
      if (!slot || slot.kind !== "inv") return;

      const total = getTotalSlots(p);
      if (slot.index < 0 || slot.index >= total) return;

      const uid = getSlotUid(p, slot);
      if (!uid) return;

      const it = p.items.get(uid);
      if (!it) return;

      const qty = isFiniteNum(it.qty) ? it.qty : 0;
      if (qty <= 1) return;

      // find empty slot
      let emptyIndex = -1;
      for (let i = 0; i < total; i++) {
        if (!String(p.inventory.slots[i] || "")) {
          emptyIndex = i;
          break;
        }
      }
      if (emptyIndex === -1) return;

      const take = Math.floor(qty / 2);
      const remain = qty - take;
      if (take <= 0 || remain <= 0) return;

      it.qty = remain;

      const newUid = `${client.sessionId}:${nowMs()}:${Math.floor(Math.random() * 1e9)}`;
      const it2 = new ItemState();
      it2.uid = newUid;
      it2.kind = String(it.kind || "");
      it2.qty = take;
      it2.durability = isFiniteNum(it.durability) ? it.durability : 0;
      it2.maxDurability = isFiniteNum(it.maxDurability) ? it.maxDurability : 0;
      it2.meta = String(it.meta || "");

      p.items.set(newUid, it2);
      p.inventory.slots[emptyIndex] = newUid;
    });

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

    // Spawn
    p.x = 0;
    p.y = 10;
    p.z = 0;
    p.yaw = 0;
    p.pitch = 0;

    // Stats defaults
    p.maxHp = 20;
    p.hp = 20;
    p.maxStamina = 100;
    p.stamina = 100;
    p.sprinting = false;
    p.swinging = false;

    // Inventory defaults
    p.inventory.cols = 9;
    p.inventory.rows = 4;

    const total = p.inventory.cols * p.inventory.rows;
    while (p.inventory.slots.length < total) p.inventory.slots.push("");
    while (p.inventory.slots.length > total) p.inventory.slots.pop();

    // Starter items
    const dirtUid = `${client.sessionId}:item:dirt:${nowMs()}`;
    const grassUid = `${client.sessionId}:item:grass:${nowMs() + 1}`;
    const toolUid = `${client.sessionId}:item:tool:${nowMs() + 2}`;

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

    p.inventory.slots[0] = dirtUid;
    p.inventory.slots[1] = grassUid;
    p.equip.tool = toolUid;

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
