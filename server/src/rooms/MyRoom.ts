// ============================================================
// rooms/MyRoom.ts  (FULL REWRITE - NO OMITS)
// ------------------------------------------------------------
// Option B (Minecraft-style crafting container):
// - Crafting grid is a REAL 3x3 container on PlayerState: p.craft.slots[0..8]
// - Craft preview/result is server-derived: p.craft.resultKind/resultQty/recipeId
// - Clicking result triggers server action "craft:take" (consumes from craft grid)
// - Inventory + equipment logic preserved
// - Added hardening fixes:
//   * Block placement consumes EXACT kind from hotbar (prevents kind spoof)
//   * Crafting uses craft grid state only (no client index mapping)
// ============================================================

import { Room, Client } from "colyseus";
import * as fs from "fs";
import * as path from "path";

// Imports with .js extensions for Node16/NodeNext resolution
import { WorldStore, BLOCKS, type BlockId } from "../world/WorldStore.js";
import {
  MyRoomState,
  PlayerState,
  ItemState,
  InventoryState,
  EquipmentState,
} from "./schema/MyRoomState.js";
import { CraftingSystem } from "../crafting/CraftingSystem.js";
import type { CraftingRecipe } from "../crafting/Recipes.js";

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

// Option B: client clicks crafting result (server authoritative)
type CraftTakeMsg = {};

// World/block messages
type BlockBreakMsg = { x: number; y: number; z: number; src?: string };
type BlockPlaceMsg = { x: number; y: number; z: number; kind: string; src?: string };

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
type CraftKey = { kind: "craft"; index: number };

type SlotRef =
  | { kind: "inv"; index: number }
  | { kind: "eq"; key: EquipKey }
  | CraftKey;

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

  if (s.startsWith("craft:")) {
    const idx = Number(s.slice(6));
    if (!Number.isInteger(idx) || idx < 0 || idx > 8) return null;
    return { kind: "craft", index: idx };
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

function ensureCraftSlotsLength(p: PlayerState) {
  // Craft slots always 9
  while (p.craft.slots.length < 9) p.craft.slots.push("");
  while (p.craft.slots.length > 9) p.craft.slots.pop();
}

function getSlotUid(p: PlayerState, slot: SlotRef): string {
  if (slot.kind === "inv") {
    ensureSlotsLength(p);
    const total = getTotalSlots(p);
    if (slot.index < 0 || slot.index >= total) return "";
    return String(p.inventory.slots[slot.index] || "");
  } else if (slot.kind === "eq") {
    return String((p.equip as any)[slot.key] || "");
  } else {
    ensureCraftSlotsLength(p);
    if (slot.index < 0 || slot.index >= 9) return "";
    return String(p.craft.slots[slot.index] || "");
  }
}

function setSlotUid(p: PlayerState, slot: SlotRef, uid: string) {
  uid = uid ? String(uid) : "";
  if (slot.kind === "inv") {
    ensureSlotsLength(p);
    const total = getTotalSlots(p);
    if (slot.index < 0 || slot.index >= total) return;
    p.inventory.slots[slot.index] = uid;
  } else if (slot.kind === "eq") {
    (p.equip as any)[slot.key] = uid;
  } else {
    ensureCraftSlotsLength(p);
    if (slot.index < 0 || slot.index >= 9) return;
    p.craft.slots[slot.index] = uid;
  }
}

// ------------------------------------------------------------
// Item Rules
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

  // 1. Stack into existing slots
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

  // 2. Create new stacks in empty slots
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

function canAddKindToInventory(p: PlayerState, kind: string, qty: number) {
  ensureSlotsLength(p);
  if (!kind || qty <= 0) return true;

  const maxStack = maxStackForKind(kind);
  let remaining = qty;

  // Space in existing stacks
  if (maxStack > 1) {
    for (let i = 0; i < p.inventory.slots.length; i++) {
      const uid = String(p.inventory.slots[i] || "");
      if (!uid) continue;
      const it = p.items.get(uid);
      if (!it) continue;
      if (String(it.kind || "") !== kind) continue;

      const cur = isFiniteNum(it.qty) ? it.qty : 0;
      const space = Math.max(0, maxStack - cur);
      if (space <= 0) continue;

      const take = Math.min(space, remaining);
      remaining -= take;
      if (remaining <= 0) return true;
    }
  }

  // Space in empty slots
  const empties = p.inventory.slots.reduce((acc, uid) => acc + (!String(uid || "") ? 1 : 0), 0);
  const perSlot = Math.max(1, maxStack);
  const capacityFromEmpties = empties * perSlot;

  return remaining <= capacityFromEmpties;
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

// IMPORTANT: server must only consume the exact kind being placed
function consumeSpecificFromHotbar(p: PlayerState, kind: string, qty: number) {
  ensureSlotsLength(p);

  const idx = normalizeHotbarIndex(p.hotbarIndex);
  const uid = String(p.inventory.slots[idx] || "");
  if (!uid) return 0;

  const it = p.items.get(uid);
  if (!it) return 0;

  const curKind = String(it.kind || "");
  if (curKind !== kind) return 0;
  if (!isBlockKind(curKind)) return 0;

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
// Crafting Helpers (Option B)
// ------------------------------------------------------------

function getCraftKinds(p: PlayerState): string[] {
  ensureCraftSlotsLength(p);
  const kinds: string[] = new Array(9).fill("");
  for (let i = 0; i < 9; i++) {
    const uid = String(p.craft.slots[i] || "");
    if (!uid) {
      kinds[i] = "";
      continue;
    }
    const it = p.items.get(uid);
    kinds[i] = it ? String(it.kind || "") : "";
  }
  return kinds;
}

function recomputeCraftResult(p: PlayerState) {
  ensureCraftSlotsLength(p);

  const kinds = getCraftKinds(p);
  const match = CraftingSystem.findMatch(kinds);

  if (!match) {
    p.craft.resultKind = "";
    p.craft.resultQty = 0;
    p.craft.recipeId = "";
    return;
  }

  p.craft.resultKind = String(match.result.kind || "");
  p.craft.resultQty = isFiniteNum(match.result.qty) ? match.result.qty : 1;
  p.craft.recipeId = String(match.id || "");
}

function craftTrimMatrixWithBounds(matrix: string[][]): { trimmed: string[][]; minR: number; minC: number } | null {
  let minR = 3,
    maxR = -1,
    minC = 3,
    maxC = -1;

  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      if (matrix[r][c] !== "") {
        if (r < minR) minR = r;
        if (r > maxR) maxR = r;
        if (c < minC) minC = c;
        if (c > maxC) maxC = c;
      }
    }
  }

  if (maxR === -1) return null;

  const trimmed: string[][] = [];
  for (let r = minR; r <= maxR; r++) {
    const row: string[] = [];
    for (let c = minC; c <= maxC; c++) row.push(matrix[r][c]);
    trimmed.push(row);
  }

  return { trimmed, minR, minC };
}

function patternToMatrixAndTrimWithBounds(pattern: string[]): { trimmed: string[][]; minR: number; minC: number } | null {
  const maxW = Math.max(...pattern.map((r) => r.length));
  const raw = pattern.map((row) => row.padEnd(maxW, " ").split(""));

  const H = raw.length;
  const W = maxW;

  let minR = H,
    maxR = -1,
    minC = W,
    maxC = -1;

  // treat " " as empty
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      if (raw[r][c] !== " ") {
        if (r < minR) minR = r;
        if (r > maxR) maxR = r;
        if (c < minC) minC = c;
        if (c > maxC) maxC = c;
      }
    }
  }

  if (maxR === -1) return null;

  const trimmed: string[][] = [];
  for (let r = minR; r <= maxR; r++) {
    const row: string[] = [];
    for (let c = minC; c <= maxC; c++) row.push(raw[r][c]);
    trimmed.push(row);
  }

  return { trimmed, minR, minC };
}

/**
 * Consume recipe ingredients from the player's REAL craft grid (p.craft.slots).
 * Assumes recipe match is valid; still performs safety checks.
 */
function consumeCraftIngredients(p: PlayerState, recipe: CraftingRecipe): boolean {
  ensureCraftSlotsLength(p);

  const kinds = getCraftKinds(p);

  // Build 3x3 matrix of kinds
  const inputMatrix: string[][] = [
    [kinds[0], kinds[1], kinds[2]],
    [kinds[3], kinds[4], kinds[5]],
    [kinds[6], kinds[7], kinds[8]],
  ];

  if (recipe.type === "shapeless") {
    if (!recipe.ingredients) return false;

    // Build list of craft indices with their kind
    const available: { idx: number; kind: string }[] = [];
    for (let i = 0; i < 9; i++) {
      const k = kinds[i];
      if (k) available.push({ idx: i, kind: k });
    }

    // Must be exact count like matcher does
    if (available.length !== recipe.ingredients.length) return false;

    // For each required ingredient, find a distinct craft slot
    const used = new Set<number>();
    const toConsume: number[] = [];

    for (const req of recipe.ingredients) {
      let found = -1;
      for (const a of available) {
        if (used.has(a.idx)) continue;
        if (a.kind === req) {
          found = a.idx;
          break;
        }
      }
      if (found === -1) return false;
      used.add(found);
      toConsume.push(found);
    }

    // Consume 1 from each chosen craft slot
    for (const craftIdx of toConsume) {
      const uid = String(p.craft.slots[craftIdx] || "");
      if (!uid) return false;
      const it = p.items.get(uid);
      if (!it) return false;

      const cur = isFiniteNum(it.qty) ? it.qty : 0;
      if (cur <= 0) return false;

      it.qty = cur - 1;
      if (it.qty <= 0) {
        p.craft.slots[craftIdx] = "";
        p.items.delete(uid);
      }
    }

    return true;
  }

  // Shaped
  if (!recipe.pattern || !recipe.key) return false;

  const inTrim = craftTrimMatrixWithBounds(inputMatrix);
  const patTrim = patternToMatrixAndTrimWithBounds(recipe.pattern);

  if (!inTrim || !patTrim) return false;

  // Dimensions should match if recipe matched
  if (inTrim.trimmed.length !== patTrim.trimmed.length) return false;
  if (inTrim.trimmed[0].length !== patTrim.trimmed[0].length) return false;

  // Consume where pattern has non-space characters (using input bounding box offset)
  for (let r = 0; r < patTrim.trimmed.length; r++) {
    for (let c = 0; c < patTrim.trimmed[0].length; c++) {
      const ch = patTrim.trimmed[r][c];
      if (ch === " ") continue;

      const expectedKind = recipe.key[ch];
      if (!expectedKind) return false;

      const absR = inTrim.minR + r;
      const absC = inTrim.minC + c;
      const craftIdx = absR * 3 + absC;
      if (craftIdx < 0 || craftIdx > 8) return false;

      const uid = String(p.craft.slots[craftIdx] || "");
      if (!uid) return false;

      const it = p.items.get(uid);
      if (!it) return false;

      if (String(it.kind || "") !== expectedKind) return false;

      const cur = isFiniteNum(it.qty) ? it.qty : 0;
      if (cur <= 0) return false;

      it.qty = cur - 1;
      if (it.qty <= 0) {
        p.craft.slots[craftIdx] = "";
        p.items.delete(uid);
      }
    }
  }

  return true;
}

// ------------------------------------------------------------
// Block Mapping
// ------------------------------------------------------------

function kindToBlockId(kind: string): BlockId {
  if (kind === "block:dirt") return BLOCKS.DIRT;
  if (kind === "block:grass") return BLOCKS.GRASS;
  if (kind === "block:stone") return 3;
  if (kind === "block:bedrock") return 4;
  if (kind === "block:log") return 5;
  if (kind === "block:leaves") return 6;
  if (kind === "block:plank") return 7;
  return BLOCKS.AIR;
}

function blockIdToKind(id: BlockId): string {
  if (id === BLOCKS.DIRT) return "block:dirt";
  if (id === BLOCKS.GRASS) return "block:grass";
  if (id === 3) return "block:stone";
  if (id === 4) return "block:bedrock";
  if (id === 5) return "block:log";
  if (id === 6) return "block:leaves";
  if (id === 7) return "block:plank";
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

// ------------------------------------------------------------
// Room Implementation
// ------------------------------------------------------------

export class MyRoom extends Room {
  // Strongly type Colyseus state for this Room.
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
      } catch (e) {}
    }

    // Explicit conversion logic to avoid TS errors
    const itemsArray = Array.from(p.items.entries()).map((entry: any) => {
      const [uid, item] = entry;
      return { uid, kind: item.kind, qty: item.qty, durability: item.durability, maxDurability: item.maxDurability, meta: item.meta };
    });

    ensureSlotsLength(p);
    ensureCraftSlotsLength(p);

    // Serialize PlayerState to JSON
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
      craft: Array.from(p.craft.slots),
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

    // 1. Load World from Disk
    if (fs.existsSync(this.worldPath)) {
      console.log(`[PERSIST] Loading world from ${this.worldPath}...`);
      try {
        const loaded = MyRoom.WORLD.loadFromFileSync(this.worldPath);
        if (loaded) {
          console.log(`[PERSIST] Loaded ${MyRoom.WORLD.editsCount()} edits.`);
        } else {
          console.log(`[PERSIST] File existed but failed to load.`);
        }
      } catch (e) {
        console.error(`[PERSIST] Error loading world:`, e);
      }
    } else {
      console.log(`[PERSIST] No save file found at ${this.worldPath}. Starting fresh.`);
    }

    // 2. Configure Autosave
    MyRoom.WORLD.configureAutosave({
      path: this.worldPath,
      minIntervalMs: 30000,
    });

    // 3. Simulation Tick
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
        ensureCraftSlotsLength(p);

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

        // Keep craft preview accurate (items could be deleted by other logic)
        // This is cheap (9 slots) and avoids stale result
        recomputeCraftResult(p);
      });

      // Autosave triggered internally by WorldStore logic on dirty + time check
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
    // Inventory + Craft + Equip Handlers (Unified Move/Split)
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

    /**
     * Move items between:
     * - inv:* (inventory)
     * - eq:*  (equipment)
     * - craft:* (crafting grid)
     *
     * Supports:
     * - swap
     * - merge stacks (where maxStack > 1 and kinds match)
     * - equipment compatibility checks
     *
     * Crafting preview is recomputed when craft slots are involved.
     */
    this.onMessage("inv:move", (client: Client, msg: InvMoveMsg) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;

      const from = parseSlotRef(msg?.from);
      const to = parseSlotRef(msg?.to);
      if (!from || !to) return;

      ensureSlotsLength(p);
      ensureCraftSlotsLength(p);

      const total = getTotalSlots(p);

      if (from.kind === "inv" && (from.index < 0 || from.index >= total)) return;
      if (to.kind === "inv" && (to.index < 0 || to.index >= total)) return;

      if (from.kind === "craft" && (from.index < 0 || from.index >= 9)) return;
      if (to.kind === "craft" && (to.index < 0 || to.index >= 9)) return;

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

      // If moving to craft slot, allow anything (blocks/items/tools) by default.
      // If you want to restrict (e.g., only craftable ingredients), add checks here.

      // Empty destination: direct move
      if (!toUid) {
        setSlotUid(p, to, fromUid);
        setSlotUid(p, from, "");
        syncEquipToolToHotbar(p);

        // Craft preview update if craft involved
        if (from.kind === "craft" || to.kind === "craft") recomputeCraftResult(p);
        return;
      }

      // Empty source: direct move (rare, but symmetric)
      if (!fromUid) {
        setSlotUid(p, from, toUid);
        setSlotUid(p, to, "");
        syncEquipToolToHotbar(p);

        if (from.kind === "craft" || to.kind === "craft") recomputeCraftResult(p);
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
            if (from.kind === "craft" || to.kind === "craft") recomputeCraftResult(p);
            return;
          }
        }
      }

      // Direct swap
      setSlotUid(p, to, fromUid);
      setSlotUid(p, from, toUid);
      syncEquipToolToHotbar(p);

      if (from.kind === "craft" || to.kind === "craft") recomputeCraftResult(p);
    });

    /**
     * Split a stack in an inventory slot into an empty inventory slot.
     * (Original behavior preserved: only supports inv slots, not craft slots.)
     * If you'd like Minecraft-style right-click behavior into craft slots, we'll add a separate message for it.
     */
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
    // Crafting Handler (Option B)
    // --------------------------------------------------------

    /**
     * Client clicks the crafting result slot.
     * Server validates current craft grid, consumes ingredients from craft grid,
     * and adds the result to inventory (if there is space).
     */
    this.onMessage("craft:take", (client: Client, _msg: CraftTakeMsg) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;

      ensureCraftSlotsLength(p);
      ensureSlotsLength(p);

      // Recompute to ensure preview is current and authoritative
      recomputeCraftResult(p);

      const resultKind = String(p.craft.resultKind || "");
      const resultQty = isFiniteNum(p.craft.resultQty) ? p.craft.resultQty : 0;

      if (!resultKind || resultQty <= 0) {
        console.log(`[CRAFT] No craft result for ${client.sessionId}`);
        client.send("craft:reject", { reason: "no_result" });
        return;
      }

      // Find the matching recipe based on current craft grid
      const kinds = getCraftKinds(p);
      const match = CraftingSystem.findMatch(kinds);

      if (!match) {
        // Preview stale or manipulated
        p.craft.resultKind = "";
        p.craft.resultQty = 0;
        p.craft.recipeId = "";
        client.send("craft:reject", { reason: "no_match" });
        return;
      }

      // Ensure the match result equals the preview (consistency)
      if (String(match.result.kind || "") !== resultKind || (match.result.qty || 0) !== resultQty) {
        recomputeCraftResult(p);
        client.send("craft:reject", { reason: "result_changed" });
        return;
      }

      // Ensure inventory has space BEFORE consuming
      if (!canAddKindToInventory(p, resultKind, resultQty)) {
        client.send("craft:reject", { reason: "inventory_full" });
        return;
      }

      // Consume from craft grid
      const ok = consumeCraftIngredients(p, match);
      if (!ok) {
        // If consumption failed, recompute preview and reject
        recomputeCraftResult(p);
        client.send("craft:reject", { reason: "consume_failed" });
        return;
      }

      // Add result
      const added = addKindToInventory(p, resultKind, resultQty);
      if (added !== resultQty) {
        // This should not happen due to canAddKindToInventory, but keep it safe:
        // We do not attempt rollback here; we just warn and resync via recompute.
        console.warn(`[CRAFT] Unexpected partial add for ${client.sessionId}: ${added}/${resultQty}`);
      }

      syncEquipToolToHotbar(p);
      recomputeCraftResult(p);

      console.log(`[CRAFT] ${client.sessionId} crafted ${resultKind} x${resultQty}`);
      client.send("craft:success", { item: resultKind, qty: resultQty });
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

      // Add item
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

      const kind = String(msg?.kind || "");
      if (!isBlockKind(kind)) {
        reject(client, "not_a_block_item", { op: "place", src, kind });
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

      const blockId = kindToBlockId(kind);
      if (blockId === BLOCKS.AIR) {
        reject(client, "unknown_block_kind", { op: "place", src, kind });
        return;
      }

      // Consume EXACT kind from hotbar (prevents spoof)
      const took = consumeSpecificFromHotbar(p, kind, 1);
      if (took <= 0) {
        reject(client, "no_matching_block_in_hotbar", { op: "place", src, kind });
        return;
      }

      // Apply place
      const { newId } = MyRoom.WORLD.applyPlace(x, y, z, blockId);
      this.broadcast("block:update", { x, y, z, id: newId });
      console.log(`[WORLD] place by ${client.sessionId} at ${x},${y},${z}`);
    });

    this.onMessage("hello", (client: Client, _message: any) => {
      client.send("hello_ack", { ok: true, serverTime: Date.now() });
    });
  }

  public onJoin(client: Client, options: JoinOptions) {
    console.log(client.sessionId, "joined!", "options:", options);

    // 1. Identify the user (use persistent ID or fallback to session ID)
    const distinctId = options.distinctId || client.sessionId;

    // Store distinctId on the client object for later use in onLeave
    (client as any).auth = { distinctId };

    const p = new PlayerState();
    p.id = client.sessionId;
    p.name = (options.name || "Steve").trim().substring(0, 16);

    // 2. Try to Load Saved Data
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
      p.hotbarIndex = saved.hotbarIndex || 0;

      // Restore Items
      (saved.items || []).forEach((savedItem: any) => {
        const it = new ItemState();
        it.uid = savedItem.uid;
        it.kind = savedItem.kind;
        it.qty = savedItem.qty;
        it.durability = savedItem.durability || 0;
        it.maxDurability = savedItem.maxDurability || (savedItem.kind?.startsWith("tool:") ? 100 : 0);
        it.meta = savedItem.meta || "";
        p.items.set(it.uid, it);
      });

      // Restore Inventory Grid
      p.inventory.cols = 9;
      p.inventory.rows = 4;
      ensureSlotsLength(p); // Ensure array exists first
      (saved.inventory || []).forEach((uid: string, idx: number) => {
        if (idx < p.inventory.slots.length) p.inventory.slots[idx] = uid;
      });

      // Restore Craft Grid (Option B)
      ensureCraftSlotsLength(p);
      (saved.craft || []).forEach((uid: string, idx: number) => {
        if (idx >= 0 && idx < 9) p.craft.slots[idx] = String(uid || "");
      });

      // Restore Equip
      if (saved.equip) {
        p.equip.tool = saved.equip.tool || "";
        p.equip.head = saved.equip.head || "";
        p.equip.chest = saved.equip.chest || "";
        p.equip.legs = saved.equip.legs || "";
        p.equip.feet = saved.equip.feet || "";
        p.equip.offhand = saved.equip.offhand || "";
      }
    } else {
      // 3. New Player Setup (Starter Gear)
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

      ensureCraftSlotsLength(p);

      const add = (kind: string, qty: number, slotIdx: number) => {
        const uid = makeUid(client.sessionId, kind.split(":")[1] || "item");
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
    }

    syncEquipToolToHotbar(p);
    recomputeCraftResult(p);

    this.state.players.set(client.sessionId, p);

    client.send("welcome", { roomId: this.roomId, sessionId: client.sessionId });

    // Initial patch around spawn
    const patch = MyRoom.WORLD.encodePatchAround({ x: p.x, y: p.y, z: p.z }, 96, { limit: 8000 });
    client.send("world:patch", patch);
  }

  public onLeave(client: Client, code: number) {
    console.log(client.sessionId, "left", code);

    const p = this.state.players.get(client.sessionId);
    const distinctId = (client as any).auth?.distinctId;

    if (p && distinctId) {
      this.savePlayerData(distinctId, p);
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
