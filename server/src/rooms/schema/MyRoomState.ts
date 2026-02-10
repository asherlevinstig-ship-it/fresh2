// ============================================================
// src/rooms/schema/MyRoomState.ts
// ------------------------------------------------------------
// FULL REWRITE - PRODUCTION READY - NO OMITS
//
// Includes Schema definitions for:
// - Items (Uid, Kind, Qty, Durability)
// - Player Containers (Inventory, Equipment, Crafting Grid)
// - Player Cursor (The "Floating" Stack held by mouse)
// - Mobs (AI Entities with Position/Stats)
// - Player Entity (Transform, Stats, Input State)
// ============================================================

import { Schema, type, MapSchema, ArraySchema } from "@colyseus/schema";

// ------------------------------------------------------------
// 1. Item State
// Represents a specific instance of an item in the world/inventory
// ------------------------------------------------------------
export class ItemState extends Schema {
    // Unique ID for tracking specific instances (persistence)
    @type("string") uid: string = "";

    // Item Type ID (e.g., "block:dirt", "tool:sword_wood")
    @type("string") kind: string = "";

    // Stack Quantity
    @type("number") qty: number = 0;

    // Tool/Armor Stats
    @type("number") durability: number = 0;
    @type("number") maxDurability: number = 0;

    // JSON Metadata for custom enchantments, names, etc.
    @type("string") meta: string = "";
}

// ------------------------------------------------------------
// 2. Inventory State
// Represents the main storage grid (referenced by UID)
// ------------------------------------------------------------
export class InventoryState extends Schema {
    @type("number") cols: number = 9;
    @type("number") rows: number = 4;

    // Array of Item UIDs. "" means empty slot.
    // Length is usually 36 (9x4).
    @type(["string"]) slots: ArraySchema<string> = new ArraySchema<string>();
}

// ------------------------------------------------------------
// 3. Equipment State
// Represents worn gear (referenced by UID)
// ------------------------------------------------------------
export class EquipmentState extends Schema {
    @type("string") head: string = "";
    @type("string") chest: string = "";
    @type("string") legs: string = "";
    @type("string") feet: string = "";
    @type("string") tool: string = "";    // Currently held main-hand item
    @type("string") offhand: string = ""; // Shield or secondary
}

// ------------------------------------------------------------
// 4. Crafting State
// Represents the 3x3 crafting grid and output preview
// ------------------------------------------------------------
export class CraftingState extends Schema {
    // 3x3 Grid of Item UIDs (0..8)
    @type(["string"]) slots: ArraySchema<string> = new ArraySchema<string>();

    // Server-Calculated Result Preview
    // This is NOT a UID, but a raw definition of what *would* be created.
    @type("string") resultKind: string = "";
    @type("number") resultQty: number = 0;

    // ID of the matched recipe (for UI hints)
    @type("string") recipeId: string = "";

    constructor() {
        super();
        // Initialize 9 empty slots
        for (let i = 0; i < 9; i++) {
            this.slots.push("");
        }
    }
}

// ------------------------------------------------------------
// 5. Cursor State (Minecraft-Style Interaction)
// Represents the stack currently "floating" on the player's mouse cursor.
// This is Server-Authoritative to prevent duping.
// ------------------------------------------------------------
export class CursorState extends Schema {
    @type("string") kind: string = "";
    @type("number") qty: number = 0;
    @type("string") meta: string = ""; // For moving enchanted items
}

// ------------------------------------------------------------
// 6. Mob State (AI Entities)
// Represents enemies or NPCs in the world
// ------------------------------------------------------------
export class MobState extends Schema {
    // Unique Instance ID
    @type("string") id: string = "";

    // Type (e.g., "mob:slime_green", "mob:skeleton")
    @type("string") kind: string = "";

    // Position
    @type("number") x: number = 0;
    @type("number") y: number = 0;
    @type("number") z: number = 0;

    // Rotation (Heading)
    @type("number") yaw: number = 0;

    // Stats
    @type("number") hp: number = 10;
    @type("number") maxHp: number = 10;

    // Animation State (0 = Idle, 1 = Walk, 2 = Attack, 3 = Hurt/Die)
    @type("number") animState: number = 0;
}

// ------------------------------------------------------------
// 7. Player State
// Represents a connected user
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

    // Survival Stats
    @type("number") hp: number = 20;
    @type("number") maxHp: number = 20;
    @type("number") stamina: number = 100;
    @type("number") maxStamina: number = 100;

    // Action Flags
    @type("boolean") sprinting: boolean = false;
    @type("boolean") swinging: boolean = false;

    // Selected Hotbar Slot (0-8)
    @type("number") hotbarIndex: number = 0;

    // Sub-Schemas
    @type(InventoryState) inventory: InventoryState = new InventoryState();
    @type(EquipmentState) equip: EquipmentState = new EquipmentState();
    @type(CraftingState) craft: CraftingState = new CraftingState();
    @type(CursorState) cursor: CursorState = new CursorState();

    // Item Data Storage (Map of UID -> ItemState)
    // All items physically located in inventory/craft/equip slots are stored here.
    @type({ map: ItemState }) items: MapSchema<ItemState> = new MapSchema<ItemState>();

    constructor() {
        super();
        // Initialize inventory slots (Standard 9x4 = 36)
        for (let i = 0; i < 36; i++) {
            this.inventory.slots.push("");
        }
    }
}

// ------------------------------------------------------------
// 8. Room State (Root)
// The top-level state synchronized to all clients
// ------------------------------------------------------------
export class MyRoomState extends Schema {
    // Active Players (Key: SessionID)
    @type({ map: PlayerState }) players: MapSchema<PlayerState> = new MapSchema<PlayerState>();

    // Active Mobs (Key: Mob Instance ID)
    @type({ map: MobState }) mobs: MapSchema<MobState> = new MapSchema<MobState>();
}