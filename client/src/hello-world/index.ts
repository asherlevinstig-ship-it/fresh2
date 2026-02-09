// @ts-nocheck
/*
 * fresh2 - client main/index (PRODUCTION - BIOMES + TOWN FPS CLAMP + CHAT COMMANDS)
 * -----------------------------------------------------------------------
 * INCLUDES (NO OMITS):
 * - 3x3 Crafting Grid (Virtual Mapping Strategy)
 * - Inventory UI (Drag & Drop, Logic, Splitting)
 * - Server-Authoritative Logic (Colyseus) with Persistent ID
 * - World Generation (BIOME-AWARE: Plains/Forest/Desert/Tundra/Mountains/Swamp)
 * - 3D Rigs (FPS Hands + 3rd Person Avatars)
 * - Network Interpolation (Smooth movement)
 * - Debug Console (F4)
 * - Chat System (Enter to chat, supports /find, /goto, /biome)
 * - Dynamic Environment Switching (Localhost vs Prod)
 *
 * ADDED (Phase 2 Option A):
 * - Client-only render clamp while inside Town of Beginnings safe zone
 * - Reduced chunkAddDistance / chunkRemoveDistance
 * - Reduced camera maxZ (view distance)
 * - Optional fog (enabled inside town; disabled outside)
 *
 * ALSO FIXED:
 * - Register room.onMessage handlers for "welcome", "block:reject", "chat:sys"
 *
 * IMPORTANT:
 * - This file mirrors the server's biome/height/layer/ore logic via shared Biomes.ts
 */

import { Engine } from "noa-engine";
import * as BABYLON from "babylonjs";
import * as Colyseus from "colyseus.js";

/* ============================================================
 * 0. BIOMES (Shared Deterministic Math)
 * ============================================================
 */
import {
  sampleBiome,
  getTerrainLayerBlockId,
  shouldSpawnTree,
  getTreeSpec,
  shouldSpawnCactus,
  getCactusHeight,
  buildDefaultOreTablesFromPalette,
  pickOreId,
} from "../../world/Biomes";

/* ============================================================
 * 0.5 TOWN OF BEGINNINGS (Client-only render clamp region)
 * ============================================================
 */
const TOWN = {
  cx: 0,
  cz: 0,
  radius: 42,
  groundY: 10,
};

// Render clamp presets
const RENDER_PRESET_OUTSIDE = {
  chunkAddDistance: 2.5,
  chunkRemoveDistance: 3.5,
  cameraMaxZ: 220, // view distance
  fog: false,
  fogDensity: 0.0,
};

const RENDER_PRESET_TOWN = {
  chunkAddDistance: 1.35,
  chunkRemoveDistance: 2.15,
  cameraMaxZ: 120, // tighter view distance inside town
  fog: true,
  fogDensity: 0.018,
};

// Hysteresis helps avoid rapid toggling at boundary
const TOWN_HYSTERESIS = 3.0;

/* ============================================================
 * 1. RECIPE DATA & SYSTEM (Client-Side Prediction)
 * ============================================================
 */

const RECIPES = [
  {
    id: "planks_from_log",
    type: "shapeless",
    ingredients: ["block:log"],
    result: { kind: "block:plank", qty: 4 },
  },
  {
    id: "sticks",
    type: "shaped",
    pattern: ["#", "#"],
    key: { "#": "block:plank" },
    result: { kind: "item:stick", qty: 4 },
  },
  {
    id: "pickaxe_wood",
    type: "shaped",
    pattern: ["###", " | ", " | "],
    key: { "#": "block:plank", "|": "item:stick" },
    result: { kind: "tool:pickaxe_wood", qty: 1 },
  },
  {
    id: "pickaxe_stone",
    type: "shaped",
    pattern: ["###", " | ", " | "],
    key: { "#": "block:stone", "|": "item:stick" },
    result: { kind: "tool:pickaxe_stone", qty: 1 },
  },
  // Expanded
  {
    id: "crafting_table",
    type: "shaped",
    pattern: ["##", "##"],
    key: { "#": "block:plank" },
    result: { kind: "block:crafting_table", qty: 1 },
  },
  {
    id: "chest",
    type: "shaped",
    pattern: ["###", "# #", "###"],
    key: { "#": "block:plank" },
    result: { kind: "block:chest", qty: 1 },
  },
  {
    id: "slab_plank",
    type: "shaped",
    pattern: ["###"],
    key: { "#": "block:plank" },
    result: { kind: "block:slab_plank", qty: 6 },
  },
  {
    id: "stairs_plank",
    type: "shaped",
    pattern: ["#  ", "## ", "###"],
    key: { "#": "block:plank" },
    result: { kind: "block:stairs_plank", qty: 4 },
  },
  {
    id: "door_wood",
    type: "shaped",
    pattern: ["##", "##", "##"],
    key: { "#": "block:plank" },
    result: { kind: "block:door_wood", qty: 1 },
  },
  {
    id: "axe_wood",
    type: "shaped",
    pattern: ["## ", "#| ", " | "],
    key: { "#": "block:plank", "|": "item:stick" },
    result: { kind: "tool:axe_wood", qty: 1 },
  },
  {
    id: "shovel_wood",
    type: "shaped",
    pattern: ["# ", "| ", "| "],
    key: { "#": "block:plank", "|": "item:stick" },
    result: { kind: "tool:shovel_wood", qty: 1 },
  },
  {
    id: "sword_wood",
    type: "shaped",
    pattern: ["#", "#", "|"],
    key: { "#": "block:plank", "|": "item:stick" },
    result: { kind: "tool:sword_wood", qty: 1 },
  },
  {
    id: "axe_stone",
    type: "shaped",
    pattern: ["## ", "#| ", " | "],
    key: { "#": "block:stone", "|": "item:stick" },
    result: { kind: "tool:axe_stone", qty: 1 },
  },
  {
    id: "shovel_stone",
    type: "shaped",
    pattern: ["# ", "| ", "| "],
    key: { "#": "block:stone", "|": "item:stick" },
    result: { kind: "tool:shovel_stone", qty: 1 },
  },
  {
    id: "sword_stone",
    type: "shaped",
    pattern: ["#", "#", "|"],
    key: { "#": "block:stone", "|": "item:stick" },
    result: { kind: "tool:sword_stone", qty: 1 },
  },
  {
    id: "club_wood",
    type: "shapeless",
    ingredients: ["block:plank", "item:stick"],
    result: { kind: "tool:club_wood", qty: 1 },
  },
  {
    id: "wand_training",
    type: "shapeless",
    ingredients: ["item:stick", "block:plank"],
    result: { kind: "tool:wand_training", qty: 1 },
  },
];

const CraftingSystem = {
  findMatch(gridKinds) {
    if (!gridKinds || gridKinds.length !== 9) return null;
    const nonEmpties = gridKinds.filter((k) => k && k !== "");

    for (const recipe of RECIPES) {
      if (recipe.type === "shapeless") {
        if (this.matchesShapeless(nonEmpties, recipe)) return recipe;
      } else {
        if (this.matchesShaped(gridKinds, recipe)) return recipe;
      }
    }
    return null;
  },

  matchesShapeless(inputs, recipe) {
    if (!recipe.ingredients) return false;
    if (inputs.length !== recipe.ingredients.length) return false;
    const remaining = [...inputs];
    for (const required of recipe.ingredients) {
      const idx = remaining.indexOf(required);
      if (idx === -1) return false;
      remaining.splice(idx, 1);
    }
    return true;
  },

  matchesShaped(grid, recipe) {
    if (!recipe.pattern || !recipe.key) return false;
    const matrix = [
      [grid[0], grid[1], grid[2]],
      [grid[3], grid[4], grid[5]],
      [grid[6], grid[7], grid[8]],
    ];
    const inputShape = this.trimMatrix(matrix);
    const recipeMatrix = recipe.pattern.map((row) => row.split(""));

    if (inputShape.length !== recipeMatrix.length) return false;
    if (!inputShape[0] || inputShape[0].length !== recipeMatrix[0].length) return false;

    for (let r = 0; r < inputShape.length; r++) {
      for (let c = 0; c < inputShape[0].length; c++) {
        const inputKind = inputShape[r][c];
        const keyChar = recipeMatrix[r][c];
        if (keyChar === " ") {
          if (inputKind !== "") return false;
        } else {
          const expected = recipe.key[keyChar];
          if (inputKind !== expected) return false;
        }
      }
    }
    return true;
  },

  trimMatrix(matrix) {
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
    if (maxR === -1) return [];
    const res = [];
    for (let r = minR; r <= maxR; r++) {
      const row = [];
      for (let c = minC; c <= maxC; c++) row.push(matrix[r][c]);
      res.push(row);
    }
    return res;
  },
};

/* ============================================================
 * 2. NOA ENGINE SETUP
 * ============================================================
 */

const opts = {
  debug: true,
  showFPS: true,
  chunkSize: 32,
  chunkAddDistance: RENDER_PRESET_OUTSIDE.chunkAddDistance,
  chunkRemoveDistance: RENDER_PRESET_OUTSIDE.chunkRemoveDistance,
  stickyPointerLock: true,
  dragCameraOutsidePointerLock: true,
  initialZoom: 0,
  zoomSpeed: 0.25,
};

const noa = new Engine(opts);
console.log("noa-engine booted:", noa.version);

/* ============================================================
 * 3. GLOBAL STATE
 * ============================================================
 */

let viewMode = 0; // 0 = first, 1 = third
let inventoryOpen = false;
let chatOpen = false; // NEW

// Multiplayer
let colyRoom = null;
const remotePlayers = {}; // { [sid]: { mesh, targetPos } }

// Render clamp state
let inTown = false;
let lastTownToggleAt = 0;

// Client State
const LOCAL_INV = {
  cols: 9,
  rows: 4,
  slots: [], // uid strings
  items: {}, // uid -> ItemState
  equip: { head: "", chest: "", legs: "", feet: "", tool: "", offhand: "" },
};

// Crafting State
const LOCAL_CRAFT = {
  indices: new Array(9).fill(-1),
  result: null,
};

const LOCAL_HOTBAR = { index: 0 };
const LOCAL_STATS = { hp: 20, maxHp: 20, stamina: 100, maxStamina: 100 };

const MESH = {
  weaponRoot: null,
  armR: null,
  tool: null, // FPS
  avatarRoot: null, // TPS (Local)
};

const STATE = {
  scene: null,
  lastTime: performance.now(),
  bobPhase: 0,
  swingT: 999,
  swingDuration: 0.22,
  moveAccum: 0,

  // ---- Spawn/patch safety ----
  worldReady: false,
  spawnSnapDone: false,
  pendingTeleport: null,
  desiredSpawn: { x: 0, y: TOWN.groundY + 2, z: 0 },
  freezeUntil: performance.now() + 8000,
  lastPosLogAt: 0,
  logPos: false, // toggle via F8
};

/* ============================================================
 * 4. UI: DEBUG CONSOLE
 * ============================================================
 */

const UI_CONSOLE = (() => {
  const wrap = document.createElement("div");
  wrap.id = "ui-console";
  Object.assign(wrap.style, {
    position: "fixed",
    left: "14px",
    bottom: "90px",
    width: "min(600px, 90vw)",
    maxHeight: "300px",
    zIndex: "10050",
    display: "none",
    pointerEvents: "none",
    fontFamily: "monospace",
    color: "white",
    fontSize: "12px",
    textShadow: "1px 1px 0 #000",
  });

  const scroller = document.createElement("div");
  Object.assign(scroller.style, {
    background: "rgba(0,0,0,0.6)",
    padding: "10px",
    borderRadius: "8px",
    overflowY: "auto",
    maxHeight: "100%",
    pointerEvents: "auto",
  });

  wrap.appendChild(scroller);
  document.body.appendChild(wrap);

  function log(msg, color = "#fff") {
    const el = document.createElement("div");
    el.textContent = `> ${msg}`;
    el.style.color = color;
    scroller.appendChild(el);
    scroller.scrollTop = scroller.scrollHeight;
  }

  return {
    log: (m) => log(m),
    warn: (m) => log(m, "#ffaa00"),
    error: (m) => log(m, "#ff5555"),
    toggle: () => {
      wrap.style.display = wrap.style.display === "none" ? "block" : "none";
    },
  };
})();

const uiLog = UI_CONSOLE.log;

/* ============================================================
 * 4.5 UI: CHAT (NEW)
 * ============================================================
 */

function createChatUI() {
  const wrap = document.createElement("div");
  Object.assign(wrap.style, {
    position: "fixed",
    left: "14px",
    bottom: "150px", // Above hotbar/console
    width: "400px",
    height: "200px",
    display: "flex",
    flexDirection: "column",
    gap: "5px",
    zIndex: "10060",
    pointerEvents: "none", // click through when closed
  });

  // Log Area
  const logArea = document.createElement("div");
  Object.assign(logArea.style, {
    flex: "1",
    overflowY: "auto",
    background: "rgba(0,0,0,0.4)",
    borderRadius: "6px",
    padding: "8px",
    fontFamily: "monospace",
    fontSize: "13px",
    color: "white",
    textShadow: "1px 1px 0 #000",
    display: "flex",
    flexDirection: "column",
    justifyContent: "flex-end",
    maskImage: "linear-gradient(to bottom, transparent, black 10%)",
  });

  // Input Area
  const input = document.createElement("input");
  Object.assign(input.style, {
    width: "100%",
    background: "rgba(0,0,0,0.7)",
    border: "1px solid #555",
    color: "white",
    padding: "8px",
    borderRadius: "4px",
    outline: "none",
    fontFamily: "monospace",
    display: "none", // Hidden by default
    pointerEvents: "auto",
  });

  wrap.appendChild(logArea);
  wrap.appendChild(input);
  document.body.appendChild(wrap);

  function addMsg(text, color = "#eee") {
    const el = document.createElement("div");
    el.textContent = text;
    el.style.color = color;
    el.style.marginBottom = "2px";
    logArea.appendChild(el);
    logArea.scrollTop = logArea.scrollHeight;
    
    // Auto-fade older messages could be added here
  }

  return {
    add: addMsg,
    toggle: () => {
      chatOpen = !chatOpen;
      if (chatOpen) {
        input.style.display = "block";
        document.exitPointerLock();
        input.focus();
        wrap.style.pointerEvents = "auto";
      } else {
        input.style.display = "none";
        input.value = "";
        noa.container.canvas.requestPointerLock();
        wrap.style.pointerEvents = "none";
      }
    },
    isOpen: () => chatOpen,
    input,
  };
}

const chatUI = createChatUI();

/* ============================================================
 * 5. UI: INVENTORY & CRAFTING
 * ============================================================
 */

function createInventoryOverlay() {
  const overlay = document.createElement("div");
  Object.assign(overlay.style, {
    position: "fixed",
    inset: "0",
    display: "none",
    zIndex: "9998",
    background: "rgba(0,0,0,0.5)",
    backdropFilter: "blur(4px)",
  });

  const panel = document.createElement("div");
  Object.assign(panel.style, {
    position: "absolute",
    left: "50%",
    top: "50%",
    transform: "translate(-50%, -50%)",
    width: "min(800px, 95vw)",
    background: "rgba(30,30,35,0.95)",
    borderRadius: "12px",
    border: "1px solid #444",
    boxShadow: "0 10px 40px rgba(0,0,0,0.5)",
    padding: "20px",
    display: "grid",
    gridTemplateColumns: "240px 1fr",
    gap: "20px",
    fontFamily: "system-ui, sans-serif",
    color: "#eee",
  });

  // --- Left: Crafting & Equip ---
  const leftCol = document.createElement("div");
  leftCol.innerHTML = `<div style="font-weight:bold; margin-bottom:8px">Crafting</div>`;

  const craftWrap = document.createElement("div");
  Object.assign(craftWrap.style, {
    display: "flex",
    gap: "10px",
    alignItems: "center",
    background: "#222",
    padding: "10px",
    borderRadius: "8px",
    border: "1px solid #333",
  });

  // 3x3 Grid
  const craftGrid = document.createElement("div");
  Object.assign(craftGrid.style, {
    display: "grid",
    gridTemplateColumns: "repeat(3, 48px)",
    gap: "4px",
  });
  const craftCells = [];
  for (let i = 0; i < 9; i++) {
    const { cell, icon, qty } = makeSlot(`craft:${i}`);
    cell.appendChild(icon);
    cell.appendChild(qty);
    craftGrid.appendChild(cell);
    craftCells.push({ cell, icon, qty });
  }

  // Result
  const resWrap = document.createElement("div");
  const { cell: resCell, icon: resIcon, qty: resQty } = makeSlot("craft:result");
  resCell.style.border = "1px solid #6c6";
  resCell.appendChild(resIcon);
  resCell.appendChild(resQty);
  resWrap.appendChild(resCell);

  craftWrap.appendChild(craftGrid);
  craftWrap.appendChild(document.createTextNode("→"));
  craftWrap.appendChild(resWrap);
  leftCol.appendChild(craftWrap);

  // Equipment
  leftCol.appendChild(document.createElement("hr"));
  const eqGrid = document.createElement("div");
  Object.assign(eqGrid.style, {
    display: "grid",
    gridTemplateColumns: "repeat(3, 48px)",
    gap: "4px",
  });
  const eqKeys = ["head", "chest", "legs", "feet", "tool", "offhand"];
  const eqCells = {};
  eqKeys.forEach((k) => {
    const { cell, icon, qty } = makeSlot(`eq:${k}`);
    cell.appendChild(icon);
    cell.appendChild(qty);
    eqCells[k] = { cell, icon, qty };
    eqGrid.appendChild(cell);
  });
  leftCol.appendChild(eqGrid);

  // --- Right: Inventory ---
  const rightCol = document.createElement("div");
  rightCol.innerHTML = `<div style="font-weight:bold; margin-bottom:8px">Inventory</div>`;

  const invGrid = document.createElement("div");
  Object.assign(invGrid.style, {
    display: "grid",
    gridTemplateColumns: "repeat(9, 48px)",
    gap: "4px",
  });
  const invCells = [];
  for (let i = 0; i < 36; i++) {
    const { cell, icon, qty } = makeSlot(`inv:${i}`);
    cell.appendChild(icon);
    cell.appendChild(qty);
    invGrid.appendChild(cell);
    invCells.push({ cell, icon, qty });
  }
  rightCol.appendChild(invGrid);

  panel.appendChild(leftCol);
  panel.appendChild(rightCol);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  // --- Helpers ---
  function makeSlot(id) {
    const cell = document.createElement("div");
    cell.dataset.id = id;
    Object.assign(cell.style, {
      width: "48px",
      height: "48px",
      background: "rgba(255,255,255,0.05)",
      border: "1px solid #444",
      borderRadius: "4px",
      position: "relative",
      cursor: "pointer",
      userSelect: "none",
    });
    const icon = document.createElement("div");
    Object.assign(icon.style, {
      position: "absolute",
      inset: "2px",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      fontSize: "10px",
      textAlign: "center",
      pointerEvents: "none",
    });
    const qty = document.createElement("div");
    Object.assign(qty.style, {
      position: "absolute",
      bottom: "1px",
      right: "2px",
      fontSize: "11px",
      fontWeight: "bold",
      pointerEvents: "none",
    });
    return { cell, icon, qty };
  }

  function getInvItem(idx) {
    if (idx < 0 || idx >= LOCAL_INV.slots.length) return null;
    const uid = LOCAL_INV.slots[idx];
    return uid ? LOCAL_INV.items[uid] : null;
  }

  function getItemShort(kind) {
    return kind ? kind.split(":")[1] || kind : "";
  }

  // --- Render Loop ---
  function refresh() {
    // Inventory
    for (let i = 0; i < 36; i++) {
      const it = getInvItem(i);
      invCells[i].icon.textContent = it ? getItemShort(it.kind) : "";
      invCells[i].qty.textContent = it && it.qty > 1 ? it.qty : "";

      const isCraftUsed = LOCAL_CRAFT.indices.includes(i);
      invCells[i].cell.style.opacity = isCraftUsed ? "0.3" : "1";
    }

    // Crafting
    for (let i = 0; i < 9; i++) {
      const invIdx = LOCAL_CRAFT.indices[i];
      const it = getInvItem(invIdx);
      craftCells[i].icon.textContent = it ? getItemShort(it.kind) : "";
      craftCells[i].qty.textContent = it && it.qty > 1 ? it.qty : "";
    }

    // Result
    const res = LOCAL_CRAFT.result;
    resIcon.textContent = res ? getItemShort(res.kind) : "";
    resQty.textContent = res ? res.qty : "";

    // Equip
    eqKeys.forEach((k) => {
      const uid = LOCAL_INV.equip[k];
      const it = uid ? LOCAL_INV.items[uid] : null;
      eqCells[k].icon.textContent = it ? getItemShort(it.kind) : "";
      eqCells[k].qty.textContent = "";
    });
  }

  // --- Drag & Drop Logic ---
  const drag = { active: false, srcId: null, invIdx: -1, ghost: null };

  function startDrag(e, slotId) {
    let it = null;
    let invIdx = -1;

    if (slotId.startsWith("inv:")) {
      invIdx = parseInt(slotId.split(":")[1]);
      if (LOCAL_CRAFT.indices.includes(invIdx)) return; // Locked
      it = getInvItem(invIdx);
    } else if (slotId.startsWith("craft:")) {
      const cIdx = parseInt(slotId.split(":")[1]);
      if (isNaN(cIdx)) return; // result slot
      invIdx = LOCAL_CRAFT.indices[cIdx];
      it = getInvItem(invIdx);
    }

    if (!it) return;

    drag.active = true;
    drag.srcId = slotId;
    drag.invIdx = invIdx;

    const g = document.createElement("div");
    g.textContent = getItemShort(it.kind);
    Object.assign(g.style, {
      position: "fixed",
      background: "#222",
      border: "1px solid white",
      padding: "4px",
      pointerEvents: "none",
      zIndex: "10001",
      borderRadius: "4px",
      color: "#fff",
    });
    document.body.appendChild(g);
    drag.ghost = g;
    moveGhost(e);
  }

  function moveGhost(e) {
    if (drag.ghost) {
      drag.ghost.style.left = e.clientX + 10 + "px";
      drag.ghost.style.top = e.clientY + 10 + "px";
    }
  }

  function endDrag(e) {
    if (!drag.active) return;
    drag.ghost.remove();
    drag.active = false;

    const el = document.elementFromPoint(e.clientX, e.clientY);
    const dropSlot = el ? el.closest("[data-id]") : null;

    if (!dropSlot) {
      if (drag.srcId.startsWith("craft:")) {
        const cIdx = parseInt(drag.srcId.split(":")[1]);
        LOCAL_CRAFT.indices[cIdx] = -1;
        updateCraft();
        refresh();
      }
      return;
    }

    const destId = dropSlot.dataset.id;

    // 1) Drop onto Crafting Grid
    if (destId.startsWith("craft:") && !destId.includes("result")) {
      const cIdx = parseInt(destId.split(":")[1]);

      // If dragging FROM craft, swap indices
      if (drag.srcId.startsWith("craft:")) {
        const oldCIdx = parseInt(drag.srcId.split(":")[1]);
        const temp = LOCAL_CRAFT.indices[cIdx];
        LOCAL_CRAFT.indices[cIdx] = LOCAL_CRAFT.indices[oldCIdx];
        LOCAL_CRAFT.indices[oldCIdx] = temp;
      } else {
        // Dragging FROM inv
        LOCAL_CRAFT.indices[cIdx] = drag.invIdx;
      }
      updateCraft();
      refresh();
      return;
    }

    // 2) Drop onto Inventory
    if (destId.startsWith("inv:")) {
      // If coming from Craft, just clear craft slot
      if (drag.srcId.startsWith("craft:")) {
        const cIdx = parseInt(drag.srcId.split(":")[1]);
        LOCAL_CRAFT.indices[cIdx] = -1;
        updateCraft();
        refresh();
        return;
      }
      // If coming from Inv, move item (Server)
      if (colyRoom && drag.srcId !== destId) {
        colyRoom.send("inv:move", { from: drag.srcId, to: destId });
      }
    }
  }

  function updateCraft() {
    const kinds = LOCAL_CRAFT.indices.map((idx) => {
      const it = getInvItem(idx);
      return it ? it.kind : "";
    });
    const match = CraftingSystem.findMatch(kinds);
    LOCAL_CRAFT.result = match ? match.result : null;
  }

  // Bind Events
  window.addEventListener("mousemove", (e) => {
    if (drag.active) moveGhost(e);
  });
  window.addEventListener("mouseup", endDrag);

  // Slot Clicks
  [...invCells, ...craftCells, ...Object.values(eqCells), { cell: resCell }].forEach((o) => {
    o.cell.addEventListener("mousedown", (e) => {
      const id = o.cell.dataset.id;
      if (id === "craft:result") {
        if (LOCAL_CRAFT.result && colyRoom) {
          colyRoom.send("craft:commit", { srcIndices: LOCAL_CRAFT.indices });
        }
      } else {
        startDrag(e, id);
      }
    });
  });

  return {
    toggle: () => {
      const open = overlay.style.display === "none";
      overlay.style.display = open ? "block" : "none";
      if (open) {
        refresh();
        document.exitPointerLock();
      } else {
        noa.container.canvas.requestPointerLock();
      }
      inventoryOpen = open;
    },
    refresh,
    isOpen: () => overlay.style.display !== "none",
  };
}

const inventoryUI = createInventoryOverlay();

/* ============================================================
 * 6. UI: HOTBAR (DOM Overlay)
 * ============================================================
 */

function createHotbarUI() {
  const div = document.createElement("div");
  Object.assign(div.style, {
    position: "fixed",
    bottom: "10px",
    left: "50%",
    transform: "translateX(-50%)",
    display: "flex",
    gap: "5px",
    padding: "5px",
    background: "rgba(0,0,0,0.5)",
    borderRadius: "8px",
  });

  const slots = [];
  for (let i = 0; i < 9; i++) {
    const s = document.createElement("div");
    Object.assign(s.style, {
      width: "50px",
      height: "50px",
      border: "2px solid #555",
      borderRadius: "4px",
      position: "relative",
      background: "rgba(0,0,0,0.3)",
    });
    const icon = document.createElement("div");
    Object.assign(icon.style, {
      position: "absolute",
      inset: "0",
      display: "flex",
      justifyContent: "center",
      alignItems: "center",
      color: "white",
      fontSize: "10px",
      textAlign: "center",
    });
    const qty = document.createElement("div");
    Object.assign(qty.style, {
      position: "absolute",
      bottom: "2px",
      right: "2px",
      fontSize: "10px",
      fontWeight: "bold",
      color: "#fff",
    });
    s.appendChild(icon);
    s.appendChild(qty);
    div.appendChild(s);
    slots.push({ s, icon, qty });
  }
  document.body.appendChild(div);

  return {
    refresh: () => {
      for (let i = 0; i < 9; i++) {
        const uid = LOCAL_INV.slots[i];
        const it = uid ? LOCAL_INV.items[uid] : null;
        slots[i].s.style.borderColor = i === LOCAL_HOTBAR.index ? "white" : "#555";
        slots[i].icon.textContent = it ? it.kind.split(":")[1] : "";
        slots[i].qty.textContent = it && it.qty > 1 ? it.qty : "";
      }
    },
  };
}

const hotbarUI = createHotbarUI();

/* ============================================================
 * 7. WORLD GENERATION (BIOMES + ORES, MATCHES SERVER)
 * ============================================================
 */

// Materials (RGB 0..1 arrays)
const mats = {
  dirt: [0.45, 0.36, 0.22],
  grass: [0.1, 0.8, 0.2],
  stone: [0.5, 0.5, 0.5],
  bedrock: [0.2, 0.2, 0.2],
  log: [0.4, 0.3, 0.1],
  leaves: [0.2, 0.6, 0.2],
  planks: [0.6, 0.45, 0.25],

  sand: [0.85, 0.8, 0.55],
  snow: [0.92, 0.94, 0.98],
  clay: [0.6, 0.62, 0.7],
  gravel: [0.55, 0.55, 0.55],
  mud: [0.28, 0.22, 0.18],
  ice: [0.7, 0.85, 1.0],

  coal_ore: [0.25, 0.25, 0.25],
  copper_ore: [0.72, 0.42, 0.25],
  iron_ore: [0.76, 0.65, 0.55],
  silver_ore: [0.78, 0.78, 0.85],
  gold_ore: [0.9, 0.78, 0.2],

  ruby_ore: [0.85, 0.15, 0.25],
  sapphire_ore: [0.15, 0.35, 0.9],
  mythril_ore: [0.3, 0.9, 0.85],
  dragonstone: [0.5, 0.1, 0.75],

  crafting_table: [0.55, 0.35, 0.18],
  chest: [0.58, 0.38, 0.18],
  slab_plank: [0.62, 0.5, 0.3],
  stairs_plank: [0.62, 0.5, 0.3],
  door_wood: [0.5, 0.32, 0.15],
};

Object.keys(mats).forEach((k) => noa.registry.registerMaterial(k, { color: mats[k] }));

// Register blocks with EXACT server IDs
const ID = {
  dirt: noa.registry.registerBlock(1, { material: "dirt" }),
  grass: noa.registry.registerBlock(2, { material: "grass" }),
  stone: noa.registry.registerBlock(3, { material: "stone" }),
  bedrock: noa.registry.registerBlock(4, { material: "bedrock" }),
  log: noa.registry.registerBlock(5, { material: "log" }),
  leaves: noa.registry.registerBlock(6, { material: "leaves" }),
  planks: noa.registry.registerBlock(7, { material: "planks" }),

  sand: noa.registry.registerBlock(8, { material: "sand" }),
  snow: noa.registry.registerBlock(9, { material: "snow" }),
  clay: noa.registry.registerBlock(10, { material: "clay" }),
  gravel: noa.registry.registerBlock(11, { material: "gravel" }),
  mud: noa.registry.registerBlock(12, { material: "mud" }),
  ice: noa.registry.registerBlock(13, { material: "ice" }),

  coal_ore: noa.registry.registerBlock(14, { material: "coal_ore" }),
  copper_ore: noa.registry.registerBlock(15, { material: "copper_ore" }),
  iron_ore: noa.registry.registerBlock(16, { material: "iron_ore" }),
  silver_ore: noa.registry.registerBlock(17, { material: "silver_ore" }),
  gold_ore: noa.registry.registerBlock(18, { material: "gold_ore" }),

  ruby_ore: noa.registry.registerBlock(19, { material: "ruby_ore" }),
  sapphire_ore: noa.registry.registerBlock(20, { material: "sapphire_ore" }),
  mythril_ore: noa.registry.registerBlock(21, { material: "mythril_ore" }),
  dragonstone: noa.registry.registerBlock(22, { material: "dragonstone" }),

  crafting_table: noa.registry.registerBlock(23, { material: "crafting_table" }),
  chest: noa.registry.registerBlock(24, { material: "chest" }),
  slab_plank: noa.registry.registerBlock(25, { material: "slab_plank" }),
  stairs_plank: noa.registry.registerBlock(26, { material: "stairs_plank" }),
  door_wood: noa.registry.registerBlock(27, { material: "door_wood" }),
};

// Palette object expected by shared Biomes.ts helpers
const PALETTE = {
  AIR: 0,
  DIRT: 1,
  GRASS: 2,
  STONE: 3,
  BEDROCK: 4,
  LOG: 5,
  LEAVES: 6,

  SAND: 8,
  SNOW: 9,
  CLAY: 10,
  GRAVEL: 11,
  MUD: 12,
  ICE: 13,

  COAL_ORE: 14,
  COPPER_ORE: 15,
  IRON_ORE: 16,
  SILVER_ORE: 17,
  GOLD_ORE: 18,

  RUBY_ORE: 19,
  SAPPHIRE_ORE: 20,
  MYTHRIL_ORE: 21,
  DRAGONSTONE: 22,
};

const ORE_TABLES = buildDefaultOreTablesFromPalette(PALETTE);

function getVoxelID(x, y, z) {
  if (y < -10) return ID.bedrock;

  const sb = sampleBiome(x, z);
  const biome = sb.biome;
  const height = sb.height;

  // Above ground: air except deterministic vegetation
  if (y > height) {
    const maxVegetationY = height + 8;
    if (y >= maxVegetationY) return 0;

    if (shouldSpawnTree(x, z, biome)) {
      const spec = getTreeSpec(x, z, biome);
      const treeBaseY = height + 1;
      const trunkTopY = treeBaseY + spec.trunkHeight - 1;

      if (y >= treeBaseY && y <= trunkTopY) {
        return ID.log;
      }

      const dy = y - trunkTopY;
      if (spec.type === "oak") {
        if (y >= trunkTopY - 1 && y <= trunkTopY + 2) {
          if (dy > 0) return ID.leaves;
        }
      } else {
        if (y >= trunkTopY && y <= trunkTopY + 3) {
          if (dy > 0) return ID.leaves;
        }
      }
    }

    if (shouldSpawnCactus(x, z, biome)) {
      const cactusBaseY = height + 1;
      const cactusH = getCactusHeight(x, z);
      if (y >= cactusBaseY && y < cactusBaseY + cactusH) {
        return ID.log;
      }
    }
    return 0;
  }

  const depth = height - y;
  const terrainNumericId = getTerrainLayerBlockId(PALETTE, biome, depth);

  if (terrainNumericId === PALETTE.STONE) {
    const oreId = pickOreId(x, y, z, biome, height, ORE_TABLES);
    return oreId || ID.stone;
  }

  return terrainNumericId;
}

noa.world.on("worldDataNeeded", (id, data, x, y, z) => {
  for (let i = 0; i < data.shape[0]; i++) {
    for (let j = 0; j < data.shape[1]; j++) {
      for (let k = 0; k < data.shape[2]; k++) {
        data.set(i, j, k, getVoxelID(x + i, y + j, z + k));
      }
    }
  }
  noa.world.setChunkData(id, data);
});

/* ============================================================
 * 8. VISUALS: RIGS & ANIMATION
 * ============================================================
 */

function createSolidMat(scene, name, col) {
  const m = new BABYLON.StandardMaterial(name, scene);
  m.diffuseColor = new BABYLON.Color3(...col);
  return m;
}

function initFpsRig(scene) {
  if (MESH.weaponRoot) return;
  const cam = scene.activeCamera;
  const root = new BABYLON.TransformNode("weaponRoot", scene);
  root.parent = cam;

  const armMat = createSolidMat(scene, "armMat", [0.2, 0.8, 0.2]);
  const toolMat = createSolidMat(scene, "toolMat", [0.8, 0.8, 0.8]);

  const armR = BABYLON.MeshBuilder.CreateBox("armR", { width: 0.3, height: 0.8, depth: 0.3 }, scene);
  armR.material = armMat;
  armR.parent = root;
  armR.position.set(0.5, -0.5, 1);
  armR.rotation.set(0.5, 0, 0);

  const tool = BABYLON.MeshBuilder.CreateBox("tool", { width: 0.1, height: 0.1, depth: 0.6 }, scene);
  tool.material = toolMat;
  tool.parent = armR;
  tool.position.set(0, 0.5, 0.2);

  [armR, tool].forEach((m) => {
    noa.rendering.addMeshToScene(m, false);
    m.isPickable = false;
  });

  MESH.weaponRoot = root;
  MESH.armR = armR;
  MESH.tool = tool;
}

function createAvatar(scene) {
  const root = new BABYLON.TransformNode("avRoot", scene);
  const skin = createSolidMat(scene, "skin", [1, 0.8, 0.6]);
  const shirt = createSolidMat(scene, "shirt", [0.2, 0.4, 0.9]);

  const head = BABYLON.MeshBuilder.CreateBox("head", { size: 0.5 }, scene);
  head.material = skin;
  head.parent = root;
  head.position.y = 1.6;

  const body = BABYLON.MeshBuilder.CreateBox("body", { width: 0.5, height: 0.8, depth: 0.25 }, scene);
  body.material = shirt;
  body.parent = root;
  body.position.y = 0.9;

  [head, body].forEach((m) => {
    noa.rendering.addMeshToScene(m, false);
    m.isPickable = false;
  });

  return { root, head, body };
}

function updateRigAnim(dt) {
  if (viewMode === 0 && MESH.weaponRoot) {
    const vel = noa.entities.getPhysicsBody(noa.playerEntity).velocity;
    const moving = Math.abs(vel[0]) > 0.1 || Math.abs(vel[2]) > 0.1;

    if (moving) STATE.bobPhase += dt * 10;
    MESH.weaponRoot.position.y = Math.sin(STATE.bobPhase) * 0.02;
    MESH.weaponRoot.position.x = Math.cos(STATE.bobPhase) * 0.02;
  }

  STATE.swingT += dt;
  if (STATE.swingT < STATE.swingDuration) {
    const prog = STATE.swingT / STATE.swingDuration;
    const ang = Math.sin(prog * Math.PI) * 1.5;
    if (MESH.armR) MESH.armR.rotation.x = 0.5 + ang;
  } else {
    if (MESH.armR) MESH.armR.rotation.x = 0.5;
  }
}

/* ============================================================
 * 8.5 CLIENT-ONLY RENDER CLAMP (Town radius)
 * ============================================================
 */

function distXZ(ax, az, bx, bz) {
  const dx = ax - bx;
  const dz = az - bz;
  return Math.sqrt(dx * dx + dz * dz);
}

function isInsideTown(x, z, alreadyInside) {
  const d = distXZ(x, z, TOWN.cx, TOWN.cz);
  const r = TOWN.radius + (alreadyInside ? TOWN_HYSTERESIS : -TOWN_HYSTERESIS);
  return d <= r;
}

function applyRenderPreset(scene, preset) {
  try {
    if (noa?.world) {
      if ("chunkAddDistance" in noa.world) noa.world.chunkAddDistance = preset.chunkAddDistance;
      if ("chunkRemoveDistance" in noa.world) noa.world.chunkRemoveDistance = preset.chunkRemoveDistance;

      if (noa.world._chunkMgr) {
        if ("chunkAddDistance" in noa.world._chunkMgr) noa.world._chunkMgr.chunkAddDistance = preset.chunkAddDistance;
        if ("chunkRemoveDistance" in noa.world._chunkMgr) noa.world._chunkMgr.chunkRemoveDistance = preset.chunkRemoveDistance;
      }
      if (noa.world._chunkManager) {
        if ("chunkAddDistance" in noa.world._chunkManager) noa.world._chunkManager.chunkAddDistance = preset.chunkAddDistance;
        if ("chunkRemoveDistance" in noa.world._chunkManager) noa.world._chunkManager.chunkRemoveDistance = preset.chunkRemoveDistance;
      }
    }
  } catch (e) {}

  try {
    if (noa?.rendering?.getScene) {
      const sc = scene || noa.rendering.getScene();
      if (sc && sc.activeCamera) {
        sc.activeCamera.maxZ = preset.cameraMaxZ;
      }
    }
  } catch (e) {}

  try {
    if (!scene) return;
    if (preset.fog) {
      scene.fogMode = BABYLON.Scene.FOGMODE_EXP2;
      scene.fogDensity = preset.fogDensity || 0.01;
      if (scene.clearColor) {
        scene.fogColor = new BABYLON.Color3(scene.clearColor.r, scene.clearColor.g, scene.clearColor.b);
      }
    } else {
      scene.fogMode = BABYLON.Scene.FOGMODE_NONE;
      scene.fogDensity = 0;
    }
  } catch (e) {}
}

/* ============================================================
 * 9. NETWORKING & SYNC
 * ============================================================
 */

function snapshotState(me) {
  if (!me) return;
  LOCAL_STATS.hp = me.hp;
  LOCAL_STATS.stamina = me.stamina;
  LOCAL_HOTBAR.index = me.hotbarIndex;

  const rawSlots = (me.inventory?.slots || []).map(String);
  while (rawSlots.length < 36) rawSlots.push("");
  LOCAL_INV.slots = rawSlots;

  const items = {};
  if (me.items) me.items.forEach((it, uid) => (items[uid] = { kind: it.kind, qty: it.qty }));
  LOCAL_INV.items = items;
  LOCAL_INV.equip = JSON.parse(JSON.stringify(me.equip || {}));

  for (let i = 0; i < 9; i++) {
    const idx = LOCAL_CRAFT.indices[i];
    if (idx !== -1 && !LOCAL_INV.slots[idx]) LOCAL_CRAFT.indices[i] = -1;
  }

  if (inventoryUI.isOpen()) inventoryUI.refresh();
  hotbarUI.refresh();
}

function zeroPlayerVelocity() {
  try {
    const body = noa.entities.getPhysicsBody(noa.playerEntity);
    if (!body) return;
    body.velocity[0] = 0;
    body.velocity[1] = 0;
    body.velocity[2] = 0;
    if (body.angularVelocity) {
      body.angularVelocity[0] = 0;
      body.angularVelocity[1] = 0;
      body.angularVelocity[2] = 0;
    }
  } catch {}
}

function forcePlayerPosition(x, y, z, reason = "") {
  try {
    noa.entities.setPosition(noa.playerEntity, x, y, z);
    zeroPlayerVelocity();
    if (reason) UI_CONSOLE.log(`snap -> (${x.toFixed(2)},${y.toFixed(2)},${z.toFixed(2)}) ${reason}`);
  } catch {}
}

function tryLogTownCenterBlocks() {
  try {
    const g = noa.getBlock(TOWN.cx, TOWN.groundY, TOWN.cz);
    const m = noa.getBlock(TOWN.cx, TOWN.groundY + 1, TOWN.cz);
    UI_CONSOLE.log(`Town center blocks: ground@Y=${TOWN.groundY} id=${g}, marker@Y+1 id=${m}`);
  } catch {}
}

const ENDPOINT = window.location.hostname.includes("localhost")
  ? "ws://localhost:2567"
  : "https://us-mia-ea26ba04.colyseus.cloud";

const client = new Colyseus.Client(ENDPOINT);

function getDistinctId() {
  const key = "fresh2_player_id";
  let id = localStorage.getItem(key);
  if (!id) {
    id = "user_" + Math.random().toString(36).substr(2, 9);
    localStorage.setItem(key, id);
  }
  return id;
}

client
  .joinOrCreate("my_room", {
    name: "Steve",
    distinctId: getDistinctId(),
  })
  .then((room) => {
    colyRoom = room;
    uiLog("Connected to Server!");

    room.onMessage("welcome", (msg) => {
      uiLog(`Welcome: ${msg?.roomId || ""} (${msg?.sessionId || ""})`);
      chatUI.add("Welcome! Press [ENTER] to chat or use commands.", "#88ff88");
      chatUI.add("Try: /find desert | /goto mountains | /biome", "#88ff88");

      try {
        room.send("world:patch:req", { x: TOWN.cx, y: TOWN.groundY, z: TOWN.cz, r: 160, limit: 30000 });
      } catch {}

      try {
        const p = noa.entities.getPosition(noa.playerEntity);
        room.send("world:patch:req", { x: p[0] | 0, y: p[1] | 0, z: p[2] | 0, r: 128, limit: 20000 });
      } catch {}
    });

    room.onMessage("block:reject", (msg) => {
      const reason = msg?.reason || "reject";
      UI_CONSOLE.warn(`block:reject (${reason})`);
    });

    // Handle Chat Feedback
    room.onMessage("chat:sys", (msg) => {
      if (msg?.text) chatUI.add(msg.text, "#88ffff");
    });

    // Server-side Teleport
    room.onMessage("spawn:teleport", (msg) => {
      const x = Number(msg?.x);
      const y = Number(msg?.y);
      const z = Number(msg?.z);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;

      STATE.desiredSpawn = { x, y, z };

      if (!STATE.worldReady) {
        STATE.pendingTeleport = { x, y, z };
        UI_CONSOLE.log(`spawn:teleport received early -> pending (${x},${y},${z})`);
      } else {
        forcePlayerPosition(x, y, z, "(spawn:teleport)");
        STATE.spawnSnapDone = true;
      }

      const loadingScreen = document.getElementById("loading-screen");
      if (loadingScreen) loadingScreen.style.display = "none";
    });

    room.onStateChange((state) => {
      const me = state.players.get(room.sessionId);
      if (me) snapshotState(me);

      state.players.forEach((p, sid) => {
        if (sid === room.sessionId) return;
        if (!remotePlayers[sid]) {
          const rig = createAvatar(noa.rendering.getScene());
          remotePlayers[sid] = { mesh: rig.root, targetPos: [p.x, p.y, p.z] };
          uiLog(`Player ${sid} joined`);
        }
        remotePlayers[sid].targetPos = [p.x, p.y, p.z];
        if (remotePlayers[sid].mesh) remotePlayers[sid].mesh.rotation.y = p.yaw;
      });
    });

    room.onMessage("world:patch", (patch) => {
      const edits = patch?.edits || [];
      for (let i = 0; i < edits.length; i++) {
        const e = edits[i];
        noa.setBlock(e.id, e.x, e.y, e.z);
      }

      if (!STATE.worldReady) {
        STATE.worldReady = true;
        UI_CONSOLE.log(`worldReady=true (patch edits=${edits.length})`);

        if (STATE.pendingTeleport) {
          const t = STATE.pendingTeleport;
          STATE.pendingTeleport = null;
          forcePlayerPosition(t.x, t.y, t.z, "(pending teleport)");
          STATE.spawnSnapDone = true;
          
          const loadingScreen = document.getElementById("loading-screen");
          if (loadingScreen) loadingScreen.style.display = "none";

        } else {
          const s = STATE.desiredSpawn || { x: 0, y: TOWN.groundY + 2, z: 0 };
          forcePlayerPosition(s.x, s.y, s.z, "(first patch snap)");
          STATE.spawnSnapDone = true;
        }

        setTimeout(() => tryLogTownCenterBlocks(), 250);
        setTimeout(() => tryLogTownCenterBlocks(), 1200);
      }
    });

    room.onMessage("block:update", (msg) => {
      noa.setBlock(msg.id, msg.x, msg.y, msg.z);
    });

    room.onMessage("craft:success", (msg) => {
      uiLog(`Crafted: ${msg.item}`);
      LOCAL_CRAFT.indices.fill(-1);
      LOCAL_CRAFT.result = null;
      inventoryUI.refresh();
    });

    room.onMessage("craft:reject", (msg) => {
      UI_CONSOLE.warn(`craft:reject (${msg?.reason || "unknown"})`);
    });
  })
  .catch((e) => uiLog(`Connect Error: ${e}`, "red"));

/* ============================================================
 * 10. INPUTS & GAME LOOP
 * ============================================================
 */

function setView(mode) {
  viewMode = mode;
  noa.camera.zoomDistance = mode === 1 ? 6 : 0;
  if (MESH.weaponRoot) MESH.weaponRoot.setEnabled(mode === 0);
  if (MESH.avatarRoot) MESH.avatarRoot.setEnabled(mode === 1);
}

// Mouse
noa.inputs.down.on("fire", () => {
  if (inventoryOpen || chatOpen) return; // Block input if chat is open
  STATE.swingT = 0;
  if (colyRoom) colyRoom.send("swing");

  if (noa.targetedBlock) {
    const p = noa.targetedBlock.position;
    if (colyRoom) colyRoom.send("block:break", { x: p[0], y: p[1], z: p[2], src: "client_fire" });
    noa.setBlock(0, p[0], p[1], p[2]);
  }
});

noa.inputs.down.on("alt-fire", () => {
  if (inventoryOpen || chatOpen || !noa.targetedBlock) return;
  const p = noa.targetedBlock.adjacent;
  const idx = LOCAL_HOTBAR.index;
  const uid = LOCAL_INV.slots[idx];
  const it = uid ? LOCAL_INV.items[uid] : null;

  if (it && it.kind.startsWith("block:")) {
    const kind = it.kind;
    const map = {
      "block:dirt": ID.dirt,
      "block:grass": ID.grass,
      "block:stone": ID.stone,
      "block:bedrock": ID.bedrock,
      "block:log": ID.log,
      "block:leaves": ID.leaves,
      "block:plank": ID.planks,
      "block:sand": ID.sand,
      "block:snow": ID.snow,
      "block:clay": ID.clay,
      "block:gravel": ID.gravel,
      "block:mud": ID.mud,
      "block:ice": ID.ice,
      "block:coal_ore": ID.coal_ore,
      "block:copper_ore": ID.copper_ore,
      "block:iron_ore": ID.iron_ore,
      "block:silver_ore": ID.silver_ore,
      "block:gold_ore": ID.gold_ore,
      "block:ruby_ore": ID.ruby_ore,
      "block:sapphire_ore": ID.sapphire_ore,
      "block:mythril_ore": ID.mythril_ore,
      "block:dragonstone": ID.dragonstone,
      "block:crafting_table": ID.crafting_table,
      "block:chest": ID.chest,
      "block:slab_plank": ID.slab_plank,
      "block:stairs_plank": ID.stairs_plank,
      "block:door_wood": ID.door_wood,
    };

    let id = map[kind] || 0;
    if (id === 0) {
        if (kind.includes("dirt")) id = ID.dirt;
        else if (kind.includes("log")) id = ID.log;
        else id = ID.dirt; // fallback
    }

    if (id !== 0) {
      if (colyRoom)
        colyRoom.send("block:place", { x: p[0], y: p[1], z: p[2], kind: it.kind, src: "client_alt_fire" });
      noa.setBlock(id, p[0], p[1], p[2]);
    }
  }
});

// Key Listeners
window.addEventListener("keydown", (e) => {
  // Chat Toggle (Enter)
  if (e.code === "Enter") {
    e.preventDefault();
    if (chatOpen) {
      const text = chatUI.input.value.trim();
      if (text && colyRoom) {
        chatUI.add(`> ${text}`, "#ccc");
        colyRoom.send("chat", { text }); // Send to server
      }
      chatUI.toggle();
    } else {
      chatUI.toggle();
    }
    return;
  }

  // If Chat is open, block all other keys (except Enter handled above)
  if (chatOpen) return;

  if (e.code === "KeyI" || e.code === "Tab") {
    e.preventDefault();
    inventoryUI.toggle();
  }
  if (e.code === "F4") {
    e.preventDefault();
    UI_CONSOLE.toggle();
  }
  if (e.code === "KeyV") {
    setView(viewMode === 0 ? 1 : 0);
  }

  if (!inventoryOpen) {
    if (e.key >= "1" && e.key <= "9") {
      const idx = parseInt(e.key) - 1;
      if (colyRoom) colyRoom.send("hotbar:set", { index: idx });
      LOCAL_HOTBAR.index = idx;
      hotbarUI.refresh();
    }
  }

  if (e.code === "F6") {
    try {
      if (colyRoom) colyRoom.send("world:patch:req", { x: TOWN.cx, y: TOWN.groundY, z: TOWN.cz, r: 160, limit: 30000 });
      UI_CONSOLE.log("Requested town patch (F6)");
    } catch {}
  }

  if (e.code === "F8") {
    STATE.logPos = !STATE.logPos;
    UI_CONSOLE.log(`pos logging: ${STATE.logPos ? "ON" : "OFF"} (F8)`);
  }

  if (e.code === "F9") {
    forcePlayerPosition(TOWN.cx + 0.5, TOWN.groundY + 3, TOWN.cz + 0.5, "(F9 manual snap)");
    if (colyRoom) {
      try {
        colyRoom.send("move", { x: TOWN.cx + 0.5, y: TOWN.groundY + 3, z: TOWN.cz + 0.5, yaw: noa.camera.heading, pitch: noa.camera.pitch });
      } catch {}
    }
  }
});

// --- RENDER LOOP ---
noa.on("beforeRender", () => {
  if (!STATE.scene) {
    const scene = noa.rendering.getScene();
    if (scene) {
      STATE.scene = scene;
      initFpsRig(STATE.scene);
      applyRenderPreset(STATE.scene, RENDER_PRESET_OUTSIDE);
    } else {
      return;
    }
  }

  const now = performance.now();
  const dt = (now - STATE.lastTime) / 1000;
  STATE.lastTime = now;

  if (dt > 0.1) return;

  try {
    const tNow = performance.now();
    const shouldFreeze = !STATE.worldReady || !STATE.spawnSnapDone || tNow < STATE.freezeUntil;
    if (shouldFreeze) {
      const s = STATE.desiredSpawn || { x: 0, y: TOWN.groundY + 2, z: 0 };
      forcePlayerPosition(s.x, s.y, s.z, "");
    }
  } catch {}

  updateRigAnim(dt);

  try {
    const p = noa.entities.getPosition(noa.playerEntity);
    const px = p[0], pz = p[2];
    const inside = isInsideTown(px, pz, inTown);
    if (inside !== inTown) {
      const tNow = performance.now();
      if (tNow - lastTownToggleAt > 350) {
        inTown = inside;
        lastTownToggleAt = tNow;
        applyRenderPreset(STATE.scene, inTown ? RENDER_PRESET_TOWN : RENDER_PRESET_OUTSIDE);
        UI_CONSOLE.log(inTown ? "Entered Town render clamp" : "Exited Town render clamp");
      }
    }
  } catch {}

  if (STATE.logPos) {
    const tNow = performance.now();
    if (tNow - STATE.lastPosLogAt > 800) {
      STATE.lastPosLogAt = tNow;
      try {
        const p = noa.entities.getPosition(noa.playerEntity);
        UI_CONSOLE.log(`pos=(${p[0].toFixed(2)}, ${p[1].toFixed(2)}, ${p[2].toFixed(2)}) worldReady=${STATE.worldReady} snap=${STATE.spawnSnapDone}`);
      } catch {}
    }
  }

  for (const sid in remotePlayers) {
    const rp = remotePlayers[sid];
    if (rp && rp.mesh) {
      const cur = rp.mesh.position;
      const tgt = rp.targetPos;
      cur.x += (tgt[0] - cur.x) * 0.1;
      cur.y += (tgt[1] - cur.y) * 0.1;
      cur.z += (tgt[2] - cur.z) * 0.1;
    }
  }

  STATE.moveAccum += dt;
  const stillFreezing = !STATE.worldReady || !STATE.spawnSnapDone || performance.now() < STATE.freezeUntil;

  if (colyRoom && !inventoryOpen && !chatOpen && !stillFreezing && STATE.moveAccum > 0.05) {
    STATE.moveAccum = 0;
    try {
      const p = noa.entities.getPosition(noa.playerEntity);
      const cam = noa.camera;
      colyRoom.send("move", { x: p[0], y: p[1], z: p[2], yaw: cam.heading, pitch: cam.pitch });
    } catch (e) {}
  }
});

noa.entities.setPosition(noa.playerEntity, 0, TOWN.groundY + 2, 0);
zeroPlayerVelocity();
UI_CONSOLE.log(`Initial client spawn set to town top (0,${TOWN.groundY + 2},0)`);