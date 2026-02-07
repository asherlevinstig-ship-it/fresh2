// @ts-nocheck
/*
 * fresh2 - client main/index (FINAL PRODUCTION VERSION - MINECRAFT CURSOR)
 * -------------------------------------------------------------------
 * INCLUDES:
 * - 3x3 Crafting Grid (REAL CONTAINER - server authoritative)
 * - Minecraft-style Cursor (server authoritative)
 *   - Left click: pickup/place/merge/swap
 *   - Right click: pickup half / place 1
 *   - Double click: collect matching stacks into cursor
 * - Inventory UI (Click interactions + Equipment + Crafting)
 * - Server-Authoritative Logic (Colyseus) with Persistent ID
 * - World Generation (Synced Bedrock/Trees)
 * - 3D Rigs (FPS Hands + 3rd Person Avatars)
 * - Network Interpolation (Smooth movement)
 * - Debug Console (F4)
 * - Dynamic Environment Switching (Localhost vs Prod)
 */

import { Engine } from "noa-engine";
import * as BABYLON from "babylonjs";
import * as Colyseus from "colyseus.js";

/* ============================================================
 * 1. RECIPE DATA (optional local reference)
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
const remotePlayers = {}; // { [sid]: { mesh, targetPos } }

// Client State (mirrors server snapshot)
const LOCAL_INV = {
  cols: 9,
  rows: 4,
  slots: [], // uid strings (length 36)
  items: {}, // uid -> { kind, qty, durability, maxDurability, meta }
  equip: { head: "", chest: "", legs: "", feet: "", tool: "", offhand: "" },
};

// Crafting State (Option B: real craft container)
const LOCAL_CRAFT = {
  slots: new Array(9).fill(""), // uid strings (length 9)
  resultKind: "",
  resultQty: 0,
  recipeId: "",
};

// Minecraft cursor (server authoritative)
const LOCAL_CURSOR = {
  kind: "",
  qty: 0,
  meta: "",
};

const LOCAL_HOTBAR = { index: 0 };
const LOCAL_STATS = { hp: 20, maxHp: 20, stamina: 100, maxStamina: 100 };

const MESH = {
  weaponRoot: null,
  armR: null,
  tool: null, // FPS
  avatarRoot: null, // TPS (Local - optional)
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
 * 5. UI: CURSOR GHOST (Minecraft held stack)
 * ============================================================
 */

const CURSOR_GHOST = (() => {
  const el = document.createElement("div");
  el.id = "cursor-ghost";
  Object.assign(el.style, {
    position: "fixed",
    left: "0px",
    top: "0px",
    transform: "translate(12px, 12px)",
    zIndex: "10020",
    pointerEvents: "none",
    display: "none",
    fontFamily: "system-ui, sans-serif",
    fontSize: "12px",
    color: "#fff",
    textShadow: "1px 1px 0 #000",
  });

  const box = document.createElement("div");
  Object.assign(box.style, {
    background: "rgba(20,20,24,0.95)",
    border: "1px solid rgba(255,255,255,0.6)",
    borderRadius: "6px",
    padding: "6px 8px",
    minWidth: "40px",
    textAlign: "center",
    lineHeight: "1.05",
  });

  const label = document.createElement("div");
  label.textContent = "";

  const qty = document.createElement("div");
  Object.assign(qty.style, { fontWeight: "bold", marginTop: "2px", fontSize: "11px" });
  qty.textContent = "";

  box.appendChild(label);
  box.appendChild(qty);
  el.appendChild(box);
  document.body.appendChild(el);

  function shortKind(kind) {
    return kind ? (kind.split(":")[1] || kind) : "";
  }

  function setVisible(v) {
    el.style.display = v ? "block" : "none";
  }

  function update() {
    const has = !!LOCAL_CURSOR.kind && (LOCAL_CURSOR.qty || 0) > 0;
    if (!inventoryOpen) {
      setVisible(false);
      return;
    }
    if (!has) {
      setVisible(false);
      return;
    }

    label.textContent = shortKind(LOCAL_CURSOR.kind);
    qty.textContent = (LOCAL_CURSOR.qty || 0) > 1 ? String(LOCAL_CURSOR.qty) : "";
    setVisible(true);
  }

  function move(e) {
    el.style.left = e.clientX + "px";
    el.style.top = e.clientY + "px";
  }

  window.addEventListener("mousemove", (e) => {
    if (inventoryOpen) move(e);
  });

  return { update, setVisible };
})();

/* ============================================================
 * 6. UI: INVENTORY & CRAFTING (Minecraft click semantics)
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
    width: "min(860px, 96vw)",
    background: "rgba(30,30,35,0.95)",
    borderRadius: "12px",
    border: "1px solid #444",
    boxShadow: "0 10px 40px rgba(0,0,0,0.5)",
    padding: "20px",
    display: "grid",
    gridTemplateColumns: "260px 1fr",
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

  // 3x3 Grid (REAL craft slots)
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

  // Result slot (preview; click crafts into cursor)
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
  leftCol.appendChild(document.createElement("div")).textContent = "Equipment";
  const eqGrid = document.createElement("div");
  Object.assign(eqGrid.style, {
    display: "grid",
    gridTemplateColumns: "repeat(3, 48px)",
    gap: "4px",
    marginTop: "6px",
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

  // Cursor hint (optional info)
  const cursorHint = document.createElement("div");
  Object.assign(cursorHint.style, {
    marginTop: "10px",
    fontSize: "12px",
    opacity: "0.9",
    lineHeight: "1.35",
  });
  cursorHint.innerHTML = `
    <div style="opacity:0.85">
      <b>Mouse</b>: Left = pickup/place/merge/swap<br/>
      <b>Right</b>: pickup half / place 1<br/>
      <b>Double</b>: collect same items
    </div>
  `;
  leftCol.appendChild(cursorHint);

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
      lineHeight: "1.1",
      padding: "2px",
      wordBreak: "break-word",
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

    // prevent browser menu on right click
    cell.addEventListener("contextmenu", (e) => e.preventDefault());

    return { cell, icon, qty };
  }

  function getItemShort(kind) {
    return kind ? kind.split(":")[1] || kind : "";
  }

  function uidToItem(uid) {
    if (!uid) return null;
    return LOCAL_INV.items[uid] || null;
  }

  // --- Render Loop ---
  function refresh() {
    // Inventory
    for (let i = 0; i < 36; i++) {
      const uid = LOCAL_INV.slots[i] || "";
      const it = uid ? uidToItem(uid) : null;
      invCells[i].icon.textContent = it ? getItemShort(it.kind) : "";
      invCells[i].qty.textContent = it && it.qty > 1 ? String(it.qty) : "";
      invCells[i].cell.style.opacity = "1";
    }

    // Crafting
    for (let i = 0; i < 9; i++) {
      const uid = LOCAL_CRAFT.slots[i] || "";
      const it = uid ? uidToItem(uid) : null;
      craftCells[i].icon.textContent = it ? getItemShort(it.kind) : "";
      craftCells[i].qty.textContent = it && it.qty > 1 ? String(it.qty) : "";
    }

    // Result preview
    const rk = LOCAL_CRAFT.resultKind || "";
    const rq = LOCAL_CRAFT.resultQty || 0;
    resIcon.textContent = rk ? getItemShort(rk) : "";
    resQty.textContent = rk ? (rq > 1 ? String(rq) : "1") : "";

    // Equip
    eqKeys.forEach((k) => {
      const uid = LOCAL_INV.equip[k];
      const it = uid ? uidToItem(uid) : null;
      eqCells[k].icon.textContent = it ? getItemShort(it.kind) : "";
      eqCells[k].qty.textContent = "";
    });

    // Cursor ghost
    CURSOR_GHOST.update();
  }

  // --- Slot Interaction ---
  function sendLeft(slotId) {
    if (!colyRoom) return;
    colyRoom.send("slot:click", { slot: slotId });
  }

  function sendRight(slotId) {
    if (!colyRoom) return;
    colyRoom.send("slot:rclick", { slot: slotId });
  }

  function sendDouble() {
    if (!colyRoom) return;
    colyRoom.send("slot:dblclick", {});
  }

  // Double-click detection (simple)
  let lastClickAt = 0;
  let lastClickSlot = "";

  function onSlotMouseDown(e, slotId) {
    // Craft result crafts into cursor
    if (slotId === "craft:result") {
      if (colyRoom) colyRoom.send("craft:take", {});
      return;
    }

    // Detect dblclick (left button only)
    const now = performance.now();
    if (e.button === 0) {
      const dt = now - lastClickAt;
      const same = lastClickSlot === slotId;
      lastClickAt = now;
      lastClickSlot = slotId;

      if (dt < 260 && same) {
        sendDouble();
        return;
      }

      sendLeft(slotId);
      return;
    }

    // Right click
    if (e.button === 2) {
      sendRight(slotId);
      return;
    }
  }

  // Bind Events to all cells
  const allCells = [
    ...invCells.map((o) => o.cell),
    ...craftCells.map((o) => o.cell),
    ...Object.values(eqCells).map((o) => o.cell),
    resCell,
  ];

  allCells.forEach((cell) => {
    cell.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const id = cell.dataset.id;
      onSlotMouseDown(e, id);
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
      CURSOR_GHOST.update();
    },
    refresh,
    isOpen: () => overlay.style.display !== "none",
  };
}

const inventoryUI = createInventoryOverlay();

/* ============================================================
 * 7. UI: HOTBAR (DOM Overlay)
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
    zIndex: "9997",
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
      lineHeight: "1.1",
      padding: "4px",
      wordBreak: "break-word",
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
        slots[i].icon.textContent = it ? (it.kind.split(":")[1] || it.kind) : "";
        slots[i].qty.textContent = it && it.qty > 1 ? String(it.qty) : "";
      }
    },
  };
}

const hotbarUI = createHotbarUI();

/* ============================================================
 * 8. WORLD GENERATION (Synced with Server)
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
 * 9. VISUALS: RIGS & ANIMATION
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
  // Bobbing
  if (viewMode === 0 && MESH.weaponRoot) {
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
 * 10. NETWORKING & SYNC
 * ============================================================
 */

function snapshotState(me) {
  if (!me) return;

  LOCAL_STATS.hp = me.hp;
  LOCAL_STATS.stamina = me.stamina;
  LOCAL_HOTBAR.index = me.hotbarIndex;

  // Inventory: pad to 36
  const rawSlots = (me.inventory?.slots || []).map(String);
  while (rawSlots.length < 36) rawSlots.push("");
  if (rawSlots.length > 36) rawSlots.length = 36;
  LOCAL_INV.slots = rawSlots;

  // Items map
  const items = {};
  if (me.items) {
    me.items.forEach((it, uid) => {
      items[uid] = {
        kind: it.kind,
        qty: it.qty,
        durability: it.durability,
        maxDurability: it.maxDurability,
        meta: it.meta,
      };
    });
  }
  LOCAL_INV.items = items;

  // Equip
  LOCAL_INV.equip = JSON.parse(JSON.stringify(me.equip || {}));

  // Craft container: pad to 9
  const craftSlots = (me.craft?.slots || []).map(String);
  while (craftSlots.length < 9) craftSlots.push("");
  if (craftSlots.length > 9) craftSlots.length = 9;
  LOCAL_CRAFT.slots = craftSlots;

  LOCAL_CRAFT.resultKind = String(me.craft?.resultKind || "");
  LOCAL_CRAFT.resultQty = Number(me.craft?.resultQty || 0) || 0;
  LOCAL_CRAFT.recipeId = String(me.craft?.recipeId || "");

  // Cursor (minecraft)
  LOCAL_CURSOR.kind = String(me.cursor?.kind || "");
  LOCAL_CURSOR.qty = Number(me.cursor?.qty || 0) || 0;
  LOCAL_CURSOR.meta = String(me.cursor?.meta || "");

  if (inventoryUI.isOpen()) inventoryUI.refresh();
  hotbarUI.refresh();
  CURSOR_GHOST.update();
}

// DYNAMIC ENDPOINT SWITCH
const ENDPOINT = window.location.hostname.includes("localhost")
  ? "ws://localhost:2567"
  : "wss://us-mia-ea26ba04.colyseus.cloud";

const client = new Colyseus.Client(ENDPOINT);

// Persistent ID
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

    room.onStateChange((state) => {
      // 1) Sync Self
      const me = state.players.get(room.sessionId);
      if (me) snapshotState(me);

      // 2) Sync Remotes
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

      // 3) Cleanup
      for (const sid in remotePlayers) {
        if (!state.players.has(sid)) {
          const rp = remotePlayers[sid];
          try {
            if (rp.mesh && rp.mesh.dispose) rp.mesh.dispose();
          } catch (e) {}
          delete remotePlayers[sid];
          uiLog(`Player ${sid} left`);
        }
      }
    });

    room.onMessage("world:patch", (patch) => {
      (patch.edits || []).forEach((e) => noa.setBlock(e.id, e.x, e.y, e.z));
    });

    room.onMessage("block:update", (msg) => {
      noa.setBlock(msg.id, msg.x, msg.y, msg.z);
    });

    room.onMessage("block:reject", (msg) => {
      UI_CONSOLE.warn(`Block rejected: ${msg.reason || "unknown"}`);
      // reconcile
      try {
        const p = noa.entities.getPosition(noa.playerEntity);
        room.send("world:patch:req", {
          x: Math.floor(p[0]),
          y: Math.floor(p[1]),
          z: Math.floor(p[2]),
          r: 24,
          limit: 8000,
        });
      } catch (e) {}
    });

    room.onMessage("craft:success", (msg) => {
      uiLog(`Crafted: ${msg.item}${msg.qty ? " x" + msg.qty : ""}`);
      if (inventoryUI.isOpen()) inventoryUI.refresh();
      hotbarUI.refresh();
      CURSOR_GHOST.update();
    });

    room.onMessage("craft:reject", (msg) => {
      UI_CONSOLE.warn(`Craft rejected: ${msg.reason || "unknown"}`);
    });
  })
  .catch((e) => uiLog(`Connect Error: ${e}`, "red"));

/* ============================================================
 * 11. INPUTS & GAME LOOP
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

  if (it && it.kind && it.kind.startsWith("block:")) {
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

// Render loop
noa.on("beforeRender", () => {
  // Ensure scene initialized
  if (!STATE.scene) {
    const scene = noa.rendering.getScene();
    if (scene) {
      STATE.scene = scene;
      initFpsRig(STATE.scene);
    } else {
      return;
    }
  }

  // dt
  const now = performance.now();
  const dt = (now - STATE.lastTime) / 1000;
  STATE.lastTime = now;
  if (dt > 0.1) return;

  // anims
  updateRigAnim(dt);

  // interpolate remotes
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

  // send move (throttle)
  STATE.moveAccum += dt;
  if (colyRoom && !inventoryOpen && STATE.moveAccum > 0.05) {
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
