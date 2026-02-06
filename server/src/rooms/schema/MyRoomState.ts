// ============================================================
// schema/MyRoomState.ts  (FULL REWRITE - NO OMITS)
// ------------------------------------------------------------
// Includes:
// - Player transform (x,y,z,yaw,pitch)
// - Stats (hp/stamina + sprint/swing flags)
// - Hotbar selection (0..8)
// - Inventory: fixed grid (cols/rows + slots = item uid or "")
// - Equipment: references item uids
// - Items: MapSchema of ItemState keyed by uid
// ============================================================

import { Schema, type, MapSchema, ArraySchema } from "@colyseus/schema";

/** One item stack or equipment instance */
export class ItemState extends Schema {
  /** Unique item instance id (also used as key in PlayerState.items) */
  @type("string") uid: string = "";

  /** Item kind/type id e.g. "block:dirt", "tool:pickaxe_wood" */
  @type("string") kind: string = "";

  /** Stack quantity (tools usually 1) */
  @type("number") qty: number = 0;

  /** Durability for tools (0..maxDurability) */
  @type("number") durability: number = 0;

  /** Max durability for tools */
  @type("number") maxDurability: number = 0;

  /** Optional metadata (simple string; upgrade later if needed) */
  @type("string") meta: string = "";
}

/** Fixed-size inventory grid */
export class InventoryState extends Schema {
  /** Grid columns (Minecraft-style default 9) */
  @type("number") cols: number = 9;

  /** Grid rows (default 4 -> 36 slots) */
  @type("number") rows: number = 4;

  /**
   * Slot contents: item uid OR "" for empty.
   * Length should be cols*rows (server enforces).
   */
  @type(["string"]) slots: ArraySchema<string> = new ArraySchema<string>();

  constructor() {
    super();
    const total = 9 * 4;
    for (let i = 0; i < total; i++) this.slots.push("");
  }
}

/** Equipment slots hold item uids (must exist in PlayerState.items) */
export class EquipmentState extends Schema {
  @type("string") head: string = "";
  @type("string") chest: string = "";
  @type("string") legs: string = "";
  @type("string") feet: string = "";
  @type("string") tool: string = "";
  @type("string") offhand: string = "";
}

/** Player replicated state */
export class PlayerState extends Schema {
  @type("string") id: string = "";
  @type("string") name: string = "Steve";

  // transform
  @type("number") x: number = 0;
  @type("number") y: number = 0;
  @type("number") z: number = 0;

  @type("number") yaw: number = 0;
  @type("number") pitch: number = 0;

  // stats
  @type("number") hp: number = 20;
  @type("number") maxHp: number = 20;

  @type("number") stamina: number = 100;
  @type("number") maxStamina: number = 100;

  @type("boolean") sprinting: boolean = false;
  @type("boolean") swinging: boolean = false;

  // hotbar selection (0..8)
  @type("number") hotbarIndex: number = 0;

  // items owned by player (key = uid)
  @type({ map: ItemState }) items: MapSchema<ItemState> = new MapSchema<ItemState>();

  // inventory grid
  @type(InventoryState) inventory: InventoryState = new InventoryState();

  // equipped uids
  @type(EquipmentState) equip: EquipmentState = new EquipmentState();
}

/** Room state */
export class MyRoomState extends Schema {
  @type({ map: PlayerState }) players: MapSchema<PlayerState> = new MapSchema<PlayerState>();
}
