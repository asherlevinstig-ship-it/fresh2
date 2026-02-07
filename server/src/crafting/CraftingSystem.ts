// ============================================================
// server/crafting/CraftingSystem.ts
// ============================================================

import { RECIPES, CraftingRecipe, RecipeResult } from "./Recipes.js";

export class CraftingSystem {
  
  /**
   * Main entry point: specific logic to match a 9-slot (3x3) grid 
   * to a known recipe.
   * @param grid Array of 9 strings (item kinds). Empty string "" = empty slot.
   */
  public static findMatch(grid: string[]): CraftingRecipe | null {
    if (!grid || grid.length !== 9) return null;

    // Pre-calculate inputs for shapeless check
    const nonEmpties = grid.filter(k => k && k !== "");

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
    
    // Exact count match (strict)
    if (inputs.length !== recipe.ingredients.length) return false;

    // Clone to consume
    const remaining = [...inputs];

    for (const required of recipe.ingredients) {
      const idx = remaining.indexOf(required);
      if (idx === -1) return false; // Missing ingredient
      remaining.splice(idx, 1);
    }

    return true;
  }

  // ----------------------------------------------------------------
  // Shaped Logic (The Tricky Part)
  // ----------------------------------------------------------------
  private static matchesShaped(grid: string[], recipe: CraftingRecipe): boolean {
    if (!recipe.pattern || !recipe.key) return false;

    // 1. Convert Grid to Matrix
    // 0 1 2
    // 3 4 5
    // 6 7 8
    const matrix: string[][] = [
      [grid[0], grid[1], grid[2]],
      [grid[3], grid[4], grid[5]],
      [grid[6], grid[7], grid[8]]
    ];

    // 2. Trim empty rows/cols from input to get "bounding box"
    const inputShape = this.trimMatrix(matrix);
    
    // 3. Parse Recipe Pattern into Matrix
    // pattern: ["###", " | "] -> [ ["#","#","#"], [" ","|"," "] ]
    const recipeMatrix = recipe.pattern.map(row => row.split(""));
    
    // 4. Compare dimensions
    if (inputShape.length !== recipeMatrix.length) return false;
    if (inputShape[0].length !== recipeMatrix[0].length) return false;

    // 5. Compare content
    for (let r = 0; r < inputShape.length; r++) {
      for (let c = 0; c < inputShape[0].length; c++) {
        const inputKind = inputShape[r][c];
        const keyChar = recipeMatrix[r][c];

        // Space in pattern means "Empty"
        if (keyChar === " ") {
          if (inputKind !== "") return false;
        } else {
          // Look up expected kind
          const expected = recipe.key[keyChar];
          if (inputKind !== expected) return false;
        }
      }
    }

    return true;
  }

  /** Removes empty rows/cols from a 2D grid to find the "active" area */
  private static trimMatrix(matrix: string[][]): string[][] {
    // Find bounds
    let minR = 3, maxR = -1, minC = 3, maxC = -1;

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

    if (maxR === -1) return []; // Completely empty

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