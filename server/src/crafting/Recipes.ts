// ============================================================
// server/crafting/Recipes.ts  (EXPANDED - FULL FILE, NO OMITS)
// ============================================================

export interface RecipeResult {
  kind: string;
  qty: number;
}

export interface CraftingRecipe {
  id: string;
  type: "shaped" | "shapeless";
  result: RecipeResult;

  // Shaped:
  pattern?: string[];                 // e.g. ["###", " | ", " | "]
  key?: { [char: string]: string };   // e.g. { "#": "block:plank", "|": "item:stick" }

  // Shapeless:
  ingredients?: string[];             // e.g. ["block:log"]
}

export const RECIPES: CraftingRecipe[] = [
  // ----------------------------------------------------------
  // CORE MATERIALS
  // ----------------------------------------------------------

  // 1) Log -> 4 Planks (Shapeless)
  {
    id: "planks_from_log",
    type: "shapeless",
    ingredients: ["block:log"],
    result: { kind: "block:plank", qty: 4 },
  },

  // 2) 2 Planks -> 4 Sticks (Shaped 1x2 vertical)
  {
    id: "sticks",
    type: "shaped",
    pattern: ["#", "#"],
    key: { "#": "block:plank" },
    result: { kind: "item:stick", qty: 4 },
  },

  // ----------------------------------------------------------
  // WORKSTATION / STORAGE (Minecraft-ish)
  // ----------------------------------------------------------

  // 3) Crafting Table (2x2 planks)
  {
    id: "crafting_table",
    type: "shaped",
    pattern: ["##", "##"],
    key: { "#": "block:plank" },
    result: { kind: "block:crafting_table", qty: 1 },
  },

  // 4) Chest (3x3 ring of planks, center empty)
  {
    id: "chest",
    type: "shaped",
    pattern: ["###", "# #", "###"],
    key: { "#": "block:plank" },
    result: { kind: "block:chest", qty: 1 },
  },

  // ----------------------------------------------------------
  // BUILDING PIECES (planks)
  // ----------------------------------------------------------

  // 5) Plank Slabs (3 across -> 6 slabs)
  {
    id: "slab_plank",
    type: "shaped",
    pattern: ["###"],
    key: { "#": "block:plank" },
    result: { kind: "block:slab_plank", qty: 6 },
  },

  // 6) Plank Stairs (classic stairs shape -> 4)
  // Pattern:
  // #..
  // ##.
  // ###
  {
    id: "stairs_plank",
    type: "shaped",
    pattern: ["#  ", "## ", "###"],
    key: { "#": "block:plank" },
    result: { kind: "block:stairs_plank", qty: 4 },
  },

  // 7) Wooden Door (2x3 -> 1 door)
  {
    id: "door_wood",
    type: "shaped",
    pattern: ["##", "##", "##"],
    key: { "#": "block:plank" },
    result: { kind: "block:door_wood", qty: 1 },
  },

  // ----------------------------------------------------------
  // WOODEN TOOLS (planks + sticks)
  // ----------------------------------------------------------

  // 8) Wooden Pickaxe
  {
    id: "pickaxe_wood",
    type: "shaped",
    pattern: ["###", " | ", " | "],
    key: {
      "#": "block:plank",
      "|": "item:stick",
    },
    result: { kind: "tool:pickaxe_wood", qty: 1 },
  },

  // 9) Wooden Axe
  // ##.
  // #|.
  //  |.
  {
    id: "axe_wood",
    type: "shaped",
    pattern: ["## ", "#| ", " | "],
    key: {
      "#": "block:plank",
      "|": "item:stick",
    },
    result: { kind: "tool:axe_wood", qty: 1 },
  },

  // 10) Wooden Shovel
  // # 
  // | 
  // | 
  {
    id: "shovel_wood",
    type: "shaped",
    pattern: ["# ", "| ", "| "],
    key: {
      "#": "block:plank",
      "|": "item:stick",
    },
    result: { kind: "tool:shovel_wood", qty: 1 },
  },

  // 11) Wooden Sword
  // #
  // #
  // |
  {
    id: "sword_wood",
    type: "shaped",
    pattern: ["#", "#", "|"],
    key: {
      "#": "block:plank",
      "|": "item:stick",
    },
    result: { kind: "tool:sword_wood", qty: 1 },
  },

  // ----------------------------------------------------------
  // STONE TOOLS (stone + sticks)
  // ----------------------------------------------------------

  // 12) Stone Pickaxe
  {
    id: "pickaxe_stone",
    type: "shaped",
    pattern: ["###", " | ", " | "],
    key: {
      "#": "block:stone",
      "|": "item:stick",
    },
    result: { kind: "tool:pickaxe_stone", qty: 1 },
  },

  // 13) Stone Axe
  {
    id: "axe_stone",
    type: "shaped",
    pattern: ["## ", "#| ", " | "],
    key: {
      "#": "block:stone",
      "|": "item:stick",
    },
    result: { kind: "tool:axe_stone", qty: 1 },
  },

  // 14) Stone Shovel
  {
    id: "shovel_stone",
    type: "shaped",
    pattern: ["# ", "| ", "| "],
    key: {
      "#": "block:stone",
      "|": "item:stick",
    },
    result: { kind: "tool:shovel_stone", qty: 1 },
  },

  // 15) Stone Sword
  {
    id: "sword_stone",
    type: "shaped",
    pattern: ["#", "#", "|"],
    key: {
      "#": "block:stone",
      "|": "item:stick",
    },
    result: { kind: "tool:sword_stone", qty: 1 },
  },

  // ----------------------------------------------------------
  // FANTASY-FLAVOUR STARTERS (still using existing ingredients)
  // ----------------------------------------------------------

  // 16) Wooden Club (shapeless: plank + stick -> club)
  // (Nice early “event server” weapon without needing new resources)
  {
    id: "club_wood",
    type: "shapeless",
    ingredients: ["block:plank", "item:stick"],
    result: { kind: "tool:club_wood", qty: 1 },
  },

  // 17) Training Wand (shapeless: stick + plank -> wand)
  // (A placeholder “magic starter” item until you add real reagents)
  {
    id: "wand_training",
    type: "shapeless",
    ingredients: ["item:stick", "block:plank"],
    result: { kind: "tool:wand_training", qty: 1 },
  },
];
