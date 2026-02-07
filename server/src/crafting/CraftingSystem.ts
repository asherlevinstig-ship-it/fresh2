// ============================================================
// server/crafting/CraftingSystem.ts  (FULL REWRITE - NO OMITS)
// ------------------------------------------------------------
// Purpose:
// - Server-side recipe matching for a 3x3 crafting grid.
// - Supports:
//   - Shapeless recipes (exact multiset match)
//   - Shaped recipes with pattern trimming ("bounding box") so the
//     recipe can be placed anywhere in the 3x3 as long as the shape matches.
// Notes:
// - Grid is array of 9 item kinds (strings). "" means empty.
// - Recipe patterns use " " (space) for empty cells.
// - For shaped recipes, we:
//   1) convert grid -> 3x3 matrix
//   2) trim empty rows/cols in the input to get its bounding box
//   3) compare with recipe pattern matrix (dimensions must match)
//   4) for each cell: space means empty, otherwise map keyChar -> expected kind
// ============================================================

import { RECIPES, CraftingRecipe } from "./Recipes.js";

export class CraftingSystem {
  /**
   * Main entry point: match a 9-slot (3x3) grid to a known recipe.
   * @param grid Array of 9 strings (item kinds). Empty string "" = empty slot.
   */
  public static findMatch(grid: string[]): CraftingRecipe | null {
    if (!grid || grid.length !== 9) return null;

    // Shapeless pre-calc: list of non-empty kinds
    const nonEmpties = grid.filter((k) => k && k !== "");

    for (const recipe of RECIPES) {
      if (recipe.type === "shapeless") {
        if (this.matchesShapeless(nonEmpties, recipe)) return recipe;
      } else {
        if (this.matchesShaped(grid, recipe)) return recipe;
      }
    }

    return null;
  }

  // ----------------------------------------------------------------
  // Shapeless Logic
  // ----------------------------------------------------------------
  private static matchesShapeless(inputs: string[], recipe: CraftingRecipe): boolean {
    if (!recipe.ingredients) return false;

    // Strict count match (Minecraft-like: must match exactly)
    if (inputs.length !== recipe.ingredients.length) return false;

    // Clone inputs so we can "consume" matches
    const remaining = [...inputs];

    for (const required of recipe.ingredients) {
      const idx = remaining.indexOf(required);
      if (idx === -1) return false; // Missing ingredient
      remaining.splice(idx, 1);
    }

    return true;
  }

  // ----------------------------------------------------------------
  // Shaped Logic
  // ----------------------------------------------------------------
  private static matchesShaped(grid: string[], recipe: CraftingRecipe): boolean {
    if (!recipe.pattern || !recipe.key) return false;

    // 1) Convert flat grid -> 3x3 matrix
    // 0 1 2
    // 3 4 5
    // 6 7 8
    const matrix: string[][] = [
      [grid[0], grid[1], grid[2]],
      [grid[3], grid[4], grid[5]],
      [grid[6], grid[7], grid[8]],
    ];

    // 2) Trim empty rows/cols from input to get bounding box
    const inputShape = this.trimMatrix(matrix);

    // If input is completely empty, it cannot match a shaped recipe
    if (!inputShape || inputShape.length === 0) return false;

    // 3) Parse recipe pattern into matrix of chars
    // e.g. ["###", " | ", " | "] -> [ ["#","#","#"], [" ","|"," "], [" ","|"," "] ]
    const recipeMatrix = recipe.pattern.map((row) => row.split(""));

    // 4) Dimensions must match exactly after trimming
    if (inputShape.length !== recipeMatrix.length) return false;
    if (!inputShape[0] || inputShape[0].length !== recipeMatrix[0].length) return false;

    // 5) Compare contents cell-by-cell
    for (let r = 0; r < inputShape.length; r++) {
      for (let c = 0; c < inputShape[0].length; c++) {
        const inputKind = inputShape[r][c];
        const keyChar = recipeMatrix[r][c];

        // Space in pattern means empty cell required
        if (keyChar === " ") {
          if (inputKind !== "") return false;
          continue;
        }

        // Otherwise the pattern expects an ingredient mapped by recipe.key
        const expected = recipe.key[keyChar];

        // If the keyChar doesn't exist in the key map, recipe is malformed
        if (!expected) return false;

        if (inputKind !== expected) return false;
      }
    }

    return true;
  }

  /**
   * Removes empty rows/cols from a 3x3 grid to find the "active" area
   * (the bounding box around all non-empty cells).
   *
   * Example:
   * Input:
   * [
   *  ["", "A", ""],
   *  ["", "A", ""],
   *  ["", "",  ""]
   * ]
   * Output:
   * [
   *  ["A"],
   *  ["A"]
   * ]
   */
  private static trimMatrix(matrix: string[][]): string[][] {
    // Find bounds containing all non-empty cells
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

    // Completely empty matrix
    if (maxR === -1) return [];

    // Slice out the bounding box
    const result: string[][] = [];
    for (let r = minR; r <= maxR; r++) {
      const row: string[] = [];
      for (let c = minC; c <= maxC; c++) {
        row.push(matrix[r][c]);
      }
      result.push(row);
    }

    return result;
  }
}
