// @ts-nocheck
/*
 * fresh2 - client main/index (FINAL PRODUCTION VERSION)
 * -------------------------------------------------------------------
 * INCLUDES:
 * - 3x3 Crafting Grid (Virtual Mapping Strategy)
 * - Inventory UI (Drag & Drop, Logic, Splitting)
 * - Server-Authoritative Logic (Colyseus)
 * - World Generation (Synced Bedrock/Trees)
 * - 3D Rigs (FPS Hands + 3rd Person Avatars)
 * - Network Interpolation (Smooth movement)
 * - Debug Console (F4)
 * - Dynamic Environment Switching (Localhost vs Prod)
 */

import { Engine } from "noa-engine";
import Colyseus from "colyseus.js";
import * as BABYLON from "babylonjs";

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
  chunkAddDistance: 2.5,
  chunkRemoveDistance: 3.5,
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

// Multiplayer
let colyRoom = null;
const remotePlayers = {}; // { [sid]: { mesh, targetPos, lastPos } }

// Client State
const LOCAL_INV = {
  cols: 9,
  rows: 4,
  slots: [], // uid strings
  items: {}, // uid -> ItemState
  equip: { head: "", chest: "", legs: "", feet: "", tool: "", offhand: "" },
};

// Crafting State (Virtual Mapping)
const LOCAL_CRAFT = {
  indices: new Array(9).fill(-1), // maps craft slot 0..8 -> inventory index 0..35
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
};

/* ============================================================
 * 4. UI: DEBUG CONSOLE (Robust)
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
 * 5. UI: INVENTORY & CRAFTING (The Logic Core)
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

    // Logic:
    // If drop on Craft Slot -> Map index
    // If drop on Inv Slot -> Move item (Server)
    // If drop outside -> Clear craft mapping (if source was craft)

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

    // 1. Drop onto Crafting Grid
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

    // 2. Drop onto Inventory
    if (destId.startsWith("inv:")) {
      // If coming from Craft, just clear craft slot
      if (drag.srcId.startsWith("craft:")) {
        const cIdx = parseInt(drag.srcId.split(":")[1]);
        LOCAL_CRAFT.indices[cIdx] = -1;
        updateCraft();
        refresh();
        return;
      }
      // If coming from Inv, move item
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
 * 7. WORLD GENERATION (Synced with Server)
 * ============================================================
 */

// Materials
const mats = {
  dirt: [0.45, 0.36, 0.22],
  grass: [0.1, 0.8, 0.2],
  stone: [0.5, 0.5, 0.5],
  bedrock: [0.2, 0.2, 0.2],
  log: [0.4, 0.3, 0.1],
  leaves: [0.2, 0.6, 0.2],
  planks: [0.6, 0.45, 0.25],
  glass: [0.8, 0.9, 1.0],
};
Object.keys(mats).forEach((k) => noa.registry.registerMaterial(k, { color: mats[k] }));

const ID = {
  dirt: noa.registry.registerBlock(1, { material: "dirt" }),
  grass: noa.registry.registerBlock(2, { material: "grass" }),
  stone: noa.registry.registerBlock(3, { material: "stone" }),
  bedrock: noa.registry.registerBlock(4, { material: "bedrock" }),
  log: noa.registry.registerBlock(5, { material: "log" }),
  leaves: noa.registry.registerBlock(6, { material: "leaves" }),
  planks: noa.registry.registerBlock(7, { material: "planks" }),
};

function hash2(x, z) {
  let n = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  return n - Math.floor(n);
}

function getVoxelID(x, y, z) {
  if (y < -10) return ID.bedrock;
  const h = Math.floor(4 * Math.sin(x / 15) + 4 * Math.cos(z / 20));

  if (y > h && y < h + 8) {
    // Trees
    if (hash2(x, z) > 0.98) {
      const tb = h + 1;
      if (y >= tb && y < tb + 4) return ID.log;
      if (y > tb + 3 && y <= tb + 5) return ID.leaves;
    }
  }
  if (y < h - 3) return ID.stone;
  if (y < h) return ID.dirt;
  if (y === h) return ID.grass;
  return 0;
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

  const armR = BABYLON.MeshBuilder.CreateBox(
    "armR",
    { width: 0.3, height: 0.8, depth: 0.3 },
    scene
  );
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

  const parts = { root, head, body };
  [head, body].forEach((m) => {
    noa.rendering.addMeshToScene(m, false);
    m.isPickable = false;
  });
  return parts;
}

function updateRigAnim(dt) {
  // Bobbing
  if (viewMode === 0 && MESH.weaponRoot) {
    // Only bob if moving
    const vel = noa.entities.getPhysicsBody(noa.playerEntity).velocity;
    const moving = Math.abs(vel[0]) > 0.1 || Math.abs(vel[2]) > 0.1;

    if (moving) STATE.bobPhase += dt * 10;
    MESH.weaponRoot.position.y = Math.sin(STATE.bobPhase) * 0.02;
    MESH.weaponRoot.position.x = Math.cos(STATE.bobPhase) * 0.02;
  }

  // Swinging
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
 * 9. NETWORKING & SYNC
 * ============================================================
 */

function snapshotState(me) {
  if (!me) return;
  LOCAL_STATS.hp = me.hp;
  LOCAL_STATS.stamina = me.stamina;
  LOCAL_HOTBAR.index = me.hotbarIndex;

  // FIXED: Pad inventory to 36 slots
  const rawSlots = (me.inventory?.slots || []).map(String);
  while (rawSlots.length < 36) rawSlots.push("");
  LOCAL_INV.slots = rawSlots;

  const items = {};
  if (me.items) me.items.forEach((it, uid) => (items[uid] = { kind: it.kind, qty: it.qty }));
  LOCAL_INV.items = items;
  LOCAL_INV.equip = JSON.parse(JSON.stringify(me.equip || {}));

  // Clean craft indices if item gone
  for (let i = 0; i < 9; i++) {
    const idx = LOCAL_CRAFT.indices[i];
    if (idx !== -1 && !LOCAL_INV.slots[idx]) LOCAL_CRAFT.indices[i] = -1;
  }

  if (inventoryUI.isOpen()) inventoryUI.refresh();
  hotbarUI.refresh();
}

// DYNAMIC ENDPOINT SWITCH (Vercel Frontend -> Colyseus Cloud Backend)
const ENDPOINT = window.location.hostname.includes("localhost")
  ? "ws://localhost:2567"
  : "https://us-mia-ea26ba04.colyseus.cloud";

const client = new Colyseus.Client(ENDPOINT);

client
  .joinOrCreate("my_room", { name: "Steve" })
  .then((room) => {
    colyRoom = room;
    uiLog("Connected to Server!");

    room.onStateChange((state) => {
      // 1. Sync Self
      const me = state.players.get(room.sessionId);
      if (me) snapshotState(me);

      // 2. Sync Remotes
      state.players.forEach((p, sid) => {
        if (sid === room.sessionId) return;
        if (!remotePlayers[sid]) {
          // Spawn
          const rig = createAvatar(noa.rendering.getScene());
          remotePlayers[sid] = { mesh: rig.root, targetPos: [p.x, p.y, p.z] };
          uiLog(`Player ${sid} joined`);
        }
        // Update Target
        remotePlayers[sid].targetPos = [p.x, p.y, p.z];
        if (remotePlayers[sid].mesh) remotePlayers[sid].mesh.rotation.y = p.yaw;
      });
    });

    room.onMessage("world:patch", (patch) => {
      (patch.edits || []).forEach((e) => noa.setBlock(e.id, e.x, e.y, e.z));
    });

    room.onMessage("block:update", (msg) => {
      noa.setBlock(msg.id, msg.x, msg.y, msg.z);
    });

    room.onMessage("craft:success", (msg) => {
      uiLog(`Crafted: ${msg.item}`);
      LOCAL_CRAFT.indices.fill(-1); // Clear grid on success
      LOCAL_CRAFT.result = null;
      inventoryUI.refresh();
    });
  })
  .catch((e) => uiLog(`Connect Error: ${e}`, "red"));

/* ============================================================
 * 10. INPUTS & GAME LOOP
 * ============================================================
 */

// View Mode
function setView(mode) {
  viewMode = mode;
  noa.camera.zoomDistance = mode === 1 ? 6 : 0;
  if (MESH.weaponRoot) MESH.weaponRoot.setEnabled(mode === 0);
  if (MESH.avatarRoot) MESH.avatarRoot.setEnabled(mode === 1);
}

// Mouse
noa.inputs.down.on("fire", () => {
  if (inventoryOpen) return;
  STATE.swingT = 0;
  if (colyRoom) colyRoom.send("swing");

  if (noa.targetedBlock) {
    const p = noa.targetedBlock.position;
    if (colyRoom) colyRoom.send("block:break", { x: p[0], y: p[1], z: p[2] });
    noa.setBlock(0, p[0], p[1], p[2]); // Predict
  }
});

noa.inputs.down.on("alt-fire", () => {
  if (inventoryOpen || !noa.targetedBlock) return;
  const p = noa.targetedBlock.adjacent;
  const idx = LOCAL_HOTBAR.index;
  const uid = LOCAL_INV.slots[idx];
  const it = uid ? LOCAL_INV.items[uid] : null;

  if (it && it.kind.startsWith("block:")) {
    let id = 0;
    if (it.kind.includes("dirt")) id = ID.dirt;
    if (it.kind.includes("log")) id = ID.log;
    if (it.kind.includes("plank")) id = ID.planks;
    if (it.kind.includes("stone")) id = ID.stone;

    if (id !== 0) {
      if (colyRoom) colyRoom.send("block:place", { x: p[0], y: p[1], z: p[2], kind: it.kind });
      noa.setBlock(id, p[0], p[1], p[2]); // Predict
    }
  }
});

// Keys
window.addEventListener("keydown", (e) => {
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
});

// --- RENDER LOOP (FIXED DT CALCULATION) ---
noa.on("beforeRender", () => {
  // 1. Ensure Scene Initialized
  if (!STATE.scene) {
    const scene = noa.rendering.getScene();
    if (scene) {
      STATE.scene = scene;
      initFpsRig(STATE.scene);
    } else {
      return;
    }
  }

  // 2. Robust Delta Time Calculation
  const now = performance.now();
  const dt = (now - STATE.lastTime) / 1000; // seconds
  STATE.lastTime = now;

  if (dt > 0.1) return; // Skip giant lag spikes

  // 3. Update Animations
  updateRigAnim(dt);

  // 4. Network Interpolation
  for (const sid in remotePlayers) {
    const rp = remotePlayers[sid];
    if (rp && rp.mesh) {
      const cur = rp.mesh.position;
      const tgt = rp.targetPos;
      // Simple lerp
      cur.x += (tgt[0] - cur.x) * 0.1;
      cur.y += (tgt[1] - cur.y) * 0.1;
      cur.z += (tgt[2] - cur.z) * 0.1;
    }
  }

  // 5. Send Move (Throttle)
  STATE.moveAccum += dt;
  if (colyRoom && !inventoryOpen && STATE.moveAccum > 0.05) {
    // 20hz
    STATE.moveAccum = 0;
    try {
      const p = noa.entities.getPosition(noa.playerEntity);
      const cam = noa.camera;
      colyRoom.send("move", { x: p[0], y: p[1], z: p[2], yaw: cam.heading, pitch: cam.pitch });
    } catch (e) {}
  }
});

// Initial spawn
noa.entities.setPosition(noa.playerEntity, 0, 10, 0);
