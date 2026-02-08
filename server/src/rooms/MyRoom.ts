// ============================================================
// rooms/MyRoom.ts  (FULL REWRITE - NO OMITS - BIOMES BLOCKS SUPPORT)
// ------------------------------------------------------------
// Keeps all logic:
// - movement, sprint/stamina, swing, hotbar/equip sync
// - inventory move/split/add/consume
// - legacy craft:commit (index mapping) with DUPLICATE INDEX REJECT (anti-exploit)
// - world patching
// - break/place with reach + rate limit
// - persistence + autosave + shutdown save
//
// Fixes included:
// - Player persistent identity: PlayerState.id = distinctId (not sessionId)
// - UID generation uses persistent id
// - block:place ignores msg.kind (derives from hotbar item, server-authoritative)
// - craft:commit rejects duplicate inventory indices + sends craft:reject
// ============================================================

import { Room, Client } from "colyseus";
import * as fs from "fs";
import * as path from "path";

// Imports with .js extensions for Node16/NodeNext resolution
import { WorldStore, BLOCKS, type BlockId } from "../world/WorldStore.js";
import { MyRoomState, PlayerState, ItemState } from "./schema/MyRoomState.js";

// Legacy crafting (kept)
import { CraftingSystem } from "../crafting/CraftingSystem.js";

// ------------------------------------------------------------
// Message Types
// ------------------------------------------------------------

type JoinOptions = { name?: string; distinctId?: string };

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

type InvConsumeHotbarMsg = { qty?: number };
type InvAddMsg = { kind: string; qty?: number };

// Legacy crafting commit (virtual mapping indices)
type CraftCommitMsg = { srcIndices: number[] };

type BlockBreakMsg = { x: number; y: number; z: number; src?: string };
type BlockPlaceMsg = { x: number; y: number; z: number; kind?: string; src?: string };

type WorldPatchReqMsg = { x: number; y: number; z: number; r?: number; limit?: number };

// ------------------------------------------------------------
// Utils
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

function dist3(ax: number, ay: number, az: number, bx: number, by: number, bz: number) {
  const dx = ax - bx;
  const dy = ay - by;
  const dz = az - bz;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// ------------------------------------------------------------
// Slots + Inventory Logic
// ------------------------------------------------------------

type EquipKey = "head" | "chest" | "legs" | "feet" | "tool" | "offhand";

type SlotRef = { kind: "inv"; index: number } | { kind: "eq"; key: EquipKey };

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
// Item Rules
// ------------------------------------------------------------

function isEquipSlotCompatible(slotKey: EquipKey, itemKind: string) {
  if (!itemKind) return true;
  const k = itemKind.toLowerCase();

  if (slotKey === "tool") {
    return (
      k.startsWith("tool:") ||
      k.includes("pickaxe") ||
      k.includes("axe") ||
      k.includes("sword") ||
      k.includes("shovel") ||
      k.includes("wand") ||
      k.includes("club")
    );
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

  if (
    k.startsWith("tool:") ||
    k.includes("pickaxe") ||
    k.includes("axe") ||
    k.includes("sword") ||
    k.includes("shovel") ||
    k.includes("wand") ||
    k.includes("club")
  ) {
    return 1;
  }

  return 64;
}

function isBlockKind(kind: string) {
  return typeof kind === "string" && kind.startsWith("block:");
}

// ------------------------------------------------------------
// Hotbar + Equip Sync
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
// Inventory Add/Consume Helpers
// ------------------------------------------------------------

function makeUid(ownerId: string, tag: string) {
  return `${ownerId}:${tag}:${nowMs()}:${Math.floor(Math.random() * 1e9)}`;
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

  // 1) stack into existing
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

  // 2) new stacks
  while (remaining > 0) {
    const idx = firstEmptyInvIndex(p);
    if (idx === -1) break;

    const add = Math.min(maxStack, remaining);
    remaining -= add;

    const owner = String(p.id || "player"); // p.id is distinctId (persistent)
    const uid = makeUid(owner, "loot");

    const it2 = new ItemState();
    it2.uid = uid;
    it2.kind = kind;
    it2.qty = add;

    if (String(kind).startsWith("tool:")) {
      it2.durability = 100;
      it2.maxDurability = 100;
    }

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

  if ((it.qty || 0) <= 0) {
    p.inventory.slots[idx] = "";
    p.items.delete(uid);
  }

  return take;
}

function getHotbarBlockKind(p: PlayerState): string {
  ensureSlotsLength(p);
  const idx = normalizeHotbarIndex(p.hotbarIndex);
  const uid = String(p.inventory.slots[idx] || "");
  const it = uid ? p.items.get(uid) : null;
  return String(it?.kind || "");
}

// ------------------------------------------------------------
// Block Mapping (UPDATED: Biomes + Ores + Crafted Blocks)
// ------------------------------------------------------------

function kindToBlockId(kind: string): BlockId {
  // Core terrain
  if (kind === "block:dirt") return BLOCKS.DIRT;
  if (kind === "block:grass") return BLOCKS.GRASS;
  if (kind === "block:stone") return BLOCKS.STONE;
  if (kind === "block:bedrock") return BLOCKS.BEDROCK;

  // Trees
  if (kind === "block:log") return BLOCKS.LOG;
  if (kind === "block:leaves") return BLOCKS.LEAVES;

  // Crafted building
  if (kind === "block:plank") return (BLOCKS as any).PLANKS ?? (BLOCKS as any).PLANK ?? BLOCKS.LOG;

  // Biome surfaces
  if (kind === "block:sand") return (BLOCKS as any).SAND ?? BLOCKS.DIRT;
  if (kind === "block:snow") return (BLOCKS as any).SNOW ?? BLOCKS.DIRT;
  if (kind === "block:clay") return (BLOCKS as any).CLAY ?? BLOCKS.DIRT;
  if (kind === "block:gravel") return (BLOCKS as any).GRAVEL ?? BLOCKS.STONE;
  if (kind === "block:mud") return (BLOCKS as any).MUD ?? BLOCKS.DIRT;
  if (kind === "block:ice") return (BLOCKS as any).ICE ?? BLOCKS.STONE;

  // Ores / valuables
  if (kind === "block:coal_ore") return (BLOCKS as any).COAL_ORE ?? BLOCKS.STONE;
  if (kind === "block:copper_ore") return (BLOCKS as any).COPPER_ORE ?? BLOCKS.STONE;
  if (kind === "block:iron_ore") return (BLOCKS as any).IRON_ORE ?? BLOCKS.STONE;
  if (kind === "block:silver_ore") return (BLOCKS as any).SILVER_ORE ?? BLOCKS.STONE;
  if (kind === "block:gold_ore") return (BLOCKS as any).GOLD_ORE ?? BLOCKS.STONE;

  if (kind === "block:ruby_ore") return (BLOCKS as any).RUBY_ORE ?? BLOCKS.STONE;
  if (kind === "block:sapphire_ore") return (BLOCKS as any).SAPPHIRE_ORE ?? BLOCKS.STONE;
  if (kind === "block:mythril_ore") return (BLOCKS as any).MYTHRIL_ORE ?? BLOCKS.STONE;
  if (kind === "block:dragonstone") return (BLOCKS as any).DRAGONSTONE ?? BLOCKS.STONE;

  // Crafted functional blocks
  if (kind === "block:crafting_table") return (BLOCKS as any).CRAFTING_TABLE ?? (BLOCKS as any).PLANKS ?? BLOCKS.LOG;
  if (kind === "block:chest") return (BLOCKS as any).CHEST ?? (BLOCKS as any).PLANKS ?? BLOCKS.LOG;
  if (kind === "block:slab_plank") return (BLOCKS as any).SLAB_PLANK ?? (BLOCKS as any).PLANKS ?? BLOCKS.LOG;
  if (kind === "block:stairs_plank") return (BLOCKS as any).STAIRS_PLANK ?? (BLOCKS as any).PLANKS ?? BLOCKS.LOG;
  if (kind === "block:door_wood") return (BLOCKS as any).DOOR_WOOD ?? (BLOCKS as any).PLANKS ?? BLOCKS.LOG;

  return BLOCKS.AIR;
}

function blockIdToKind(id: BlockId): string {
  // Core terrain
  if (id === BLOCKS.DIRT) return "block:dirt";
  if (id === BLOCKS.GRASS) return "block:grass";
  if (id === BLOCKS.STONE) return "block:stone";
  if (id === BLOCKS.BEDROCK) return "block:bedrock";

  // Trees
  if (id === BLOCKS.LOG) return "block:log";
  if (id === BLOCKS.LEAVES) return "block:leaves";

  // Crafted building
  if (id === (BLOCKS as any).PLANKS) return "block:plank";

  // Biome surfaces
  if (id === (BLOCKS as any).SAND) return "block:sand";
  if (id === (BLOCKS as any).SNOW) return "block:snow";
  if (id === (BLOCKS as any).CLAY) return "block:clay";
  if (id === (BLOCKS as any).GRAVEL) return "block:gravel";
  if (id === (BLOCKS as any).MUD) return "block:mud";
  if (id === (BLOCKS as any).ICE) return "block:ice";

  // Ores / valuables
  if (id === (BLOCKS as any).COAL_ORE) return "block:coal_ore";
  if (id === (BLOCKS as any).COPPER_ORE) return "block:copper_ore";
  if (id === (BLOCKS as any).IRON_ORE) return "block:iron_ore";
  if (id === (BLOCKS as any).SILVER_ORE) return "block:silver_ore";
  if (id === (BLOCKS as any).GOLD_ORE) return "block:gold_ore";

  if (id === (BLOCKS as any).RUBY_ORE) return "block:ruby_ore";
  if (id === (BLOCKS as any).SAPPHIRE_ORE) return "block:sapphire_ore";
  if (id === (BLOCKS as any).MYTHRIL_ORE) return "block:mythril_ore";
  if (id === (BLOCKS as any).DRAGONSTONE) return "block:dragonstone";

  // Crafted functional blocks
  if (id === (BLOCKS as any).CRAFTING_TABLE) return "block:crafting_table";
  if (id === (BLOCKS as any).CHEST) return "block:chest";
  if (id === (BLOCKS as any).SLAB_PLANK) return "block:slab_plank";
  if (id === (BLOCKS as any).STAIRS_PLANK) return "block:stairs_plank";
  if (id === (BLOCKS as any).DOOR_WOOD) return "block:door_wood";

  return "";
}

// ------------------------------------------------------------
// Coordinate Sanity
// ------------------------------------------------------------

function sanitizeInt(n: any, fallback = 0) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return v | 0;
}

function isValidBlockCoord(n: any) {
  const v = Number(n);
  return Number.isFinite(v) && Math.floor(v) === v;
}

// ============================================================
// Room Implementation
// ============================================================

export class MyRoom extends Room {
  declare state: MyRoomState;

  public maxClients = 16;

  // Shared world per server process
  private static WORLD = new WorldStore({ minCoord: -100000, maxCoord: 100000 });

  // Persistence paths
  private worldPath = path.join(process.cwd(), "world_data.json");
  private playersPath = path.join(process.cwd(), "players.json");

  // Rate limiting
  private lastBlockOpAt = new Map<string, number>();

  // --------------------------------------------------------
  // Persistence Helpers
  // --------------------------------------------------------

  private loadPlayerData(distinctId: string) {
    if (!fs.existsSync(this.playersPath)) return null;
    try {
      const raw = fs.readFileSync(this.playersPath, "utf8");
      const data = JSON.parse(raw);
      return data[distinctId] || null;
    } catch (e) {
      console.error("Load Error:", e);
      return null;
    }
  }

  private savePlayerData(distinctId: string, p: PlayerState) {
    let allData: any = {};
    if (fs.existsSync(this.playersPath)) {
      try {
        allData = JSON.parse(fs.readFileSync(this.playersPath, "utf8"));
      } catch {}
    }

    const itemsArray = Array.from(p.items.entries()).map((entry: any) => {
      const [uid, item] = entry;
      return {
        uid,
        kind: item.kind,
        qty: item.qty,
        durability: item.durability,
        maxDurability: item.maxDurability,
        meta: item.meta,
      };
    });

    const saveData = {
      x: p.x,
      y: p.y,
      z: p.z,
      yaw: p.yaw,
      pitch: p.pitch,
      hp: p.hp,
      stamina: p.stamina,
      hotbarIndex: p.hotbarIndex,
      inventory: Array.from(p.inventory.slots),
      items: itemsArray,
      equip: p.equip.toJSON(),
    };

    allData[distinctId] = saveData;
    fs.writeFileSync(this.playersPath, JSON.stringify(allData, null, 2));
    console.log(`[PERSIST] Saved data for ${distinctId}`);
  }

  // --------------------------------------------------------
  // Room Lifecycle
  // --------------------------------------------------------

  public onCreate(options: any) {
    this.setState(new MyRoomState());
    console.log("MyRoom created:", this.roomId, options);

    // 1) Load World from Disk
    if (fs.existsSync(this.worldPath)) {
      console.log(`[PERSIST] Loading world from ${this.worldPath}...`);
      try {
        const loaded = MyRoom.WORLD.loadFromFileSync(this.worldPath);
        if (loaded) console.log(`[PERSIST] Loaded ${MyRoom.WORLD.editsCount()} edits.`);
        else console.log(`[PERSIST] File existed but failed to load.`);
      } catch (e) {
        console.error(`[PERSIST] Error loading world:`, e);
      }
    } else {
      console.log(`[PERSIST] No save file found at ${this.worldPath}. Starting fresh.`);
    }

    // 2) Configure Autosave
    MyRoom.WORLD.configureAutosave({
      path: this.worldPath,
      minIntervalMs: 30000,
    });

    // 3) Simulation Tick
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

        // Clamp stats
        p.maxHp = clamp(isFiniteNum(p.maxHp) ? p.maxHp : 20, 1, 200);
        p.maxStamina = clamp(isFiniteNum(p.maxStamina) ? p.maxStamina : 100, 1, 1000);
        p.hp = clamp(isFiniteNum(p.hp) ? p.hp : p.maxHp, 0, p.maxHp);
        p.stamina = clamp(isFiniteNum(p.stamina) ? p.stamina : p.maxStamina, 0, p.maxStamina);

        // Sprint drain/regen
        if (p.sprinting) {
          const drain = STAMINA_DRAIN_PER_SEC * dt;
          p.stamina = clamp(p.stamina - drain, 0, p.maxStamina);
          if (p.stamina <= 0.001) p.sprinting = false;
        } else {
          const regen = STAMINA_REGEN_PER_SEC * dt;
          p.stamina = clamp(p.stamina + regen, 0, p.maxStamina);
        }

        // Swing flag timeout
        const t0 = lastSwingAt.get(sid) || 0;
        if (p.swinging && nowMs() - t0 > SWING_FLAG_MS) p.swinging = false;

        // Sync Equip
        p.hotbarIndex = normalizeHotbarIndex(p.hotbarIndex);
        syncEquipToolToHotbar(p);
      });

      MyRoom.WORLD.maybeAutosave();
    }, TICK_MS);

    // --------------------------------------------------------
    // Movement Handlers
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
    // Inventory Handlers
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

      // Equipment compatibility
      if (to.kind === "eq") {
        if (fromItem && !isEquipSlotCompatible(to.key, String(fromItem.kind || ""))) return;
        if (toItem && !isEquipSlotCompatible(to.key, String(toItem.kind || ""))) return;
      }

      // Move into empty
      if (!toUid) {
        setSlotUid(p, to, fromUid);
        setSlotUid(p, from, "");
        syncEquipToolToHotbar(p);
        return;
      }
      if (!fromUid) {
        setSlotUid(p, from, toUid);
        setSlotUid(p, to, "");
        syncEquipToolToHotbar(p);
        return;
      }

      // Stack merge
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

      // Direct swap
      setSlotUid(p, to, fromUid);
      setSlotUid(p, from, toUid);
      syncEquipToolToHotbar(p);
    });

    this.onMessage("inv:split", (client: Client, msg: InvSplitMsg) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;

      const slot = parseSlotRef(msg?.slot);
      if (!slot || slot.kind !== "inv") return;

      ensureSlotsLength(p);
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

      const owner = String(p.id || client.sessionId);
      const newUid = makeUid(owner, "split");

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
    // Crafting Handler (LEGACY craft:commit) + DUP INDEX REJECT
    // --------------------------------------------------------

    this.onMessage("craft:commit", (client: Client, msg: CraftCommitMsg) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;

      const indices = msg?.srcIndices;
      if (!Array.isArray(indices) || indices.length !== 9) {
        console.log(`[CRAFT] Invalid indices from ${client.sessionId}`);
        return;
      }

      // Reject duplicate inv indices (anti-exploit)
      {
        const seen = new Set<number>();
        for (let i = 0; i < 9; i++) {
          const slotIdx = indices[i];
          if (slotIdx === -1) continue;

          if (!Number.isInteger(slotIdx)) {
            console.log(`[CRAFT] Non-integer slot index: ${slotIdx}`);
            client.send("craft:reject", { reason: "bad_index" });
            return;
          }

          if (seen.has(slotIdx)) {
            console.log(`[CRAFT] Duplicate slot index rejected: ${slotIdx} (${client.sessionId})`);
            client.send("craft:reject", { reason: "duplicate_indices" });
            return;
          }
          seen.add(slotIdx);
        }
      }

      // 1) Resolve items from 3x3 grid
      const kinds: string[] = [];
      const validSlotIndices: number[] = [];

      ensureSlotsLength(p);

      for (let i = 0; i < 9; i++) {
        const slotIdx = indices[i];

        if (slotIdx === -1) {
          kinds.push("");
          continue;
        }

        if (slotIdx < 0 || slotIdx >= p.inventory.slots.length) {
          console.log(`[CRAFT] Index out of bounds: ${slotIdx}`);
          client.send("craft:reject", { reason: "out_of_bounds" });
          return;
        }

        const uid = p.inventory.slots[slotIdx];
        const item = uid ? p.items.get(uid) : null;

        if (!uid || !item) {
          console.log(`[CRAFT] Slot mismatch/empty: ${slotIdx}`);
          client.send("craft:reject", { reason: "slot_empty" });
          return;
        }

        kinds.push(String(item.kind || ""));
        validSlotIndices.push(slotIdx);
      }

      // 2) Check match
      const match = CraftingSystem.findMatch(kinds);
      if (!match) {
        console.log(`[CRAFT] No match for ${client.sessionId}`);
        client.send("craft:reject", { reason: "no_match" });
        return;
      }

      // 3) Consume ingredients (1 from each used slot)
      for (const slotIdx of validSlotIndices) {
        const uid = p.inventory.slots[slotIdx];
        const it = uid ? p.items.get(uid) : null;
        if (it) {
          it.qty -= 1;
          if ((it.qty || 0) <= 0) {
            p.inventory.slots[slotIdx] = "";
            p.items.delete(uid);
          }
        }
      }

      // 4) Add result
      addKindToInventory(p, String(match.result.kind || ""), Number(match.result.qty || 1));
      syncEquipToolToHotbar(p);

      console.log(`[CRAFT] ${client.sessionId} crafted ${match.result.kind} x${match.result.qty}`);
      client.send("craft:success", { item: match.result.kind });
    });

    // --------------------------------------------------------
    // World & Block Handlers
    // --------------------------------------------------------

    this.onMessage("world:patch:req", (client: Client, msg: WorldPatchReqMsg) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;

      const cx = sanitizeInt(msg?.x, Math.floor(p.x));
      const cy = sanitizeInt(msg?.y, Math.floor(p.y));
      const cz = sanitizeInt(msg?.z, Math.floor(p.z));

      const r = clamp(Math.floor(Number(msg?.r ?? 64)), 8, 512);
      const limit = clamp(Math.floor(Number(msg?.limit ?? 5000)), 100, 50000);

      const patch = MyRoom.WORLD.encodePatchAround({ x: cx, y: cy, z: cz }, r, { limit });
      client.send("world:patch", patch);
    });

    const BLOCK_REACH = 7.5;
    const BLOCK_OP_COOLDOWN_MS = 90;
    const MAX_COORD = 100000;

    const canOpNow = (sid: string) => {
      const t = nowMs();
      const last = this.lastBlockOpAt.get(sid) || 0;
      if (t - last < BLOCK_OP_COOLDOWN_MS) return false;
      this.lastBlockOpAt.set(sid, t);
      return true;
    };

    const withinWorld = (x: number, y: number, z: number) => {
      return (
        x >= -MAX_COORD &&
        x <= MAX_COORD &&
        y >= -MAX_COORD &&
        y <= MAX_COORD &&
        z >= -MAX_COORD &&
        z <= MAX_COORD
      );
    };

    const reject = (client: Client, reason: string, extra?: any) => {
      client.send("block:reject", { reason, ...(extra || {}) });
    };

    this.onMessage("block:break", (client: Client, msg: BlockBreakMsg) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      const src = String(msg?.src || "unknown");

      if (!canOpNow(client.sessionId)) {
        reject(client, "rate_limited", { op: "break", src });
        return;
      }

      if (!isValidBlockCoord(msg?.x) || !isValidBlockCoord(msg?.y) || !isValidBlockCoord(msg?.z)) return;
      const x = sanitizeInt(msg.x, 0);
      const y = sanitizeInt(msg.y, 0);
      const z = sanitizeInt(msg.z, 0);

      if (!withinWorld(x, y, z)) {
        reject(client, "out_of_bounds", { op: "break", src });
        return;
      }

      const d = dist3(p.x, p.y + 1.6, p.z, x + 0.5, y + 0.5, z + 0.5);
      if (d > BLOCK_REACH) {
        reject(client, "too_far", { op: "break", src, d });
        return;
      }

      const prevId = MyRoom.WORLD.getBlock(x, y, z);
      if (prevId === BLOCKS.AIR) {
        reject(client, "nothing_to_break", { op: "break", src });
        return;
      }

      // Apply break
      const { newId } = MyRoom.WORLD.applyBreak(x, y, z);

      // Drop the broken block kind (simple drop model)
      const kind = blockIdToKind(prevId);
      if (kind) addKindToInventory(p, kind, 1);

      this.broadcast("block:update", { x, y, z, id: newId });
      console.log(`[WORLD] break by ${client.sessionId} at ${x},${y},${z}`);
    });

    this.onMessage("block:place", (client: Client, msg: BlockPlaceMsg) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      const src = String(msg?.src || "unknown");

      if (!canOpNow(client.sessionId)) {
        reject(client, "rate_limited", { op: "place", src });
        return;
      }

      if (!isValidBlockCoord(msg?.x) || !isValidBlockCoord(msg?.y) || !isValidBlockCoord(msg?.z)) return;
      const x = sanitizeInt(msg.x, 0);
      const y = sanitizeInt(msg.y, 0);
      const z = sanitizeInt(msg.z, 0);

      if (!withinWorld(x, y, z)) {
        reject(client, "out_of_bounds", { op: "place", src });
        return;
      }

      const d = dist3(p.x, p.y + 1.6, p.z, x + 0.5, y + 0.5, z + 0.5);
      if (d > BLOCK_REACH) {
        reject(client, "too_far", { op: "place", src, d });
        return;
      }

      const existing = MyRoom.WORLD.getBlock(x, y, z);
      if (existing !== BLOCKS.AIR) {
        reject(client, "occupied", { op: "place", src, existing });
        return;
      }

      // SERVER-AUTHORITATIVE: derive placed block kind from hotbar, ignore msg.kind
      const hotbarKind = getHotbarBlockKind(p);
      if (!isBlockKind(hotbarKind)) {
        reject(client, "no_blocks_in_hotbar", { op: "place", src });
        return;
      }

      const blockId = kindToBlockId(hotbarKind);
      if (blockId === BLOCKS.AIR) {
        reject(client, "unknown_block_kind", { op: "place", src, kind: hotbarKind });
        return;
      }

      // Consume from hotbar AFTER validation
      const took = consumeFromHotbar(p, 1);
      if (took <= 0) {
        reject(client, "no_blocks_in_hotbar", { op: "place", src });
        return;
      }

      // Apply place
      const { newId } = MyRoom.WORLD.applyPlace(x, y, z, blockId);
      this.broadcast("block:update", { x, y, z, id: newId });
      console.log(`[WORLD] place by ${client.sessionId} at ${x},${y},${z} (${hotbarKind})`);
    });

    this.onMessage("hello", (client: Client, _message: any) => {
      client.send("hello_ack", { ok: true, serverTime: Date.now() });
    });
  }

  public onJoin(client: Client, options: JoinOptions) {
    console.log(client.sessionId, "joined!", "options:", options);

    // 1) Identify user (persistent)
    const distinctId = String(options.distinctId || client.sessionId);

    // store auth for onLeave
    (client as any).auth = { distinctId };

    const p = new PlayerState();

    // IMPORTANT: PlayerState.id is persistent distinct id (not session id)
    p.id = distinctId;
    p.name = String(options.name || "Steve").trim().substring(0, 16);

    // 2) Try to load saved data
    const saved = this.loadPlayerData(distinctId);

    if (saved) {
      console.log(`[PERSIST] Restoring player ${distinctId}...`);
      p.x = isFiniteNum(saved.x) ? saved.x : 0;
      p.y = isFiniteNum(saved.y) ? saved.y : 10;
      p.z = isFiniteNum(saved.z) ? saved.z : 0;
      p.yaw = isFiniteNum(saved.yaw) ? saved.yaw : 0;
      p.pitch = isFiniteNum(saved.pitch) ? saved.pitch : 0;
      p.hp = isFiniteNum(saved.hp) ? saved.hp : 20;
      p.stamina = isFiniteNum(saved.stamina) ? saved.stamina : 100;
      p.hotbarIndex = Number.isFinite(saved.hotbarIndex) ? saved.hotbarIndex : 0;

      // Restore items
      (saved.items || []).forEach((savedItem: any) => {
        const it = new ItemState();
        it.uid = String(savedItem.uid || "");
        it.kind = String(savedItem.kind || "");
        it.qty = Number(savedItem.qty || 0);
        it.durability = Number(savedItem.durability || 0);
        it.maxDurability = Number(
          savedItem.maxDurability || (String(savedItem.kind || "").startsWith("tool:") ? 100 : 0)
        );
        it.meta = String(savedItem.meta || "");
        if (it.uid) p.items.set(it.uid, it);
      });

      // Restore inventory grid
      p.inventory.cols = 9;
      p.inventory.rows = 4;
      ensureSlotsLength(p);
      (saved.inventory || []).forEach((uid: string, idx: number) => {
        if (idx < p.inventory.slots.length) p.inventory.slots[idx] = String(uid || "");
      });

      // Restore equip
      if (saved.equip) {
        p.equip.tool = String(saved.equip.tool || "");
        p.equip.head = String(saved.equip.head || "");
        p.equip.chest = String(saved.equip.chest || "");
        p.equip.legs = String(saved.equip.legs || "");
        p.equip.feet = String(saved.equip.feet || "");
        p.equip.offhand = String(saved.equip.offhand || "");
      }
    } else {
      // 3) New player setup (starter gear)
      console.log(`[PERSIST] New player ${distinctId}, giving starter gear.`);
      p.x = 0;
      p.y = 10;
      p.z = 0;
      p.yaw = 0;
      p.pitch = 0;
      p.maxHp = 20;
      p.hp = 20;
      p.maxStamina = 100;
      p.stamina = 100;

      p.inventory.cols = 9;
      p.inventory.rows = 4;
      ensureSlotsLength(p);
      p.hotbarIndex = 0;

      const add = (kind: string, qty: number, slotIdx: number) => {
        const uid = makeUid(distinctId, kind.split(":")[1] || "item");
        const it = new ItemState();
        it.uid = uid;
        it.kind = kind;
        it.qty = qty;
        if (kind.startsWith("tool:")) {
          it.durability = 100;
          it.maxDurability = 100;
        }
        p.items.set(uid, it);
        p.inventory.slots[slotIdx] = uid;
      };

      add("tool:pickaxe_wood", 1, 0);
      add("block:dirt", 32, 1);
      add("block:grass", 16, 2);

      // Bonus starter: planks + sticks for crafting tests
      add("block:plank", 8, 3);
      add("item:stick", 8, 4);
    }

    syncEquipToolToHotbar(p);
    this.state.players.set(client.sessionId, p);

    // welcome (client can register handler)
    client.send("welcome", { roomId: this.roomId, sessionId: client.sessionId });

    // Initial patch around spawn (ints are safer)
    const patch = MyRoom.WORLD.encodePatchAround(
      { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) },
      96,
      { limit: 8000 }
    );
    client.send("world:patch", patch);
  }

  public onLeave(client: Client, code: number) {
    console.log(client.sessionId, "left", code);

    const p = this.state.players.get(client.sessionId);
    const distinctId = (client as any).auth?.distinctId;

    if (p && distinctId) {
      this.savePlayerData(String(distinctId), p);
    }

    this.state.players.delete(client.sessionId);
    this.lastBlockOpAt.delete(client.sessionId);
  }

  public onDispose() {
    console.log("Room disposing...");

    // Force Save on Shutdown
    try {
      if (MyRoom.WORLD.isDirty()) {
        console.log("[PERSISTENCE] Saving world before shutdown...");
        MyRoom.WORLD.saveToFileSync(this.worldPath);
        console.log("[PERSISTENCE] Saved.");
      }
    } catch (e) {
      console.error("[PERSISTENCE] Save failed on dispose:", e);
    }
  }
}
