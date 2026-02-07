// ============================================================
// server/crafting/Recipes.ts
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
  pattern?: string[];   // e.g. ["###", " | ", " | "]
  key?: { [char: string]: string }; // e.g. { "#": "block:plank", "|": "item:stick" }
  // Shapeless:
  ingredients?: string[]; // e.g. ["block:log"]
}

export const RECIPES: CraftingRecipe[] = [
  // 1. Log -> 4 Planks (Shapeless)
  {
    id: "planks_from_log",
    type: "shapeless",
    ingredients: ["block:log"],
    result: { kind: "block:plank", qty: 4 }
  },
  // 2. 2 Planks -> 4 Sticks (Shaped 2x1)
  {
    id: "sticks",
    type: "shaped",
    pattern: [
      "#",
      "#"
    ],
    key: { "#": "block:plank" },
    result: { kind: "item:stick", qty: 4 }
  },
  // 3. Wooden Pickaxe (Shaped 3x3)
  {
    id: "pickaxe_wood",
    type: "shaped",
    pattern: [
      "###",
      " | ",
      " | "
    ],
    key: { 
      "#": "block:plank",
      "|": "item:stick"
    },
    result: { kind: "tool:pickaxe_wood", qty: 1 }
  },
  // 4. Stone Pickaxe
  {
    id: "pickaxe_stone",
    type: "shaped",
    pattern: [
      "###",
      " | ",
      " | "
    ],
    key: { 
      "#": "block:stone",
      "|": "item:stick"
    },
    result: { kind: "tool:pickaxe_stone", qty: 1 }
  }
];