// ============================================================
// 1) COLYSEUS SCHEMA (HYBRID INVENTORY + EQUIPMENT + STATS)
// File: state.ts  (FULL REWRITE - NO OMITS)
// ============================================================

import { Schema, type, MapSchema, ArraySchema } from "@colyseus/schema";

/** One item stack or equipment instance */
export class ItemState extends Schema {
  // unique instance id (use session+counter or nanoid on server)
  @type("string") uid: string = "";

  // item type id (e.g. "dirt", "grass", "pickaxe_wood")
  @type("string") kind: string = "";

  // stack quantity
  @type("number") qty: number = 0;

  // durability for tools (0..maxDurability)
  @type("number") durability: number = 0;

  @type("number") maxDurability: number = 0;

  // optional metadata (simple string; if you need rich meta later, promote to separate Schema)
  @type("string") meta: string = "";
}

/** Fixed-size inventory grid as an Array of slot keys (Item uid or "" for empty) */
export class InventoryState extends Schema {
  // grid size (server authoritative)
  @type("number") cols: number = 9;

  @type("number") rows: number = 4;

  // slot -> item uid (or "" empty)
  @type([ "string" ]) slots: ArraySchema<string> = new ArraySchema<string>();

  constructor() {
    super();
    // 9x4 default = 36 slots
    const total = 9 * 4;
    for (let i = 0; i < total; i++) this.slots.push("");
  }
}

/** Equipment slots reference item uids (must exist in items map) */
export class EquipmentState extends Schema {
  @type("string") head: string = "";
  @type("string") chest: string = "";
  @type("string") legs: string = "";
  @type("string") feet: string = "";
  @type("string") tool: string = "";
  @type("string") offhand: string = "";
}

/** Per-player state replicated to clients */
export class PlayerState extends Schema {
  @type("string") id: string = "";
  @type("string") name: string = "Steve";

  @type("number") x: number = 0;
  @type("number") y: number = 0;
  @type("number") z: number = 0;

  @type("number") yaw: number = 0;
  @type("number") pitch: number = 0;

  // --- Stats ---
  @type("number") hp: number = 20;
  @type("number") maxHp: number = 20;

  @type("number") stamina: number = 100;
  @type("number") maxStamina: number = 100;

  @type("boolean") sprinting: boolean = false;
  @type("boolean") swinging: boolean = false;

  // --- Inventory / items ---
  // All items owned by the player (key = item uid)
  @type({ map: ItemState }) items: MapSchema<ItemState> = new MapSchema<ItemState>();

  // Inventory grid (slots contain item uid or "")
  @type(InventoryState) inventory: InventoryState = new InventoryState();

  // Equipped slots (contain item uid or "")
  @type(EquipmentState) equip: EquipmentState = new EquipmentState();
}

/** Room state */
export class MyRoomState extends Schema {
  @type({ map: PlayerState }) players = new MapSchema<PlayerState>();
}
