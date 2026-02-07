// ============================================================
// server/crafting/CraftingSystem.ts  (FULL REWRITE - NO OMITS)
// ------------------------------------------------------------
// Supports:
// - 3x3 grid input (array of 9 kinds), "" for empty
// - Shapeless recipes: strict exact ingredient count + exact kinds (orderless)
// - Shaped recipes: supports BOTH
//    * minimal patterns (e.g. ["#", "#"])
//    * padded patterns (e.g. ["###", " | ", " | "])
//   by trimming BOTH the input grid and the recipe pattern to their bounding boxes,
//   then comparing kind-by-kind using recipe.key.
// Notes:
// - Pattern rows are normalized to a rectangular matrix (padEnd with " ")
// - " " in pattern means empty required at that cell
// - Any non-space char must exist in recipe.key and match expected kind exactly
// ============================================================

import { RECIPES, type CraftingRecipe } from "./Recipes.js";

export class CraftingSystem {
  /**
   * Main entry point: match a 9-slot (3x3) grid to a known recipe.
   * @param grid Array of 9 strings (item kinds). Empty string "" = empty slot.
   */
  public static findMatch(grid: string[]): CraftingRecipe | null {
    if (!grid || grid.length !== 9) return null;

    // Pre-calculate inputs for shapeless check
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
  // Shapeless Logic (strict count + exact kinds, orderless)
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
  // Shaped Logic (robust for minimal + padded patterns)
  // ----------------------------------------------------------------
  private static matchesShaped(grid: string[], recipe: CraftingRecipe): boolean {
    if (!recipe.pattern || !recipe.key) return false;

    // 1) Convert 9-slot grid -> 3x3 matrix of kinds
    // 0 1 2
    // 3 4 5
    // 6 7 8
    const inputMatrix: string[][] = [
      [String(grid[0] || ""), String(grid[1] || ""), String(grid[2] || "")],
      [String(grid[3] || ""), String(grid[4] || ""), String(grid[5] || "")],
      [String(grid[6] || ""), String(grid[7] || ""), String(grid[8] || "")],
    ];

    // 2) Trim empty rows/cols from INPUT to get bounding box
    const inputTrim = this.trimKindMatrix(inputMatrix);
    if (!inputTrim) return false; // completely empty input can't match shaped

    // 3) Normalize recipe pattern to rectangular char matrix (pad rows), then trim outer whitespace
    const recipeNorm = this.normalizePattern(recipe.pattern);
    const recipeTrim = this.trimPatternMatrix(recipeNorm);
    if (!recipeTrim) return false; // pattern is effectively empty

    // 4) Compare dimensions
    if (inputTrim.matrix.length !== recipeTrim.matrix.length) return false;
    if (inputTrim.matrix[0].length !== recipeTrim.matrix[0].length) return false;

    // 5) Compare content cell-by-cell
    const h = recipeTrim.matrix.length;
    const w = recipeTrim.matrix[0].length;

    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        const inputKind = inputTrim.matrix[r][c];
        const keyChar = recipeTrim.matrix[r][c];

        // Space in pattern means "must be empty here"
        if (keyChar === " ") {
          if (inputKind !== "") return false;
          continue;
        }

        // Non-space char must map to an expected kind
        const expected = recipe.key[keyChar];
        if (!expected) return false; // unknown symbol in recipe

        if (inputKind !== expected) return false;
      }
    }

    return true;
  }

  // ----------------------------------------------------------------
  // Helpers: Pattern normalization + trimming
  // ----------------------------------------------------------------

  /**
   * Normalize pattern rows into a rectangular character matrix.
   * Pads each row to max width using spaces.
   */
  private static normalizePattern(pattern: string[]): string[][] {
    const rows = Array.isArray(pattern) ? pattern : [];
    const maxW = rows.length ? Math.max(...rows.map((r) => (typeof r === "string" ? r.length : 0))) : 0;

    const matrix: string[][] = [];
    for (let r = 0; r < rows.length; r++) {
      const rowStr = typeof rows[r] === "string" ? rows[r] : "";
      const padded = rowStr.padEnd(maxW, " ");
      matrix.push(padded.split(""));
    }
    return matrix;
  }

  /**
   * Trim a kind matrix (strings) by removing fully-empty outer rows/cols.
   * Returns null if the matrix is entirely empty ("").
   */
  private static trimKindMatrix(matrix: string[][]): { matrix: string[][]; minR: number; minC: number } | null {
    const H = matrix.length;
    const W = H ? matrix[0].length : 0;

    let minR = H,
      maxR = -1,
      minC = W,
      maxC = -1;

    for (let r = 0; r < H; r++) {
      for (let c = 0; c < W; c++) {
        if (String(matrix[r][c] || "") !== "") {
          if (r < minR) minR = r;
          if (r > maxR) maxR = r;
          if (c < minC) minC = c;
          if (c > maxC) maxC = c;
        }
      }
    }

    if (maxR === -1) return null;

    const out: string[][] = [];
    for (let r = minR; r <= maxR; r++) {
      const row: string[] = [];
      for (let c = minC; c <= maxC; c++) row.push(String(matrix[r][c] || ""));
      out.push(row);
    }

    return { matrix: out, minR, minC };
  }

  /**
   * Trim a pattern matrix (chars) by removing fully-space outer rows/cols.
   * Returns null if the matrix is entirely spaces.
   */
  private static trimPatternMatrix(matrix: string[][]): { matrix: string[][]; minR: number; minC: number } | null {
    const H = matrix.length;
    const W = H ? matrix[0].length : 0;

    let minR = H,
      maxR = -1,
      minC = W,
      maxC = -1;

    for (let r = 0; r < H; r++) {
      for (let c = 0; c < W; c++) {
        const ch = String(matrix[r][c] ?? " ");
        if (ch !== " ") {
          if (r < minR) minR = r;
          if (r > maxR) maxR = r;
          if (c < minC) minC = c;
          if (c > maxC) maxC = c;
        }
      }
    }

    if (maxR === -1) return null;

    const out: string[][] = [];
    for (let r = minR; r <= maxR; r++) {
      const row: string[] = [];
      for (let c = minC; c <= maxC; c++) row.push(String(matrix[r][c] ?? " "));
      out.push(row);
    }

    return { matrix: out, minR, minC };
  }
}
