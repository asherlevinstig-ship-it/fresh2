// ============================================================
// src/rooms/MyRoom.ts
// ------------------------------------------------------------
// FULL REWRITE - "RACE CONDITION FIX" EDITION
//
// CHANGES:
// - REMOVED: Server no longer pushes "world:patch" in onJoin.
//   (This prevents the "onMessage not registered" error).
// - KEPT: Spawn debug logging and safe spawn logic.
// - FLOW: Client now requests the patch via "welcome" -> "world:patch:req".
// ============================================================

import { Room, Client } from "colyseus";
import * as fs from "fs";
import * as path from "path";

// World & State Imports
import { WorldStore, BLOCKS, type BlockId } from "../world/WorldStore.js";
import { MyRoomState, PlayerState, ItemState, MobState } from "./schema/MyRoomState.js";
import { CraftingSystem } from "../crafting/CraftingSystem.js";

// Town Stamp Logic
import {
  stampTownOfBeginnings,
  inTownSafeZone,
  TOWN_GROUND_Y,
  TOWN_SAFE_ZONE,
} from "../world/regions/applyBlueprint.js";

// Biome & Generation Logic
import {
  sampleBiome,
  getTerrainLayerBlockId,
  pickOreId,
  buildDefaultOreTablesFromPalette,
  type OreTables,
} from "../world/Biomes.js";

// ------------------------------------------------------------
// Message Data Types
// ------------------------------------------------------------

type JoinOptions = { name?: string; distinctId?: string };

type MoveMsg = {
  x: number;
  y: number;
  z: number;
  yaw?: number;
  pitch?: number;
};

type ChatMsg = { text: string };
type SprintMsg = { on: boolean };
type HotbarSetMsg = { index: number };

type InvClickMsg = {
  location: "inv" | "craft" | "result";
  index: number;
  button: number; // 0 = Left, 1 = Right
};

type InvConsumeHotbarMsg = { qty?: number };
type InvAddMsg = { kind: string; qty?: number };

type BlockBreakMsg = { x: number; y: number; z: number; src?: string };
type BlockPlaceMsg = { x: number; y: number; z: number; kind: string; src?: string };
type WorldPatchReqMsg = { x: number; y: number; z: number; r?: number; limit?: number };

// ------------------------------------------------------------
// Utility Functions
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

function readJsonFileSafe(filePath: string): any | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    console.error(`[PERSIST] Failed to read/parse JSON: ${filePath}`, e);
    return null;
  }
}

function writeJsonAtomic(filePath: string, data: any) {
  const dir = path.dirname(filePath);
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch {}

  const tmp = `${filePath}.tmp.${process.pid}.${Math.floor(Math.random() * 1e9)}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    try {
      fs.renameSync(tmp, filePath);
    } catch {
      fs.copyFileSync(tmp, filePath);
      fs.unlinkSync(tmp);
    }
  } catch (e) {
    console.error(`[PERSIST] Write atomic failed for ${filePath}`, e);
  }
}

function findSpawnYAt(world: WorldStore, x: number, z: number, preferredY: number) {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const MIN_Y = -64;
  const MAX_Y = 256;

  // Start searching a bit above the preferred Y to catch surface
  const searchStart = clamp(Math.floor(preferredY) + 10, MIN_Y, MAX_Y);
  
  for (let y = searchStart; y >= MIN_Y; y--) {
    const id = world.getBlock(ix, y, iz);
    if (id !== BLOCKS.AIR) {
        return y + 2;
    }
  }
  return preferredY;
}

// ------------------------------------------------------------
// Biome Seeker
// ------------------------------------------------------------

function findNearestBiome(startX: number, startZ: number, target: string): { x: number, z: number, biome: string } | null {
  const step = 64;
  const maxRadius = 5000;
  const targetLower = target.toLowerCase();

  const initial = sampleBiome(startX, startZ);
  if (initial.biome.toLowerCase().includes(targetLower)) return { x: startX, z: startZ, biome: initial.biome };

  for (let r = step; r <= maxRadius; r += step) {
    const points = 16;
    for (let i = 0; i < points; i++) {
      const angle = (Math.PI * 2 * i) / points;
      const x = startX + Math.cos(angle) * r;
      const z = startZ + Math.sin(angle) * r;
      const sample = sampleBiome(x, z);
      
      if (sample.biome.toLowerCase().includes(targetLower)) {
        return { x, z, biome: sample.biome };
      }
    }
  }
  return null;
}

// ------------------------------------------------------------
// Inventory Logic & Helpers
// ------------------------------------------------------------

type EquipKey = "head" | "chest" | "legs" | "feet" | "tool" | "offhand";

function getTotalSlots(p: PlayerState) {
  const cols = isFiniteNum(p.inventory?.cols) ? p.inventory.cols : 9;
  const rows = isFiniteNum(p.inventory?.rows) ? p.inventory.rows : 4;
  return Math.max(1, cols * rows);
}

function ensureSlotsLength(p: PlayerState) {
  const total = getTotalSlots(p);
  while (p.inventory.slots.length < total) p.inventory.slots.push("");
  while (p.inventory.slots.length > total) p.inventory.slots.pop();
  
  while (p.craft.slots.length < 9) p.craft.slots.push("");
  while (p.craft.slots.length > 9) p.craft.slots.pop();
}

function isEquipSlotCompatible(slotKey: EquipKey, itemKind: string) {
  if (!itemKind) return true;
  const k = itemKind.toLowerCase();

  if (slotKey === "tool") return k.startsWith("tool:") || k.includes("pickaxe") || k.includes("axe") || k.includes("sword") || k.includes("shovel") || k.includes("wand") || k.includes("club");
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
  if (k.startsWith("tool:") || k.includes("pickaxe") || k.includes("axe") || k.includes("sword") || k.includes("shovel") || k.includes("wand") || k.includes("club")) return 1;
  return 64;
}

function isBlockKind(kind: string) {
  return typeof kind === "string" && kind.startsWith("block:");
}

function normalizeHotbarIndex(i: any) {
  const n = Number(i);
  if (!Number.isFinite(n)) return 0;
  return clamp(Math.floor(n), 0, 8);
}

function syncEquipToolToHotbar(p: PlayerState) {
  ensureSlotsLength(p);
  const idx = normalizeHotbarIndex(p.hotbarIndex);
  const uid = String(p.inventory.slots[idx] || "");

  if (!uid) { p.equip.tool = ""; return; }
  const it = p.items.get(uid);
  if (!it) { p.equip.tool = ""; return; }
  if (!isEquipSlotCompatible("tool", String(it.kind || ""))) { p.equip.tool = ""; return; }
  p.equip.tool = uid;
}

function makeUid(sessionId: string, tag: string) {
  return `${sessionId}:${tag}:${nowMs()}:${Math.floor(Math.random() * 1e9)}`;
}

function createItem(p: PlayerState, kind: string, qty: number) {
  const uid = makeUid(p.id, "created");
  const it = new ItemState();
  it.uid = uid;
  it.kind = kind;
  it.qty = qty;
  if (kind.startsWith("tool:")) {
    it.durability = 100;
    it.maxDurability = 100;
  }
  p.items.set(uid, it);
  return uid;
}

function createItemFromCursor(p: PlayerState, cursor: any, qtyOverride?: number) {
    const uid = makeUid(p.id, "restored");
    const it = new ItemState();
    it.uid = uid;
    it.kind = cursor.kind;
    it.qty = qtyOverride !== undefined ? qtyOverride : cursor.qty;
    
    it.durability = cursor.durability || 0;
    it.maxDurability = cursor.maxDurability || 0;
    if (cursor.meta) {
        try { it.meta = JSON.parse(JSON.stringify(cursor.meta)); } catch {}
    }

    if (it.kind.startsWith("tool:") && it.maxDurability === 0) {
        it.maxDurability = 100;
        if (it.durability === 0) it.durability = 100;
    }

    p.items.set(uid, it);
    return uid;
}

function setCursorFromItem(p: PlayerState, item: ItemState, qty: number) {
    p.cursor.kind = item.kind;
    p.cursor.qty = qty;
    (p.cursor as any).durability = item.durability;
    (p.cursor as any).maxDurability = item.maxDurability;
    (p.cursor as any).meta = item.meta;
}

function deleteItem(p: PlayerState, uid: string) {
  if (uid && p.items.has(uid)) {
    p.items.delete(uid);
  }
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
  syncEquipToolToHotbar(p);
  return take;
}

function addKindToInventory(p: PlayerState, kind: string, qty: number) {
  ensureSlotsLength(p);
  if (!kind || qty <= 0) return 0;

  const maxStack = maxStackForKind(kind);
  let remaining = qty;

  for (let i = 0; i < p.inventory.slots.length; i++) {
    if (remaining <= 0) break;
    const uid = p.inventory.slots[i];
    if (!uid) continue;
    const it = p.items.get(uid);
    if (!it || it.kind !== kind) continue;
    
    if (it.durability < it.maxDurability) continue;

    const space = maxStack - it.qty;
    if (space > 0) {
      const add = Math.min(space, remaining);
      it.qty += add;
      remaining -= add;
    }
  }

  while (remaining > 0) {
    let emptyIdx = -1;
    for (let i = 0; i < p.inventory.slots.length; i++) {
      if (!p.inventory.slots[i]) {
        emptyIdx = i;
        break;
      }
    }
    if (emptyIdx === -1) break;

    const add = Math.min(maxStack, remaining);
    const newUid = createItem(p, kind, add);
    p.inventory.slots[emptyIdx] = newUid;
    remaining -= add;
  }
  
  syncEquipToolToHotbar(p);
  return qty - remaining;
}

function updateCraftingResult(p: PlayerState) {
  const kinds = p.craft.slots.map((uid) => {
    if (!uid) return "";
    const it = p.items.get(uid);
    return it ? it.kind : "";
  });

  const match = CraftingSystem.findMatch(kinds);

  if (match) {
    p.craft.resultKind = match.result.kind;
    p.craft.resultQty = match.result.qty;
    p.craft.recipeId = match.id || "unknown";
  } else {
    p.craft.resultKind = "";
    p.craft.resultQty = 0;
    p.craft.recipeId = "";
  }
}

// ------------------------------------------------------------
// Block Mapping
// ------------------------------------------------------------

function kindToBlockId(kind: string): BlockId {
  if (kind === "block:dirt") return BLOCKS.DIRT;
  if (kind === "block:grass") return BLOCKS.GRASS;
  if (kind === "block:stone") return BLOCKS.STONE;
  if (kind === "block:bedrock") return BLOCKS.BEDROCK;
  if (kind === "block:log") return BLOCKS.LOG;
  if (kind === "block:leaves") return BLOCKS.LEAVES;
  if (kind === "block:plank") return BLOCKS.PLANKS;

  if (kind === "block:sand") return BLOCKS.SAND;
  if (kind === "block:snow") return BLOCKS.SNOW;
  if (kind === "block:clay") return BLOCKS.CLAY;
  if (kind === "block:gravel") return BLOCKS.GRAVEL;
  if (kind === "block:mud") return BLOCKS.MUD;
  if (kind === "block:ice") return BLOCKS.ICE;

  if (kind === "block:coal_ore") return BLOCKS.COAL_ORE;
  if (kind === "block:copper_ore") return BLOCKS.COPPER_ORE;
  if (kind === "block:iron_ore") return BLOCKS.IRON_ORE;
  if (kind === "block:silver_ore") return BLOCKS.SILVER_ORE;
  if (kind === "block:gold_ore") return BLOCKS.GOLD_ORE;
  if (kind === "block:ruby_ore") return BLOCKS.RUBY_ORE;
  if (kind === "block:sapphire_ore") return BLOCKS.SAPPHIRE_ORE;
  if (kind === "block:mythril_ore") return BLOCKS.MYTHRIL_ORE;
  if (kind === "block:dragonstone") return BLOCKS.DRAGONSTONE;

  if (kind === "block:crafting_table") return BLOCKS.CRAFTING_TABLE;
  if (kind === "block:chest") return BLOCKS.CHEST;
  if (kind === "block:slab_plank") return BLOCKS.SLAB_PLANK;
  if (kind === "block:stairs_plank") return BLOCKS.STAIRS_PLANK;
  if (kind === "block:door_wood") return BLOCKS.DOOR_WOOD;

  return BLOCKS.AIR;
}

function blockIdToKind(id: BlockId): string {
  if (id === BLOCKS.DIRT) return "block:dirt";
  if (id === BLOCKS.GRASS) return "block:grass";
  if (id === BLOCKS.STONE) return "block:stone";
  if (id === BLOCKS.BEDROCK) return "block:bedrock";
  if (id === BLOCKS.LOG) return "block:log";
  if (id === BLOCKS.LEAVES) return "block:leaves";
  if (id === BLOCKS.PLANKS) return "block:plank";

  if (id === BLOCKS.SAND) return "block:sand";
  if (id === BLOCKS.SNOW) return "block:snow";
  if (id === BLOCKS.CLAY) return "block:clay";
  if (id === BLOCKS.GRAVEL) return "block:gravel";
  if (id === BLOCKS.MUD) return "block:mud";
  if (id === BLOCKS.ICE) return "block:ice";

  if (id === BLOCKS.COAL_ORE) return "block:coal_ore";
  if (id === BLOCKS.COPPER_ORE) return "block:copper_ore";
  if (id === BLOCKS.IRON_ORE) return "block:iron_ore";
  if (id === BLOCKS.SILVER_ORE) return "block:silver_ore";
  if (id === BLOCKS.GOLD_ORE) return "block:gold_ore";
  if (id === BLOCKS.RUBY_ORE) return "block:ruby_ore";
  if (id === BLOCKS.SAPPHIRE_ORE) return "block:sapphire_ore";
  if (id === BLOCKS.MYTHRIL_ORE) return "block:mythril_ore";
  if (id === BLOCKS.DRAGONSTONE) return "block:dragonstone";

  if (id === BLOCKS.CRAFTING_TABLE) return "block:crafting_table";
  if (id === BLOCKS.CHEST) return "block:chest";
  if (id === BLOCKS.SLAB_PLANK) return "block:slab_plank";
  if (id === BLOCKS.STAIRS_PLANK) return "block:stairs_plank";
  if (id === BLOCKS.DOOR_WOOD) return "block:door_wood";

  return "";
}

// ------------------------------------------------------------
// Procedural Generation Adapter
// ------------------------------------------------------------

const ORE_TABLES: OreTables = buildDefaultOreTablesFromPalette(BLOCKS);

function proceduralTerrainGenerator(x: number, y: number, z: number): number {
  const { biome, height } = sampleBiome(x, z);

  if (y > height) return BLOCKS.AIR;
  if (y <= -63) return BLOCKS.BEDROCK;

  const oreId = pickOreId(x, y, z, biome, height, ORE_TABLES);
  if (oreId !== 0) return oreId;

  const depth = height - y;
  return getTerrainLayerBlockId(BLOCKS, biome, depth);
}

// ------------------------------------------------------------
// Room Implementation
// ------------------------------------------------------------

export class MyRoom extends Room {
  declare state: MyRoomState;
  public maxClients = 16;

  private static WORLD = new WorldStore({ 
    minCoord: -100000, 
    maxCoord: 100000,
    generator: proceduralTerrainGenerator
  });

  private static WORLD_BOOTSTRAPPED = false;
  private static FORCE_TOWN_STAMP = String(process.env.FORCE_TOWN_STAMP || "false").toLowerCase() === "true";
  private static FORCE_TOWN_SPAWN = String(process.env.FORCE_TOWN_SPAWN || "true").toLowerCase() === "true";
  private static ROOM_AUTO_DISPOSE = String(process.env.ROOM_AUTO_DISPOSE || "false").toLowerCase() === "true";

  private static INITIAL_PATCH_LIMIT = clamp(Math.floor(Number(process.env.INITIAL_PATCH_LIMIT ?? 200000)), 10000, 2000000);
  private static PATCH_REQ_DEFAULT_LIMIT = clamp(Math.floor(Number(process.env.PATCH_REQ_DEFAULT_LIMIT ?? 30000)), 1000, 2000000);
  private static PATCH_REQ_MAX_LIMIT = clamp(Math.floor(Number(process.env.PATCH_REQ_MAX_LIMIT ?? 200000)), 5000, 4000000);
  private static SPAWN_TELEPORT_DELAY_MS = clamp(Math.floor(Number(process.env.SPAWN_TELEPORT_DELAY_MS ?? 1200)), 0, 5000);

  private static MAX_MOBS = 10;
  private static MOB_SPAWN_RATE_MS = 5000;
  private lastMobSpawn = 0;

  private worldPath = path.join(process.cwd(), "world_data.json");
  private playersPath = path.join(process.cwd(), "players.json");
  private lastBlockOpAt = new Map<string, number>();

  // --- Persistence ---

  private loadPlayerData(distinctId: string) {
    const data = readJsonFileSafe(this.playersPath);
    if (!data) return null;
    try { return data[distinctId] || null; } catch { return null; }
  }

  private savePlayerData(distinctId: string, p: PlayerState) {
    let allData: any = {};
    const existing = readJsonFileSafe(this.playersPath);
    if (existing && typeof existing === "object") allData = existing;

    const itemsArray = Array.from(p.items.entries()).map((entry: any) => {
      const [uid, item] = entry;
      return {
        uid, kind: item.kind, qty: item.qty, durability: item.durability,
        maxDurability: item.maxDurability, meta: item.meta,
      };
    });

    const craftSlots = Array.from(p.craft.slots);
    
    const cursor = { 
        kind: p.cursor.kind, 
        qty: p.cursor.qty,
        durability: (p.cursor as any).durability,
        maxDurability: (p.cursor as any).maxDurability,
        meta: (p.cursor as any).meta
    };

    const saveData = {
      x: p.x, y: p.y, z: p.z,
      yaw: p.yaw, pitch: p.pitch,
      hp: p.hp, stamina: p.stamina,
      hotbarIndex: p.hotbarIndex,
      inventory: Array.from(p.inventory.slots),
      craftSlots: craftSlots,
      cursor: cursor,
      items: itemsArray,
      equip: p.equip.toJSON(),
    };

    allData[distinctId] = saveData;
    try { writeJsonAtomic(this.playersPath, allData); } 
    catch (e) { console.error(`[PERSIST] Failed to save data for ${distinctId}:`, e); }
  }

  private cleanupDanglingInventoryRefs(p: PlayerState) {
    ensureSlotsLength(p);
    for (let i = 0; i < p.inventory.slots.length; i++) {
      const uid = String(p.inventory.slots[i] || "");
      if (!uid) continue;
      if (!p.items.get(uid)) p.inventory.slots[i] = "";
    }
  }

  // --- Lifecycle ---

  public onCreate(options: any) {
    this.setState(new MyRoomState());
    console.log("MyRoom created:", this.roomId);
    this.autoDispose = MyRoom.ROOM_AUTO_DISPOSE;

    // Bootstrap
    if (!MyRoom.WORLD_BOOTSTRAPPED) {
      MyRoom.WORLD_BOOTSTRAPPED = true;
      if (fs.existsSync(this.worldPath)) {
        try {
          MyRoom.WORLD.loadFromFileSync(this.worldPath);
          console.log(`[PERSIST] Loaded ${MyRoom.WORLD.editsCount()} edits.`);
        } catch (e) { console.error(`[PERSIST] Error loading world:`, e); }
      }
      try {
        stampTownOfBeginnings(MyRoom.WORLD, { verbose: true, force: MyRoom.FORCE_TOWN_STAMP });
      } catch (e) { console.error("[TOWN] Stamp failed:", e); }
      MyRoom.WORLD.configureAutosave({ path: this.worldPath, minIntervalMs: 30000 });
    }

    // Loop
    const TICK_MS = 50;
    
    this.setSimulationInterval(() => {
      const dt = TICK_MS / 1000;
      this.updateLoop(dt);
    }, TICK_MS);

    // --- Message Handlers ---

    this.onMessage("chat", (client, msg: ChatMsg) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || !msg?.text) return;
      const text = msg.text.trim();
      if (text.startsWith("/")) {
        this.handleCommand(client, p, text);
      } else {
        this.broadcast("chat:sys", { text: `<${p.name}> ${text}` });
      }
    });

    this.onMessage("move", (client, msg: MoveMsg) => {
      const p = this.state.players.get(client.sessionId);
      if (p) {
        if (isFiniteNum(msg.x)) p.x = msg.x;
        if (isFiniteNum(msg.y)) p.y = msg.y;
        if (isFiniteNum(msg.z)) p.z = msg.z;
        if (isFiniteNum(msg.yaw)) p.yaw = msg.yaw;
        if (isFiniteNum(msg.pitch)) p.pitch = msg.pitch;
      }
    });

    this.onMessage("sprint", (client, msg: SprintMsg) => {
      const p = this.state.players.get(client.sessionId);
      if (p) p.sprinting = !!msg.on;
    });

    this.onMessage("swing", (client) => {
      const p = this.state.players.get(client.sessionId);
      if (p && p.stamina > 5) {
        p.stamina -= 5;
        p.swinging = true;
        this.clock.setTimeout(() => { if (p) p.swinging = false; }, 250);
      }
    });

    this.onMessage("hotbar:set", (client, msg: HotbarSetMsg) => {
      const p = this.state.players.get(client.sessionId);
      if (p) {
        p.hotbarIndex = normalizeHotbarIndex(msg?.index);
        syncEquipToolToHotbar(p);
      }
    });

    // --- CURSOR & INVENTORY LOGIC ---
    
    this.onMessage("inv:click", (client, msg: InvClickMsg) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;

      const loc = msg.location;
      const idx = msg.index;
      const isRight = msg.button === 1;

      ensureSlotsLength(p);

      // --- RESULT SLOT (Crafting) ---
      if (loc === "result") {
        if (!p.craft.resultKind) return;
        
        if (p.cursor.kind && p.cursor.kind !== p.craft.resultKind) return;
        const max = maxStackForKind(p.craft.resultKind);
        if (p.cursor.kind && p.cursor.qty + p.craft.resultQty > max) return;

        // Add to cursor
        if (!p.cursor.kind) {
            p.cursor.kind = p.craft.resultKind;
            p.cursor.qty = p.craft.resultQty;
            if (p.cursor.kind.startsWith("tool:")) {
                (p.cursor as any).durability = 100;
                (p.cursor as any).maxDurability = 100;
            } else {
                (p.cursor as any).durability = 0;
            }
        } else {
            p.cursor.qty += p.craft.resultQty;
        }

        // Consume ingredients
        for (let i = 0; i < 9; i++) {
          const uid = p.craft.slots[i];
          if (uid) {
            const it = p.items.get(uid);
            if (it) {
              it.qty--;
              if (it.qty <= 0) {
                deleteItem(p, uid);
                p.craft.slots[i] = "";
              }
            }
          }
        }
        updateCraftingResult(p);
        syncEquipToolToHotbar(p);
        return;
      }

      // --- NORMAL SLOTS ---
      let slotUid = "";
      if (loc === "inv") slotUid = p.inventory.slots[idx] || "";
      else if (loc === "craft") slotUid = p.craft.slots[idx] || "";
      else return;

      const slotItem = slotUid ? p.items.get(slotUid) : null;
      const cursorHasItem = !!p.cursor.kind;
      const slotHasItem = !!slotItem;

      if (!isRight) { // Left Click
        if (cursorHasItem && slotHasItem) {
          if (p.cursor.kind === slotItem.kind) {
            const isTool = slotItem.maxDurability > 0;
            const isUsed = isTool && slotItem.durability < slotItem.maxDurability;

            if (!isUsed) {
                const max = maxStackForKind(slotItem.kind);
                const space = max - slotItem.qty;
                if (space > 0) {
                  const move = Math.min(space, p.cursor.qty);
                  slotItem.qty += move;
                  p.cursor.qty -= move;
                  if (p.cursor.qty <= 0) { 
                      p.cursor.kind = ""; p.cursor.qty = 0; 
                      (p.cursor as any).durability = 0; 
                  }
                }
            } else {
                // Swap if incompatible
                const temp = { ...p.cursor };
                setCursorFromItem(p, slotItem, slotItem.qty);
                deleteItem(p, slotUid);
                const newUid = createItemFromCursor(p, temp);
                if (loc === "inv") p.inventory.slots[idx] = newUid;
                else p.craft.slots[idx] = newUid;
            }
          } else {
            // Swap
            const oldCursor = { 
                kind: p.cursor.kind, qty: p.cursor.qty, 
                durability: (p.cursor as any).durability, 
                maxDurability: (p.cursor as any).maxDurability, 
                meta: (p.cursor as any).meta 
            };
            setCursorFromItem(p, slotItem, slotItem.qty);
            deleteItem(p, slotUid); 
            const newUid = createItemFromCursor(p, oldCursor);
            if (loc === "inv") p.inventory.slots[idx] = newUid;
            else p.craft.slots[idx] = newUid;
          }
        } else if (cursorHasItem && !slotHasItem) {
          // Place into empty
          const newUid = createItemFromCursor(p, p.cursor);
          if (loc === "inv") p.inventory.slots[idx] = newUid;
          else p.craft.slots[idx] = newUid;
          
          p.cursor.kind = ""; p.cursor.qty = 0;
          (p.cursor as any).durability = 0;
        } else if (!cursorHasItem && slotHasItem) {
          // Pickup
          setCursorFromItem(p, slotItem, slotItem.qty);
          deleteItem(p, slotUid);
          if (loc === "inv") p.inventory.slots[idx] = "";
          else p.craft.slots[idx] = "";
        }
      } else { // Right Click
        if (cursorHasItem && !slotHasItem) {
          const newUid = createItemFromCursor(p, p.cursor, 1);
          if (loc === "inv") p.inventory.slots[idx] = newUid;
          else p.craft.slots[idx] = newUid;
          
          p.cursor.qty--;
          if (p.cursor.qty <= 0) { 
              p.cursor.kind = ""; p.cursor.qty = 0; 
              (p.cursor as any).durability = 0;
          }
        } else if (cursorHasItem && slotHasItem) {
          if (p.cursor.kind === slotItem.kind) {
            const max = maxStackForKind(slotItem.kind);
            if (slotItem.qty < max) {
              slotItem.qty++;
              p.cursor.qty--;
              if (p.cursor.qty <= 0) { 
                  p.cursor.kind = ""; p.cursor.qty = 0; 
                  (p.cursor as any).durability = 0;
              }
            }
          }
        } else if (!cursorHasItem && slotHasItem) {
          const take = Math.ceil(slotItem.qty / 2);
          setCursorFromItem(p, slotItem, take);
          slotItem.qty -= take;
          if (slotItem.qty <= 0) {
            deleteItem(p, slotUid);
            if (loc === "inv") p.inventory.slots[idx] = "";
            else p.craft.slots[idx] = "";
          }
        }
      }

      if (loc === "craft") updateCraftingResult(p);
      syncEquipToolToHotbar(p);
    });

    this.onMessage("inv:close", (client) => {
      const p = this.state.players.get(client.sessionId);
      if (p && p.cursor.kind) {
        addKindToInventory(p, p.cursor.kind, p.cursor.qty);
        p.cursor.kind = ""; p.cursor.qty = 0;
      }
    });

    // --- Block Ops ---

    this.onMessage("block:break", (client, msg: BlockBreakMsg) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || !this.canOpNow(client.sessionId)) return;

      const { x, y, z } = msg;
      if (!isFiniteNum(x) || !isFiniteNum(y) || !isFiniteNum(z)) return;

      if (inTownSafeZone(x, y, z)) {
        client.send("block:reject", { reason: "safe_zone" });
        return;
      }

      if (dist3(p.x, p.y + 1.6, p.z, x + 0.5, y + 0.5, z + 0.5) > 8) return;

      const oldId = MyRoom.WORLD.getBlock(x, y, z);
      if (oldId === BLOCKS.AIR) return;

      MyRoom.WORLD.setBlock(x, y, z, BLOCKS.AIR);
      
      const kind = blockIdToKind(oldId);
      if (kind) {
          addKindToInventory(p, kind, 1);
      }
      
      this.broadcast("block:update", { x, y, z, id: BLOCKS.AIR });
    });

    this.onMessage("block:place", (client, msg: BlockPlaceMsg) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || !this.canOpNow(client.sessionId)) return;

      const { x, y, z, kind } = msg;
      if (!kind || !kind.startsWith("block:")) return;

      if (inTownSafeZone(x, y, z)) {
        client.send("block:reject", { reason: "safe_zone" });
        return;
      }

      if (dist3(p.x, p.y + 1.6, p.z, x + 0.5, y + 0.5, z + 0.5) > 8) return;
      if (MyRoom.WORLD.getBlock(x, y, z) !== BLOCKS.AIR) return;

      const idx = normalizeHotbarIndex(p.hotbarIndex);
      const uid = p.inventory.slots[idx];
      const it = uid ? p.items.get(uid) : null;
      if (!it || it.kind !== kind || it.qty <= 0) return;

      it.qty--;
      if (it.qty <= 0) {
        deleteItem(p, uid);
        p.inventory.slots[idx] = "";
      }
      syncEquipToolToHotbar(p);

      const id = kindToBlockId(kind);
      MyRoom.WORLD.setBlock(x, y, z, id);
      this.broadcast("block:update", { x, y, z, id });
    });

    this.onMessage("inv:consumeHotbar", (client, msg: InvConsumeHotbarMsg) => {
       const p = this.state.players.get(client.sessionId);
       if (p) consumeFromHotbar(p, msg.qty || 1);
    });

    this.onMessage("inv:add", (client, msg: InvAddMsg) => {
       const p = this.state.players.get(client.sessionId);
       if (p && msg.kind) addKindToInventory(p, msg.kind, msg.qty || 1);
    });

    this.onMessage("world:patch:req", (client, msg: WorldPatchReqMsg) => {
      const p = this.state.players.get(client.sessionId);
      if (p) {
        const defaultLimit = MyRoom.PATCH_REQ_DEFAULT_LIMIT;
        const maxLimit = MyRoom.PATCH_REQ_MAX_LIMIT;
        
        let reqLimit = msg.limit ?? defaultLimit;
        reqLimit = clamp(reqLimit, 1000, maxLimit);

        const patch = MyRoom.WORLD.encodePatchAround(
            { x: p.x, y: p.y, z: p.z }, 
            msg.r || 48, 
            { limit: reqLimit }
        );
        client.send("world:patch", patch);
      }
    });
  }

  // --- Game Loop (Mobs + Players) ---

  private updateLoop(dt: number) {
    const STAMINA_DRAIN = 18;
    const STAMINA_REGEN = 12;

    this.state.players.forEach((p: any) => {
        if (p.sprinting) {
          p.stamina = clamp(p.stamina - STAMINA_DRAIN * dt, 0, 100);
          if (p.stamina <= 0.01) p.sprinting = false;
        } else {
          p.stamina = clamp(p.stamina + STAMINA_REGEN * dt, 0, 100);
        }
    });

    if (this.state.mobs.size < MyRoom.MAX_MOBS && nowMs() - this.lastMobSpawn > MyRoom.MOB_SPAWN_RATE_MS) {
        this.spawnMob();
        this.lastMobSpawn = nowMs();
    }

    this.state.mobs.forEach((mob: any, id: string) => {
        const idBelow = MyRoom.WORLD.getBlock(Math.floor(mob.x), Math.floor(mob.y - 0.1), Math.floor(mob.z));
        const isGrounded = (idBelow !== BLOCKS.AIR);

        if (!isGrounded) {
            mob.y -= 10 * dt; 
        } else {
            let nearestDist = 999;
            let target: any = null;
            this.state.players.forEach((p: any) => {
                const d = dist3(mob.x, mob.y, mob.z, p.x, p.y, p.z);
                if (d < nearestDist && d < 16) {
                    nearestDist = d;
                    target = p;
                }
            });

            if (target) {
                const dx = target.x - mob.x;
                const dz = target.z - mob.z;
                const angle = Math.atan2(dx, dz);
                mob.yaw = angle;

                const speed = 3.0;
                const mx = Math.sin(angle) * speed * dt;
                const mz = Math.cos(angle) * speed * dt;

                const idAhead = MyRoom.WORLD.getBlock(Math.floor(mob.x + mx), Math.floor(mob.y + 0.5), Math.floor(mob.z + mz));
                if (idAhead !== BLOCKS.AIR) {
                    mob.y += 1.2;
                } else {
                    mob.x += mx;
                    mob.z += mz;
                }
            } else {
                if (Math.random() < 0.02) mob.yaw += (Math.random() - 0.5) * 2;
            }
        }
        if (mob.y < -50) this.state.mobs.delete(id);
    });

    MyRoom.WORLD.maybeAutosave();
  }

  private spawnMob() {
      const id = makeUid("server", "mob");
      const m = new MobState();
      m.id = id;
      m.kind = "mob:slime_green";
      
      const angle = Math.random() * Math.PI * 2;
      const dist = 10 + Math.random() * 10;
      m.x = TOWN_SAFE_ZONE.center.x + Math.sin(angle) * dist;
      m.z = TOWN_SAFE_ZONE.center.z + Math.cos(angle) * dist;
      m.y = findSpawnYAt(MyRoom.WORLD, m.x, m.z, TOWN_GROUND_Y);
      
      this.state.mobs.set(id, m);
  }

  private handleCommand(client: Client, p: PlayerState, text: string) {
    const parts = text.slice(1).split(" ");
    const cmd = parts[0].toLowerCase();

    if (cmd === "tp" && parts.length === 4) {
      const x = Number(parts[1]), y = Number(parts[2]), z = Number(parts[3]);
      if (isFinite(x) && isFinite(y) && isFinite(z)) {
        p.x = x; p.y = y; p.z = z;
        client.send("spawn:teleport", { x, y, z });
        client.send("chat:sys", { text: `Teleported to ${x},${y},${z}` });
      }
    } else if (cmd === "biome") {
      const b = sampleBiome(p.x, p.z);
      client.send("chat:sys", { text: `Biome: ${b.biome}` });
    } else if (cmd === "find" && parts[1]) {
      const t = parts[1];
      const res = findNearestBiome(p.x, p.z, t);
      if (res) {
         const d = Math.floor(dist3(p.x, 0, p.z, res.x, 0, res.z));
         client.send("chat:sys", { text: `Found ${res.biome} at ${Math.floor(res.x)},${Math.floor(res.z)} (${d} blocks)` });
      } else {
         client.send("chat:sys", { text: "Not found nearby." });
      }
    } else if (cmd === "goto" && parts[1]) {
      const t = parts[1];
      const res = findNearestBiome(p.x, p.z, t);
      if (res) {
         const y = findSpawnYAt(MyRoom.WORLD, res.x, res.z, 20);
         p.x = res.x; p.y = y; p.z = res.z;
         client.send("spawn:teleport", { x: res.x, y, z: res.z });
         client.send("world:patch", MyRoom.WORLD.encodePatchAround({ x: res.x, y, z: res.z }, 48));
      }
    }
  }

  private canOpNow(sid: string) {
    const t = nowMs();
    const last = this.lastBlockOpAt.get(sid) || 0;
    if (t - last < 90) return false;
    this.lastBlockOpAt.set(sid, t);
    return true;
  }

  // --- Join/Leave ---

  public onJoin(client: Client, options: JoinOptions) {
    const distinctId = options.distinctId || client.sessionId;
    (client as any).auth = { distinctId };
    console.log(client.sessionId, "joined");

    let p = new PlayerState();
    p.id = client.sessionId;
    p.name = (options.name || "Player").slice(0, 16);

    let loadSuccess = false;
    const saved = this.loadPlayerData(distinctId);
    
    // SAFE LOAD LOGIC
    if (saved) {
      try {
        let lx = isFiniteNum(saved.x) ? saved.x : TOWN_SAFE_ZONE.center.x;
        let lz = isFiniteNum(saved.z) ? saved.z : TOWN_SAFE_ZONE.center.z;
        let ly = isFiniteNum(saved.y) ? saved.y : TOWN_GROUND_Y;
        
        // FIX: Always recompute Y to prevent stuck logic, even on valid saves
        ly = findSpawnYAt(MyRoom.WORLD, lx, lz, ly);
        
        p.x = lx; p.y = ly; p.z = lz;
        p.yaw = saved.yaw || 0; p.pitch = saved.pitch || 0;
        p.hp = saved.hp || 20; p.stamina = saved.stamina || 100;
        p.hotbarIndex = normalizeHotbarIndex(saved.hotbarIndex);

        if (Array.isArray(saved.items)) {
          saved.items.forEach((si: any) => {
            const it = new ItemState();
            it.uid = si.uid; it.kind = si.kind; it.qty = si.qty; 
            it.durability = si.durability || 0;
            it.maxDurability = si.maxDurability || 0;
            it.meta = si.meta || null;
            p.items.set(it.uid, it);
          });
        }
        
        ensureSlotsLength(p);
        if (Array.isArray(saved.inventory)) {
          saved.inventory.forEach((uid: string, i: number) => {
            if (i < p.inventory.slots.length) p.inventory.slots[i] = uid;
          });
        }

        if (Array.isArray(saved.craftSlots)) {
          saved.craftSlots.forEach((uid: string, i: number) => { if(i<9) p.craft.slots[i] = uid; });
          updateCraftingResult(p);
        }

        if (saved.cursor) {
          p.cursor.kind = saved.cursor.kind;
          p.cursor.qty = saved.cursor.qty;
          (p.cursor as any).durability = saved.cursor.durability;
          (p.cursor as any).maxDurability = saved.cursor.maxDurability;
          (p.cursor as any).meta = saved.cursor.meta;
        }

        if (saved.equip) {
            if (saved.equip.tool) p.equip.tool = saved.equip.tool;
            if (saved.equip.head) p.equip.head = saved.equip.head;
            if (saved.equip.chest) p.equip.chest = saved.equip.chest;
            if (saved.equip.legs) p.equip.legs = saved.equip.legs;
            if (saved.equip.feet) p.equip.feet = saved.equip.feet;
        }
        
        this.cleanupDanglingInventoryRefs(p);
        loadSuccess = true;
      } catch (e) {
        console.error("Failed to load save data (corrupt?). Starting fresh.", e);
        loadSuccess = false;
        p = new PlayerState();
        p.id = client.sessionId;
        p.name = (options.name || "Player").slice(0, 16);
      }
    }

    if (!loadSuccess) {
      // FRESH SPAWN
      p.x = TOWN_SAFE_ZONE.center.x; 
      p.z = TOWN_SAFE_ZONE.center.z;
      p.y = findSpawnYAt(MyRoom.WORLD, p.x, p.z, TOWN_GROUND_Y);
      
      ensureSlotsLength(p);
      const add = (k: string, q: number, i: number) => {
        const uid = createItem(p, k, q);
        p.inventory.slots[i] = uid;
      };
      add("tool:pickaxe_wood", 1, 0);
      add("block:dirt", 16, 1);
      syncEquipToolToHotbar(p);
    }

    // FIX: Force Town Spawn Override (Developer Tool / Stuck Safety)
    if (MyRoom.FORCE_TOWN_SPAWN) {
        p.x = TOWN_SAFE_ZONE.center.x;
        p.z = TOWN_SAFE_ZONE.center.z;
        p.y = findSpawnYAt(MyRoom.WORLD, p.x, p.z, TOWN_GROUND_Y);
    }

    // --- NEW DIAGNOSTIC LOGGING ---
    console.log(`[SPAWN DEBUG] Session: ${client.sessionId} (${distinctId})`);
    console.log(`[SPAWN DEBUG] Player Pos: x=${p.x.toFixed(2)}, y=${p.y.toFixed(2)}, z=${p.z.toFixed(2)}`);
    console.log(`[SPAWN DEBUG] Town Center: x=${TOWN_SAFE_ZONE.center.x}, y=${TOWN_GROUND_Y}, z=${TOWN_SAFE_ZONE.center.z}`);
    const dist = Math.sqrt(Math.pow(p.x - TOWN_SAFE_ZONE.center.x, 2) + Math.pow(p.z - TOWN_SAFE_ZONE.center.z, 2));
    console.log(`[SPAWN DEBUG] Distance from Town Center: ${dist.toFixed(2)} blocks`);
    
    this.state.players.set(client.sessionId, p);
    client.send("welcome", { sessionId: client.sessionId });
    
    // Initial Patch - REMOVED! Client will request it in 'welcome' handler to fix race condition.
    // client.send("world:patch", patch); 
    
    client.send("spawn:teleport", { x: p.x, y: p.y, z: p.z });
  }

  public onLeave(client: Client) {
    const p = this.state.players.get(client.sessionId);
    if (p) {
      const distinctId = (client as any).auth?.distinctId;
      if (distinctId) this.savePlayerData(distinctId, p);
    }
    this.state.players.delete(client.sessionId);
  }

  public onDispose() {
    console.log("Room disposing...");
    MyRoom.WORLD.saveToFileSync(this.worldPath);
  }
}