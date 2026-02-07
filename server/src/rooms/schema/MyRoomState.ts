// ============================================================
// rooms/schema/MyRoomState.ts  (FULL REWRITE - NO OMITS)
// ------------------------------------------------------------
// Option B + Minecraft Cursor Stack:
// - Each player has a REAL 3x3 craft grid: craft.slots[0..8] (uid strings)
// - Craft preview/result is server-derived on craft: resultKind/resultQty/recipeId
// - Each player also has a REAL cursor stack (Minecraft-style):
//     cursor.kind / cursor.qty
//   This is server-authoritative and supports right/left/double click logic.
// - Inventory remains 9x4 (36) uid slots + items Map(uid->ItemState)
// - Equipment remains uid refs into items map
// ============================================================

import { Schema, type, MapSchema, ArraySchema } from "@colyseus/schema";

// ------------------------------------------------------------
// Item State
// ------------------------------------------------------------

export class ItemState extends Schema {
  @type("string") uid: string = "";
  @type("string") kind: string = "";
  @type("number") qty: number = 0;

  // Optional tool stats
  @type("number") durability: number = 0;
  @type("number") maxDurability: number = 0;

  // Optional metadata (e.g., custom name, enchant tags, etc.)
  @type("string") meta: string = "";
}

// ------------------------------------------------------------
// Inventory State (uid references into items map)
// ------------------------------------------------------------

export class InventoryState extends Schema {
  @type("number") cols: number = 9;
  @type("number") rows: number = 4;

  // Each entry is an ItemState.uid or "" for empty
  @type(["string"]) slots: ArraySchema<string> = new ArraySchema<string>();
}

// ------------------------------------------------------------
// Equipment State (uid references into items map)
// ------------------------------------------------------------

export class EquipmentState extends Schema {
  @type("string") head: string = "";
  @type("string") chest: string = "";
  @type("string") legs: string = "";
  @type("string") feet: string = "";
  @type("string") tool: string = "";
  @type("string") offhand: string = "";
}

// ------------------------------------------------------------
// Crafting State (Option B - real container)
// ------------------------------------------------------------

export class CraftingState extends Schema {
  // 3x3 grid: slots 0..8 (uid references into items map), "" for empty
  @type(["string"]) slots: ArraySchema<string> = new ArraySchema<string>();

  // Server-derived preview
  @type("string") resultKind: string = "";
  @type("number") resultQty: number = 0;

  // Optional: store the matched recipe id for debugging/UI hints
  @type("string") recipeId: string = "";

  constructor() {
    super();
    // Ensure exactly 9 slots exist by default
    for (let i = 0; i < 9; i++) this.slots.push("");
  }
}

// ------------------------------------------------------------
// Cursor State (Minecraft-style "held stack")
// ------------------------------------------------------------

export class CursorState extends Schema {
  // Kind + qty represent a stack "held by the mouse cursor".
  // This is server-authoritative and is NOT stored in items map by uid.
  // (Minecraft cursor is a stack, not a unique item instance.)
  @type("string") kind: string = "";
  @type("number") qty: number = 0;

  // Optional metadata for cursor stack if you add it later (kept now for extensibility)
  @type("string") meta: string = "";
}

// ------------------------------------------------------------
// Player State
// ------------------------------------------------------------

export class PlayerState extends Schema {
  // Identity
  @type("string") id: string = "";
  @type("string") name: string = "Steve";

  // Transform
  @type("number") x: number = 0;
  @type("number") y: number = 10;
  @type("number") z: number = 0;
  @type("number") yaw: number = 0;
  @type("number") pitch: number = 0;

  // Stats
  @type("number") hp: number = 20;
  @type("number") maxHp: number = 20;

  @type("number") stamina: number = 100;
  @type("number") maxStamina: number = 100;

  // Actions
  @type("boolean") sprinting: boolean = false;
  @type("boolean") swinging: boolean = false;

  // Hotbar selection index (0..8)
  @type("number") hotbarIndex: number = 0;

  // Containers
  @type(InventoryState) inventory: InventoryState = new InventoryState();
  @type(EquipmentState) equip: EquipmentState = new EquipmentState();
  @type(CraftingState) craft: CraftingState = new CraftingState();

  // Minecraft-style cursor (held stack)
  @type(CursorState) cursor: CursorState = new CursorState();

  // Items: uid -> ItemState
  @type({ map: ItemState }) items: MapSchema<ItemState> = new MapSchema<ItemState>();

  constructor() {
    super();

    // Initialize inventory slots (default 9x4 = 36)
    // Server still enforces exact length with ensureSlotsLength(), but this provides a stable baseline.
    const total = Math.max(1, (this.inventory.cols || 9) * (this.inventory.rows || 4));
    for (let i = 0; i < total; i++) this.inventory.slots.push("");
  }
}

// ------------------------------------------------------------
// Room State
// ------------------------------------------------------------

export class MyRoomState extends Schema {
  // sessionId -> PlayerState
  @type({ map: PlayerState }) players: MapSchema<PlayerState> = new MapSchema<PlayerState>();
}
