// @ts-nocheck
/*
 * fresh2 - client main/index (NOA main entry) - FULL REWRITE (NO OMITS)
 * -------------------------------------------------------------------
 * Includes:
 * - NOA world generation
 * - First/Third person view mode enforcement EVERY FRAME (prevents mid-air flip)
 * - FPS rig + 3rd-person avatar rigs (local + remote)
 * - Crosshair overlay
 * - Hotbar overlay (inv:0..8), server-authoritative hotbarIndex
 * - Inventory overlay (toggle with I), drag/drop slot-to-slot, split stacks
 * - Colyseus (@colyseus/sdk) state sync + remote interpolation
 * - Sends: move, sprint, swing, hotbar:set, inv:move, inv:split
 *
 * Assumptions:
 * - Server room is "my_room"
 * - Schema matches your MyRoomState / PlayerState / ItemState
 */

import { Engine } from "noa-engine";
import { Client as ColyClient } from "@colyseus/sdk";
import * as BABYLON from "babylonjs";

// ---- If you have shared schema types in the client, import them (optional). ----
// import type { MyRoomState, PlayerState, ItemState } from "../server/src/schema/MyRoomState"; // example

/* ============================================================
 * NOA BOOTSTRAP
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
const noaAny = /** @type {any} */ (noa);

console.log("noa-engine booted:", noa.version);

/* ============================================================
 * GLOBAL STATE
 * ============================================================
 */

let viewMode = 0; // 0 = first, 1 = third
let forceCrosshair = true;
let showDebugProof = false;
let inventoryOpen = false;

// Multiplayer
let colyRoom = null;
/**
 * remotePlayers[sessionId] = { mesh, parts, targetPos, targetRot, lastPos }
 */
const remotePlayers = {};
let lastPlayersKeys = new Set();

const STATE = {
  scene: null,

  // NOA follow state (if available)
  camFollowState: null,
  baseFollowOffset: [0, 0, 0],

  // time
  lastTime: performance.now(),

  // animation
  lastHeading: 0,
  lastPitch: 0,
  bobPhase: 0,
  lastPlayerPos: null,

  swingT: 999,
  swingDuration: 0.22,

  // safe pos cache
  lastValidPlayerPos: [0, 2, 0],

  // debug throttle
  avDbgLastLog: 0,
  avDbgIntervalMs: 250,
};

const MESH = {
  // Debug
  proofA: null,
  frontCube: null,

  // FPS Rig
  weaponRoot: null,
  armsRoot: null,
  armL: null,
  armR: null,
  tool: null,

  // Third-person avatar (local)
  avatarRoot: null,
  avParts: {},

  // inventory drag ghost
  dragGhost: null,
};

/* ============================================================
 * CLIENT REPLICATED SNAPSHOT
 * ============================================================
 * We keep local copies of our own player state (from Colyseus)
 * so UI can render consistently.
 */

const LOCAL_INV = {
  cols: 9,
  rows: 4,
  slots: [], // string[] (uids)
  items: {}, // uid -> {uid, kind, qty, durability, maxDurability, meta}
  equip: { head: "", chest: "", legs: "", feet: "", tool: "", offhand: "" },
};

const LOCAL_HOTBAR = {
  index: 0,
};

const LOCAL_STATS = {
  hp: 20,
  maxHp: 20,
  stamina: 100,
  maxStamina: 100,
  sprinting: false,
  swinging: false,
};

/* ============================================================
 * HELPERS
 * ============================================================
 */

function safeNum(v, fallback = 0) {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function resolveScene() {
  const r = noaAny.rendering;
  if (r?.getScene) return r.getScene();
  if (r?.scene) return r.scene;
  return null;
}

function noaAddMesh(mesh, isStatic = false, pos = null) {
  try {
    noa.rendering.addMeshToScene(mesh, !!isStatic, pos || null);
    mesh.alwaysSelectAsActiveMesh = true;
  } catch (e) {
    console.warn("[NOA_RENDER] addMeshToScene failed:", e);
  }
}

function createSolidMat(scene, name, color3) {
  const existing = scene.getMaterialByName(name);
  if (existing) return existing;

  const mat = new BABYLON.StandardMaterial(name, scene);
  mat.diffuseColor = color3;
  mat.emissiveColor = color3.scale(0.35);
  mat.specularColor = new BABYLON.Color3(0, 0, 0);
  mat.backFaceCulling = false;
  return mat;
}

function setEnabled(meshOrNode, on) {
  if (!meshOrNode) return;
  if (meshOrNode.setEnabled) meshOrNode.setEnabled(!!on);
}

function isFinite3(p) {
  return (
    p &&
    p.length >= 3 &&
    Number.isFinite(p[0]) &&
    Number.isFinite(p[1]) &&
    Number.isFinite(p[2])
  );
}

function getSafePlayerPos() {
  let p = null;
  try {
    p = noa.entities.getPosition(noa.playerEntity);
  } catch (e) {}

  if (isFinite3(p)) {
    const x = p[0];
    const y = clamp(p[1], -100000, 100000);
    const z = p[2];
    STATE.lastValidPlayerPos = [x, y, z];
    return STATE.lastValidPlayerPos;
  }

  return STATE.lastValidPlayerPos;
}

function forceRigBounds(parts) {
  if (!parts) return;

  if (parts.root?.computeWorldMatrix) {
    parts.root.computeWorldMatrix(true);
  }

  const meshes = [
    parts.head,
    parts.body,
    parts.armL,
    parts.armR,
    parts.legL,
    parts.legR,
    parts.tool,
  ].filter(Boolean);

  for (const m of meshes) {
    try {
      m.computeWorldMatrix(true);
      m.refreshBoundingInfo(true);
      if (m._updateSubMeshesBoundingInfo) m._updateSubMeshesBoundingInfo();
    } catch (e) {}
  }
}

/* ============================================================
 * UI: CROSSHAIR OVERLAY (DECLARE ONCE!)
 * ============================================================
 */

function createCrosshairOverlay() {
  const div = document.createElement("div");
  div.id = "noa-crosshair";
  Object.assign(div.style, {
    position: "fixed",
    top: "50%",
    left: "50%",
    width: "22px",
    height: "22px",
    transform: "translate(-50%, -50%)",
    pointerEvents: "none",
    zIndex: "9999",
    display: "none",
  });

  const lineStyle = {
    position: "absolute",
    backgroundColor: "rgba(255,255,255,0.9)",
    boxShadow: "0 0 2px black",
  };

  const h = document.createElement("div");
  Object.assign(h.style, lineStyle, { width: "100%", height: "2px", top: "10px", left: "0" });

  const v = document.createElement("div");
  Object.assign(v.style, lineStyle, { width: "2px", height: "100%", left: "10px", top: "0" });

  div.appendChild(h);
  div.appendChild(v);
  document.body.appendChild(div);

  function refresh() {
    const locked = document.pointerLockElement === noa.container.canvas;
    const show = forceCrosshair || viewMode === 0 || locked;
    div.style.display = show ? "block" : "none";
  }

  document.addEventListener("pointerlockchange", refresh);
  setInterval(refresh, 500);

  return { refresh };
}

const crosshairUI = createCrosshairOverlay();

/* ============================================================
 * UI: HOTBAR OVERLAY
 * ============================================================
 */

function createHotbarOverlay() {
  const wrap = document.createElement("div");
  wrap.id = "noa-hotbar";
  Object.assign(wrap.style, {
    position: "fixed",
    left: "50%",
    bottom: "18px",
    transform: "translateX(-50%)",
    zIndex: "9999",
    pointerEvents: "none",
    display: "grid",
    gridTemplateColumns: "repeat(9, 54px)",
    gap: "8px",
    padding: "10px 12px",
    borderRadius: "16px",
    background: "rgba(0,0,0,0.35)",
    border: "1px solid rgba(255,255,255,0.14)",
    boxShadow: "0 12px 34px rgba(0,0,0,0.35)",
    backdropFilter: "blur(6px)",
  });

  const slots = [];
  for (let i = 0; i < 9; i++) {
    const slot = document.createElement("div");
    slot.dataset.idx = String(i);
    Object.assign(slot.style, {
      width: "54px",
      height: "54px",
      borderRadius: "14px",
      background: "rgba(15,15,18,0.65)",
      border: "1px solid rgba(255,255,255,0.12)",
      position: "relative",
      overflow: "hidden",
    });

    const icon = document.createElement("div");
    Object.assign(icon.style, {
      position: "absolute",
      left: "8px",
      top: "8px",
      right: "8px",
      bottom: "8px",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      fontSize: "12px",
      opacity: "0.95",
      textAlign: "center",
      lineHeight: "1.15",
      fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Arial",
      textShadow: "0 1px 2px rgba(0,0,0,0.85)",
      userSelect: "none",
      whiteSpace: "nowrap",
    });

    const qty = document.createElement("div");
    Object.assign(qty.style, {
      position: "absolute",
      right: "8px",
      bottom: "6px",
      fontSize: "12px",
      fontWeight: "800",
      opacity: "0.92",
      textShadow: "0 1px 2px rgba(0,0,0,0.85)",
      fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Arial",
      userSelect: "none",
    });

    const keycap = document.createElement("div");
    keycap.textContent = String(i + 1);
    Object.assign(keycap.style, {
      position: "absolute",
      left: "8px",
      bottom: "6px",
      fontSize: "11px",
      opacity: "0.55",
      fontWeight: "700",
      fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Arial",
      userSelect: "none",
    });

    slot.appendChild(icon);
    slot.appendChild(qty);
    slot.appendChild(keycap);
    wrap.appendChild(slot);

    slots.push({ slot, icon, qty });
  }

  document.body.appendChild(wrap);

  function itemShort(kind) {
    if (!kind) return "";
    const k = String(kind);
    const last = k.includes(":") ? k.split(":").pop() : k;
    return last.length > 14 ? last.slice(0, 14) + "…" : last;
  }

  function refresh() {
    for (let i = 0; i < 9; i++) {
      const uid = LOCAL_INV.slots?.[i] || "";
      const it = uid ? LOCAL_INV.items[uid] : null;

      slots[i].icon.textContent = it ? itemShort(it.kind) : "";
      slots[i].qty.textContent = it && safeNum(it.qty, 0) > 1 ? String(it.qty | 0) : "";

      const selected = i === (LOCAL_HOTBAR.index | 0);
      slots[i].slot.style.borderColor = selected ? "rgba(255,255,255,0.65)" : "rgba(255,255,255,0.12)";
      slots[i].slot.style.boxShadow = selected ? "0 0 0 2px rgba(255,255,255,0.18) inset" : "none";
    }
  }

  function setVisible(on) {
    wrap.style.display = on ? "grid" : "none";
  }

  return { refresh, setVisible };
}

const hotbarUI = createHotbarOverlay();

/* ============================================================
 * UI: INVENTORY OVERLAY (drag/drop, split)
 * ============================================================
 */

function createInventoryOverlay() {
  const overlay = document.createElement("div");
  overlay.id = "noa-inventory";
  Object.assign(overlay.style, {
    position: "fixed",
    inset: "0",
    display: "none",
    zIndex: "9998",
    background: "rgba(0,0,0,0.35)",
    backdropFilter: "blur(6px)",
  });

  const panel = document.createElement("div");
  Object.assign(panel.style, {
    position: "absolute",
    left: "50%",
    top: "50%",
    transform: "translate(-50%, -50%)",
    width: "min(860px, 92vw)",
    borderRadius: "18px",
    background: "rgba(20,20,24,0.88)",
    border: "1px solid rgba(255,255,255,0.14)",
    boxShadow: "0 18px 60px rgba(0,0,0,0.55)",
    padding: "16px",
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Arial",
    color: "rgba(255,255,255,0.92)",
  });

  const topRow = document.createElement("div");
  Object.assign(topRow.style, {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "12px",
    marginBottom: "12px",
  });

  const title = document.createElement("div");
  title.textContent = "Inventory";
  Object.assign(title.style, { fontSize: "18px", fontWeight: "800", letterSpacing: "0.2px" });

  const hint = document.createElement("div");
  hint.textContent = "Drag to move • Right-click: split stack • Esc/I to close";
  Object.assign(hint.style, { fontSize: "12px", opacity: "0.75" });

  topRow.appendChild(title);
  topRow.appendChild(hint);

  const gridWrap = document.createElement("div");
  Object.assign(gridWrap.style, {
    display: "grid",
    gridTemplateColumns: "1fr 260px",
    gap: "16px",
  });

  const invArea = document.createElement("div");
  const eqArea = document.createElement("div");

  // Inventory grid
  const invGrid = document.createElement("div");
  Object.assign(invGrid.style, {
    display: "grid",
    gridTemplateColumns: `repeat(${LOCAL_INV.cols || 9}, 64px)`,
    gap: "10px",
    padding: "12px",
    borderRadius: "16px",
    background: "rgba(0,0,0,0.25)",
    border: "1px solid rgba(255,255,255,0.10)",
    justifyContent: "center",
  });

  // Equipment
  const eqTitle = document.createElement("div");
  eqTitle.textContent = "Equipment";
  Object.assign(eqTitle.style, { fontSize: "14px", fontWeight: "800", marginBottom: "10px" });

  const eqGrid = document.createElement("div");
  Object.assign(eqGrid.style, {
    display: "grid",
    gridTemplateColumns: "repeat(2, 1fr)",
    gap: "10px",
  });

  const eqKeys = ["head", "chest", "legs", "feet", "tool", "offhand"];
  const eqCells = {};

  function makeSlotBox(label, slotId) {
    const cell = document.createElement("div");
    cell.dataset.slot = slotId;
    Object.assign(cell.style, {
      height: "64px",
      borderRadius: "14px",
      background: "rgba(15,15,18,0.65)",
      border: "1px solid rgba(255,255,255,0.12)",
      position: "relative",
      overflow: "hidden",
      userSelect: "none",
    });

    const lab = document.createElement("div");
    lab.textContent = label;
    Object.assign(lab.style, {
      position: "absolute",
      left: "10px",
      top: "8px",
      fontSize: "11px",
      opacity: "0.55",
      fontWeight: "700",
    });

    const icon = document.createElement("div");
    Object.assign(icon.style, {
      position: "absolute",
      left: "10px",
      right: "10px",
      bottom: "10px",
      top: "24px",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      fontSize: "12px",
      textAlign: "center",
      lineHeight: "1.15",
      opacity: "0.92",
      textShadow: "0 1px 2px rgba(0,0,0,0.85)",
      whiteSpace: "nowrap",
    });

    const qty = document.createElement("div");
    Object.assign(qty.style, {
      position: "absolute",
      right: "10px",
      bottom: "8px",
      fontSize: "12px",
      fontWeight: "900",
      opacity: "0.88",
      textShadow: "0 1px 2px rgba(0,0,0,0.85)",
    });

    cell.appendChild(lab);
    cell.appendChild(icon);
    cell.appendChild(qty);

    return { cell, icon, qty };
  }

  // build inv slots (max 9*4 by default)
  const invCells = [];
  function rebuildInvGrid() {
    invGrid.innerHTML = "";
    invCells.length = 0;

    const cols = LOCAL_INV.cols || 9;
    const rows = LOCAL_INV.rows || 4;

    invGrid.style.gridTemplateColumns = `repeat(${cols}, 64px)`;

    const total = cols * rows;
    for (let i = 0; i < total; i++) {
      const { cell, icon, qty } = makeSlotBox("", `inv:${i}`);
      // remove label for inv
      cell.firstChild.style.display = "none";

      invGrid.appendChild(cell);
      invCells.push({ cell, icon, qty });
    }
  }

  // build equip cells
  for (const k of eqKeys) {
    const pretty = k[0].toUpperCase() + k.slice(1);
    const { cell, icon, qty } = makeSlotBox(pretty, `eq:${k}`);
    eqGrid.appendChild(cell);
    eqCells[k] = { cell, icon, qty };
  }

  invArea.appendChild(invGrid);

  Object.assign(eqArea.style, {
    padding: "12px",
    borderRadius: "16px",
    background: "rgba(0,0,0,0.25)",
    border: "1px solid rgba(255,255,255,0.10)",
    height: "fit-content",
  });

  eqArea.appendChild(eqTitle);
  eqArea.appendChild(eqGrid);

  gridWrap.appendChild(invArea);
  gridWrap.appendChild(eqArea);

  panel.appendChild(topRow);
  panel.appendChild(gridWrap);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  // Drag state
  const drag = {
    active: false,
    from: "",
    over: "",
    uid: "",
    startX: 0,
    startY: 0,
  };

  function itemShort(kind) {
    if (!kind) return "";
    const k = String(kind);
    const last = k.includes(":") ? k.split(":").pop() : k;
    return last.length > 18 ? last.slice(0, 18) + "…" : last;
  }

  function slotUid(slotId) {
    if (!slotId) return "";
    if (slotId.startsWith("inv:")) {
      const idx = Number(slotId.slice(4));
      return LOCAL_INV.slots?.[idx] || "";
    }
    if (slotId.startsWith("eq:")) {
      const key = slotId.slice(3);
      return (LOCAL_INV.equip && LOCAL_INV.equip[key]) ? LOCAL_INV.equip[key] : "";
    }
    return "";
  }

  function renderCell(cellObj, uid, isSelectedHotbarSlot) {
    const it = uid ? LOCAL_INV.items[uid] : null;
    cellObj.icon.textContent = it ? itemShort(it.kind) : "";
    cellObj.qty.textContent = it && safeNum(it.qty, 0) > 1 ? String(it.qty | 0) : "";

    cellObj.cell.style.borderColor = isSelectedHotbarSlot
      ? "rgba(255,255,255,0.65)"
      : "rgba(255,255,255,0.12)";
    cellObj.cell.style.boxShadow = isSelectedHotbarSlot
      ? "0 0 0 2px rgba(255,255,255,0.18) inset"
      : "none";
  }

  function refresh() {
    // Ensure grid matches cols/rows
    if (invCells.length !== (LOCAL_INV.cols || 9) * (LOCAL_INV.rows || 4)) {
      rebuildInvGrid();
      bindCells();
    }

    // render inv
    const total = invCells.length;
    for (let i = 0; i < total; i++) {
      const uid = LOCAL_INV.slots?.[i] || "";
      const isHotbarSelected = i >= 0 && i <= 8 && i === (LOCAL_HOTBAR.index | 0);
      renderCell(invCells[i], uid, isHotbarSelected);
    }

    // render equip
    for (const k of eqKeys) {
      const uid = LOCAL_INV.equip?.[k] || "";
      renderCell(eqCells[k], uid, false);
    }
  }

  function sendInvMove(from, to) {
    if (!colyRoom) return;
    try {
      colyRoom.send("inv:move", { from, to });
    } catch (e) {}
  }

  function sendInvSplit(slot) {
    if (!colyRoom) return;
    try {
      colyRoom.send("inv:split", { slot });
    } catch (e) {}
  }

  function makeGhost(text) {
    const g = document.createElement("div");
    g.textContent = text;
    Object.assign(g.style, {
      position: "fixed",
      left: "0px",
      top: "0px",
      transform: "translate(-9999px, -9999px)",
      zIndex: "10000",
      pointerEvents: "none",
      padding: "10px 12px",
      borderRadius: "14px",
      background: "rgba(0,0,0,0.80)",
      border: "1px solid rgba(255,255,255,0.14)",
      color: "white",
      fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Arial",
      fontSize: "12px",
      fontWeight: "800",
      textShadow: "0 1px 2px rgba(0,0,0,0.85)",
      boxShadow: "0 10px 30px rgba(0,0,0,0.5)",
      maxWidth: "220px",
      whiteSpace: "nowrap",
      overflow: "hidden",
      textOverflow: "ellipsis",
    });
    document.body.appendChild(g);
    return g;
  }

  function setGhostPos(x, y) {
    if (!MESH.dragGhost) return;
    MESH.dragGhost.style.transform = `translate(${x + 12}px, ${y + 12}px)`;
  }

  function beginDrag(slotId, x, y) {
    const uid = slotUid(slotId);
    if (!uid) return;

    const it = LOCAL_INV.items[uid];
    drag.active = true;
    drag.from = slotId;
    drag.over = "";
    drag.uid = uid;
    drag.startX = x;
    drag.startY = y;

    const label = it ? `${itemShort(it.kind)}${safeNum(it.qty, 0) > 1 ? ` x${it.qty | 0}` : ""}` : uid;

    if (!MESH.dragGhost) MESH.dragGhost = makeGhost(label);
    else MESH.dragGhost.textContent = label;

    setGhostPos(x, y);
  }

  function endDrag() {
    if (!drag.active) return;

    if (MESH.dragGhost) {
      MESH.dragGhost.style.transform = "translate(-9999px, -9999px)";
    }

    if (drag.over && drag.over !== drag.from) {
      sendInvMove(drag.from, drag.over);
    }

    drag.active = false;
    drag.from = "";
    drag.over = "";
    drag.uid = "";
  }

  function onCellDown(slotId, e) {
    // right click = split
    if (e.button === 2) {
      e.preventDefault();
      sendInvSplit(slotId);
      return;
    }

    // left click start drag
    if (e.button === 0) {
      e.preventDefault();
      beginDrag(slotId, e.clientX, e.clientY);
    }
  }

  function onCellEnter(slotId) {
    if (!drag.active) return;
    drag.over = slotId;
  }

  function bindCells() {
    // prevent context menu over inventory UI
    overlay.addEventListener("contextmenu", (e) => e.preventDefault());

    // Bind inv cells
    for (const c of invCells) {
      const slotId = c.cell.dataset.slot;
      c.cell.style.pointerEvents = "auto";

      c.cell.onmousedown = (e) => onCellDown(slotId, e);
      c.cell.onmouseenter = () => onCellEnter(slotId);
    }

    // Bind eq cells
    for (const k of eqKeys) {
      const slotId = `eq:${k}`;
      const c = eqCells[k];
      c.cell.style.pointerEvents = "auto";
      c.cell.onmousedown = (e) => onCellDown(slotId, e);
      c.cell.onmouseenter = () => onCellEnter(slotId);
    }
  }

  rebuildInvGrid();
  bindCells();

  window.addEventListener("mousemove", (e) => {
    if (!drag.active) return;
    setGhostPos(e.clientX, e.clientY);
  });

  window.addEventListener("mouseup", () => {
    if (!drag.active) return;
    endDrag();
  });

  function open() {
    overlay.style.display = "block";
    refresh();
  }

  function close() {
    overlay.style.display = "none";
    endDrag();
  }

  function setVisible(on) {
    overlay.style.display = on ? "block" : "none";
    if (on) refresh();
    else endDrag();
  }

  return { open, close, setVisible, refresh, isOpen: () => overlay.style.display !== "none" };
}

const inventoryUI = createInventoryOverlay();

/* ============================================================
 * WORLD GENERATION
 * ============================================================
 */

const brownish = [0.45, 0.36, 0.22];
const greenish = [0.1, 0.8, 0.2];

noa.registry.registerMaterial("dirt", { color: brownish });
noa.registry.registerMaterial("grass", { color: greenish });

const dirtID = noa.registry.registerBlock(1, { material: "dirt" });
const grassID = noa.registry.registerBlock(2, { material: "grass" });

function getVoxelID(x, y, z) {
  if (y < -3) return dirtID;
  const height = 2 * Math.sin(x / 10) + 3 * Math.cos(z / 20);
  if (y < height) return grassID;
  return 0;
}

noa.world.on("worldDataNeeded", function (id, data, x, y, z) {
  for (let i = 0; i < data.shape[0]; i++) {
    for (let j = 0; j < data.shape[1]; j++) {
      for (let k = 0; k < data.shape[2]; k++) {
        const voxelID = getVoxelID(x + i, y + j, z + k);
        data.set(i, j, k, voxelID);
      }
    }
  }
  noa.world.setChunkData(id, data);
});

/* ============================================================
 * SCENE INIT
 * ============================================================
 */

function ensureSceneReady() {
  if (STATE.scene) return true;

  const scene = resolveScene();
  if (!scene) return false;

  STATE.scene = scene;

  // camera clip planes
  if (scene.activeCamera) {
    scene.activeCamera.minZ = 0.01;
    scene.activeCamera.maxZ = 5000;
  }

  // attempt to cache NOA follow offset state if present
  try {
    const st = noa.ents.getState(noa.camera.cameraTarget, "followsEntity");
    if (st?.offset) {
      STATE.camFollowState = st;
      STATE.baseFollowOffset = [...st.offset];
    }
  } catch (e) {}

  return true;
}

/* ============================================================
 * RIGS
 * ============================================================
 */

function createAvatarRig(scene, namePrefix) {
  const root = new BABYLON.TransformNode(namePrefix + "_root", scene);

  const skinMat = createSolidMat(scene, "mat_skin", new BABYLON.Color3(1.0, 0.82, 0.68));
  const shirtMat = createSolidMat(scene, "mat_shirt", new BABYLON.Color3(0.2, 0.4, 0.95));
  const pantsMat = createSolidMat(scene, "mat_pants", new BABYLON.Color3(0.1, 0.1, 0.2));
  const toolMat = createSolidMat(scene, "mat_av_tool", new BABYLON.Color3(0.9, 0.9, 0.95));

  const head = BABYLON.MeshBuilder.CreateBox(namePrefix + "_head", { size: 0.6 }, scene);
  head.material = skinMat;
  head.parent = root;
  head.position.set(0, 1.55, 0);

  const body = BABYLON.MeshBuilder.CreateBox(
    namePrefix + "_body",
    { width: 0.7, height: 0.9, depth: 0.35 },
    scene
  );
  body.material = shirtMat;
  body.parent = root;
  body.position.set(0, 0.95, 0);

  const armL = BABYLON.MeshBuilder.CreateBox(
    namePrefix + "_armL",
    { width: 0.25, height: 0.8, depth: 0.25 },
    scene
  );
  armL.material = shirtMat;
  armL.parent = root;
  armL.position.set(-0.55, 1.05, 0);

  const armR = BABYLON.MeshBuilder.CreateBox(
    namePrefix + "_armR",
    { width: 0.25, height: 0.8, depth: 0.25 },
    scene
  );
  armR.material = shirtMat;
  armR.parent = root;
  armR.position.set(0.55, 1.05, 0);

  const legL = BABYLON.MeshBuilder.CreateBox(
    namePrefix + "_legL",
    { width: 0.28, height: 0.85, depth: 0.28 },
    scene
  );
  legL.material = pantsMat;
  legL.parent = root;
  legL.position.set(-0.18, 0.35, 0);

  const legR = BABYLON.MeshBuilder.CreateBox(
    namePrefix + "_legR",
    { width: 0.28, height: 0.85, depth: 0.28 },
    scene
  );
  legR.material = pantsMat;
  legR.parent = root;
  legR.position.set(0.18, 0.35, 0);

  const tool = BABYLON.MeshBuilder.CreateBox(namePrefix + "_tool", { size: 0.28 }, scene);
  tool.material = toolMat;
  tool.parent = root;
  tool.position.set(0.72, 0.85, 0.18);
  tool.rotation.set(0.2, 0.2, 0.2);

  [head, body, armL, armR, legL, legR, tool].forEach((m) => {
    m.isPickable = false;
    noaAddMesh(m, false);
    m.alwaysSelectAsActiveMesh = true;
    m.isVisible = true;
    m.visibility = 1;
    m.cullingStrategy = BABYLON.AbstractMesh.CULLINGSTRATEGY_BOUNDINGSPHERE_ONLY;
  });

  return { root, head, body, armL, armR, legL, legR, tool };
}

function initFpsRig() {
  if (MESH.weaponRoot) return;
  const scene = STATE.scene;
  const cam = scene.activeCamera;

  const weaponRoot = new BABYLON.TransformNode("weaponRoot", scene);
  weaponRoot.parent = cam;
  weaponRoot.position.set(0, 0, 0);

  const armsRoot = new BABYLON.TransformNode("armsRoot", scene);
  armsRoot.parent = weaponRoot;

  const armMat = createSolidMat(scene, "mat_arm", new BABYLON.Color3(0.2, 0.8, 0.2));
  const toolMat = createSolidMat(scene, "mat_tool", new BABYLON.Color3(0.9, 0.9, 0.95));

  const armL = BABYLON.MeshBuilder.CreateBox("fp_armL", { width: 0.45, height: 0.9, depth: 0.45 }, scene);
  armL.material = armMat;
  armL.parent = armsRoot;
  armL.position.set(-0.55, -0.35, 1.05);
  armL.rotation.set(0.1, 0.25, 0);

  const armR = BABYLON.MeshBuilder.CreateBox("fp_armR", { width: 0.45, height: 0.9, depth: 0.45 }, scene);
  armR.material = armMat;
  armR.parent = armsRoot;
  armR.position.set(0.55, -0.35, 1.05);
  armR.rotation.set(0.1, -0.25, 0);

  const tool = BABYLON.MeshBuilder.CreateBox("fp_tool", { size: 0.35 }, scene);
  tool.material = toolMat;
  tool.parent = weaponRoot;
  tool.position.set(0.28, -0.55, 1.1);
  tool.rotation.set(0.25, 0.1, 0);

  [armL, armR, tool].forEach((m) => {
    m.isPickable = false;
    noaAddMesh(m, false);
  });

  MESH.weaponRoot = weaponRoot;
  MESH.armsRoot = armsRoot;
  MESH.armL = armL;
  MESH.armR = armR;
  MESH.tool = tool;
}

function initLocalAvatar() {
  if (MESH.avatarRoot) return;
  const rig = createAvatarRig(STATE.scene, "local_av");
  MESH.avatarRoot = rig.root;
  MESH.avParts = rig;
}

function initDebugMeshes() {
  if (MESH.proofA) return;
  const scene = STATE.scene;

  const proofA = BABYLON.MeshBuilder.CreateBox("proofA", { size: 3 }, scene);
  proofA.material = createSolidMat(scene, "mat_proofA", new BABYLON.Color3(0, 1, 0));
  proofA.position.set(0, 14, 0);
  noaAddMesh(proofA, true);

  const frontCube = BABYLON.MeshBuilder.CreateBox("frontCube", { size: 1.5 }, scene);
  frontCube.material = createSolidMat(scene, "mat_frontCube", new BABYLON.Color3(0, 0.6, 1));
  noaAddMesh(frontCube, false);

  MESH.proofA = proofA;
  MESH.frontCube = frontCube;

  refreshDebugProofMeshes();
}

function refreshDebugProofMeshes() {
  setEnabled(MESH.proofA, showDebugProof);
  setEnabled(MESH.frontCube, showDebugProof);
}

/* ============================================================
 * VIEW MODE ENFORCEMENT (CRITICAL FIX)
 * ============================================================
 */

function enforceViewModeEveryFrame() {
  const isFirst = viewMode === 0;

  // enforce camera zoom
  if (isFirst) {
    noa.camera.zoomDistance = 0;
    noa.camera.currentZoom = 0;
  } else {
    const z = clamp(noa.camera.zoomDistance || 6, 2, 12);
    noa.camera.zoomDistance = z;
    noa.camera.currentZoom = z;
  }

  // enforce NOA follow offset, if available
  try {
    const st = STATE.camFollowState;
    if (st?.offset) {
      if (isFirst) {
        st.offset[0] = STATE.baseFollowOffset[0];
        st.offset[1] = STATE.baseFollowOffset[1];
        st.offset[2] = STATE.baseFollowOffset[2];
      } else {
        st.offset[0] = STATE.baseFollowOffset[0] + 0.5;
        st.offset[1] = STATE.baseFollowOffset[1];
        st.offset[2] = STATE.baseFollowOffset[2];
      }
    }
  } catch (e) {}

  // enforce mesh visibility
  setEnabled(MESH.armsRoot, isFirst);
  setEnabled(MESH.tool, isFirst);
  setEnabled(MESH.avatarRoot, !isFirst);

  crosshairUI.refresh();
  hotbarUI.refresh();
}

function applyViewModeOnce() {
  initFpsRig();
  initLocalAvatar();
  initDebugMeshes();
  enforceViewModeEveryFrame();
}

/* ============================================================
 * 3RD PERSON CAMERA HARD FOLLOW (ONLY WHEN viewMode===1)
 * ============================================================
 */

function hardFollowThirdPersonCamera() {
  if (viewMode !== 1) return;
  if (!STATE.scene || !STATE.scene.activeCamera) return;
  if (!MESH.avatarRoot) return;

  const cam = STATE.scene.activeCamera;

  // keep camera upright (prevents slant/roll)
  cam.upVector = new BABYLON.Vector3(0, 1, 0);
  if (cam.rotation) cam.rotation.z = 0;

  const target = MESH.avatarRoot.position.clone();
  const heading = safeNum(noa.camera.heading, 0);
  const dist = clamp(noa.camera.zoomDistance || 6, 2, 12);

  const backDir = new BABYLON.Vector3(Math.sin(heading), 0, Math.cos(heading));
  const back = backDir.scale(-dist);
  const up = new BABYLON.Vector3(0, 1.7, 0);

  const desired = target.add(back).add(up);

  cam.position = BABYLON.Vector3.Lerp(cam.position, desired, 0.25);
  cam.setTarget(target.add(new BABYLON.Vector3(0, 1.2, 0)));

  if (cam.rotation) cam.rotation.z = 0;
}

/* ============================================================
 * ANIMATION
 * ============================================================
 */

function updateFpsRig(dt, speed) {
  if (viewMode !== 0 || !MESH.weaponRoot) return;

  const heading = safeNum(noa.camera.heading, 0);
  const pitch = safeNum(noa.camera.pitch, 0);

  let dHeading = heading - STATE.lastHeading;
  let dPitch = pitch - STATE.lastPitch;

  if (dHeading > Math.PI) dHeading -= Math.PI * 2;
  if (dHeading < -Math.PI) dHeading += Math.PI * 2;

  STATE.lastHeading = heading;
  STATE.lastPitch = pitch;

  // bob
  const bobRate = clamp(speed * 7, 0, 12);
  STATE.bobPhase += bobRate * dt;
  const bobY = Math.sin(STATE.bobPhase) * 0.03;
  const bobX = Math.sin(STATE.bobPhase * 0.5) * 0.015;

  // sway
  const swayX = clamp(-dHeading * 1.6, -0.08, 0.08);
  const swayY = clamp(dPitch * 1.2, -0.06, 0.06);

  // swing
  let swingAmt = 0;
  if (STATE.swingT < STATE.swingDuration) {
    const t = clamp(STATE.swingT / STATE.swingDuration, 0, 1);
    swingAmt = Math.sin(t * Math.PI) * 1.0;
  }

  const wr = MESH.weaponRoot;
  const s = clamp(dt * 12, 0, 1);

  const targetPos = new BABYLON.Vector3(
    bobX + swayX * 0.8,
    -0.02 + bobY - swingAmt * 0.04,
    0
  );

  const targetRot = new BABYLON.Vector3(
    swayY + swingAmt * 0.9,
    swayX * 0.8 + swingAmt * 0.15,
    swayX * 0.6 + swingAmt * 0.25
  );

  wr.position.copyFrom(BABYLON.Vector3.Lerp(wr.position, targetPos, s));
  wr.rotation.copyFrom(BABYLON.Vector3.Lerp(wr.rotation, targetRot, s));

  if (MESH.tool) {
    MESH.tool.rotation.x = 0.25 + swingAmt * 1.2;
    MESH.tool.rotation.y = 0.1 + swingAmt * 0.15;
    MESH.tool.rotation.z = 0 + swingAmt * 0.35;
  }
}

function updateAvatarAnim(parts, speed, grounded, isSwing) {
  if (!parts || !parts.root || !parts.root.isEnabled()) return;

  const walkAmp = grounded ? clamp(speed / 4.5, 0, 1) : 0;
  const walkPhase = STATE.bobPhase * 0.6;

  const legSwing = Math.sin(walkPhase) * 0.7 * walkAmp;
  const armSwing = Math.sin(walkPhase + Math.PI) * 0.55 * walkAmp;

  if (parts.legL) parts.legL.rotation.x = legSwing;
  if (parts.legR) parts.legR.rotation.x = -legSwing;
  if (parts.armL) parts.armL.rotation.x = armSwing;

  let swingAmt = 0;
  if (isSwing) {
    const t = clamp(STATE.swingT / STATE.swingDuration, 0, 1);
    swingAmt = Math.sin(t * Math.PI) * 1.0;
  }

  if (parts.armR) {
    parts.armR.rotation.x = -armSwing + swingAmt * 1.4;
    parts.armR.rotation.z = swingAmt * 0.25;
  }

  if (parts.tool) {
    parts.tool.rotation.x = 0.2 + swingAmt * 1.2;
    parts.tool.rotation.z = 0.2 + swingAmt * 0.35;
  }
}

/* ============================================================
 * PHYSICS SNAPSHOT
 * ============================================================
 */

function getLocalPhysics(dt) {
  let speed = 0;
  let grounded = false;

  try {
    const body = noa.entities.getPhysicsBody(noa.playerEntity);
    if (body) {
      const v = body.velocity;
      speed = Math.sqrt(v[0] * v[0] + v[2] * v[2]);
      if (body.resting[1] < 0) grounded = true;
    }
  } catch (e) {}

  const p = getSafePlayerPos();
  if (!speed && STATE.lastPlayerPos && p) {
    const dx = p[0] - STATE.lastPlayerPos[0];
    const dz = p[2] - STATE.lastPlayerPos[2];
    speed = Math.sqrt(dx * dx + dz * dz) / dt;
  }

  if (p) STATE.lastPlayerPos = [...p];

  return { speed, grounded };
}

/* ============================================================
 * MULTIPLAYER STATE SNAPSHOT + SYNC
 * ============================================================
 */

function getPlayersSnapshot(players) {
  const out = {};
  if (!players) return out;

  if (typeof players.forEach === "function") {
    try {
      players.forEach((player, sessionId) => {
        out[sessionId] = player;
      });
      return out;
    } catch (e) {}
  }

  try {
    for (const k of Object.keys(players)) out[k] = players[k];
  } catch (e) {}

  return out;
}

function spawnRemotePlayer(sessionId, player) {
  if (!sessionId || !player) return;
  if (colyRoom && sessionId === colyRoom.sessionId) return;
  if (remotePlayers[sessionId]) return;
  if (!ensureSceneReady()) return;

  const rig = createAvatarRig(STATE.scene, "remote_" + sessionId);

  const px = safeNum(player.x, 0);
  const py = safeNum(player.y, 0);
  const pz = safeNum(player.z, 0);
  const yaw = safeNum(player.yaw, 0);

  remotePlayers[sessionId] = {
    mesh: rig.root,
    parts: rig,
    targetPos: { x: px, y: py, z: pz },
    targetRot: yaw,
    lastPos: { x: px, y: py, z: pz },
  };

  rig.root.position.set(px, py + 0.075, pz);
  rig.root.rotation.y = yaw;

  forceRigBounds(rig);
}

function removeRemotePlayer(sessionId) {
  const rp = remotePlayers[sessionId];
  if (!rp) return;

  try {
    if (rp.mesh) rp.mesh.dispose();
  } catch (e) {}

  delete remotePlayers[sessionId];
}

function updateRemoteTargetsFromState(playersObj) {
  for (const sessionId of Object.keys(playersObj)) {
    if (colyRoom && sessionId === colyRoom.sessionId) continue;

    const player = playersObj[sessionId];
    if (!player) continue;

    if (!remotePlayers[sessionId]) {
      spawnRemotePlayer(sessionId, player);
      continue;
    }

    const rp = remotePlayers[sessionId];
    rp.targetPos.x = safeNum(player.x, rp.targetPos.x);
    rp.targetPos.y = safeNum(player.y, rp.targetPos.y);
    rp.targetPos.z = safeNum(player.z, rp.targetPos.z);
    rp.targetRot = safeNum(player.yaw, rp.targetRot);
  }
}

function snapshotMyState(me) {
  if (!me) return;

  // stats
  LOCAL_STATS.hp = safeNum(me.hp, LOCAL_STATS.hp);
  LOCAL_STATS.maxHp = safeNum(me.maxHp, LOCAL_STATS.maxHp);
  LOCAL_STATS.stamina = safeNum(me.stamina, LOCAL_STATS.stamina);
  LOCAL_STATS.maxStamina = safeNum(me.maxStamina, LOCAL_STATS.maxStamina);
  LOCAL_STATS.sprinting = !!me.sprinting;
  LOCAL_STATS.swinging = !!me.swinging;

  // hotbar
  LOCAL_HOTBAR.index = safeNum(me.hotbarIndex, LOCAL_HOTBAR.index) | 0;

  // inventory sizes
  LOCAL_INV.cols = safeNum(me.inventory?.cols, LOCAL_INV.cols) | 0;
  LOCAL_INV.rows = safeNum(me.inventory?.rows, LOCAL_INV.rows) | 0;

  // slots
  const slots = [];
  try {
    const src = me.inventory?.slots;
    if (src && typeof src.length === "number") {
      for (let i = 0; i < src.length; i++) slots.push(String(src[i] || ""));
    }
  } catch (e) {}
  LOCAL_INV.slots = slots;

  // equip
  const eq = me.equip || {};
  LOCAL_INV.equip = {
    head: String(eq.head || ""),
    chest: String(eq.chest || ""),
    legs: String(eq.legs || ""),
    feet: String(eq.feet || ""),
    tool: String(eq.tool || ""),
    offhand: String(eq.offhand || ""),
  };

  // items map
  const items = {};
  try {
    const m = me.items;
    if (m && typeof m.forEach === "function") {
      m.forEach((it, uid) => {
        items[String(uid)] = {
          uid: String(it.uid || uid),
          kind: String(it.kind || ""),
          qty: safeNum(it.qty, 0) | 0,
          durability: safeNum(it.durability, 0) | 0,
          maxDurability: safeNum(it.maxDurability, 0) | 0,
          meta: String(it.meta || ""),
        };
      });
    } else if (m && typeof m === "object") {
      for (const uid of Object.keys(m)) {
        const it = m[uid];
        items[String(uid)] = {
          uid: String(it.uid || uid),
          kind: String(it.kind || ""),
          qty: safeNum(it.qty, 0) | 0,
          durability: safeNum(it.durability, 0) | 0,
          maxDurability: safeNum(it.maxDurability, 0) | 0,
          meta: String(it.meta || ""),
        };
      }
    }
  } catch (e) {}

  LOCAL_INV.items = items;

  // refresh UI
  hotbarUI.refresh();
  if (inventoryUI.isOpen()) inventoryUI.refresh();
}

function syncPlayersFromState(state) {
  if (!state) return;

  const playersObj = getPlayersSnapshot(state.players);
  const newKeys = new Set(Object.keys(playersObj));

  for (const k of newKeys) {
    if (!lastPlayersKeys.has(k)) spawnRemotePlayer(k, playersObj[k]);
  }

  for (const k of lastPlayersKeys) {
    if (!newKeys.has(k)) removeRemotePlayer(k);
  }

  updateRemoteTargetsFromState(playersObj);
  lastPlayersKeys = newKeys;

  // snapshot my player for UI
  if (colyRoom && playersObj[colyRoom.sessionId]) {
    snapshotMyState(playersObj[colyRoom.sessionId]);
  }
}

/* ============================================================
 * NETWORK SEND HELPERS
 * ============================================================
 */

function sendHotbarIndex(index) {
  if (!colyRoom) return;
  try {
    colyRoom.send("hotbar:set", { index: index | 0 });
  } catch (e) {}
}

function sendSprint(on) {
  if (!colyRoom) return;
  try {
    colyRoom.send("sprint", { on: !!on });
  } catch (e) {}
}

function sendSwing() {
  if (!colyRoom) return;
  try {
    colyRoom.send("swing", { t: performance.now() });
  } catch (e) {}
}

/* ============================================================
 * INPUTS
 * ============================================================
 */

document.addEventListener("keydown", (e) => {
  if (e.code === "KeyV") {
    viewMode = (viewMode + 1) % 2;
    applyViewModeOnce();
  }

  if (e.code === "KeyC") {
    forceCrosshair = !forceCrosshair;
    crosshairUI.refresh();
  }

  if (e.code === "KeyP") {
    showDebugProof = !showDebugProof;
    refreshDebugProofMeshes();
  }

  // Inventory toggle
  if (e.code === "KeyI" || e.code === "Tab") {
    e.preventDefault();
    inventoryOpen = !inventoryOpen;
    inventoryUI.setVisible(inventoryOpen);

    // When inventory opens, release pointer lock if locked
    if (inventoryOpen && document.pointerLockElement === noa.container.canvas) {
      document.exitPointerLock?.();
    }
  }

  // ESC closes inventory
  if (e.code === "Escape") {
    if (inventoryOpen) {
      inventoryOpen = false;
      inventoryUI.setVisible(false);
    }
  }

  // Hotbar number keys (only when inventory closed)
  if (!inventoryOpen) {
    if (e.code === "Digit1") sendHotbarIndex(0);
    if (e.code === "Digit2") sendHotbarIndex(1);
    if (e.code === "Digit3") sendHotbarIndex(2);
    if (e.code === "Digit4") sendHotbarIndex(3);
    if (e.code === "Digit5") sendHotbarIndex(4);
    if (e.code === "Digit6") sendHotbarIndex(5);
    if (e.code === "Digit7") sendHotbarIndex(6);
    if (e.code === "Digit8") sendHotbarIndex(7);
    if (e.code === "Digit9") sendHotbarIndex(8);
  }
});

// 3rd-person zoom + hotbar scroll
noa.on("tick", function () {
  const scroll = noa.inputs.pointerState.scrolly;

  // 3rd-person zoom
  if (scroll !== 0 && viewMode === 1 && !inventoryOpen) {
    noa.camera.zoomDistance = clamp(noa.camera.zoomDistance + (scroll > 0 ? 1 : -1), 2, 12);
    noa.camera.currentZoom = noa.camera.zoomDistance;
  }

  // hotbar wheel selection (Minecraft-like)
  if (!inventoryOpen && scroll !== 0) {
    const dir = scroll > 0 ? 1 : -1;
    const next = (LOCAL_HOTBAR.index + dir + 9) % 9;
    sendHotbarIndex(next);
  }
});

function triggerSwingLocalOnly() {
  STATE.swingT = 0;
}

noa.inputs.down.on("fire", function () {
  triggerSwingLocalOnly();
  sendSwing();

  // mine
  if (noa.targetedBlock) {
    const pos = noa.targetedBlock.position;
    noa.setBlock(0, pos[0], pos[1], pos[2]);
  }
});

noa.inputs.down.on("alt-fire", function () {
  triggerSwingLocalOnly();
  sendSwing();

  // place
  if (noa.targetedBlock) {
    const pos = noa.targetedBlock.adjacent;
    noa.setBlock(grassID, pos[0], pos[1], pos[2]);
  }
});

noa.inputs.bind("alt-fire", "KeyE");

// Sprint intent: Shift key
document.addEventListener("keydown", (e) => {
  if (e.code === "ShiftLeft" || e.code === "ShiftRight") {
    if (!inventoryOpen) sendSprint(true);
  }
});
document.addEventListener("keyup", (e) => {
  if (e.code === "ShiftLeft" || e.code === "ShiftRight") {
    sendSprint(false);
  }
});

/* ============================================================
 * MAIN RENDER LOOP
 * ============================================================
 */

noa.on("beforeRender", function () {
  if (!ensureSceneReady()) return;

  // ensure rigs exist
  initFpsRig();
  initLocalAvatar();
  initDebugMeshes();

  // enforce view mode EVERY frame (prevents mid-air flip)
  enforceViewModeEveryFrame();

  const now = performance.now();
  const dt = clamp((now - STATE.lastTime) / 1000, 0, 0.05);
  STATE.lastTime = now;
  STATE.swingT += dt;

  const { speed, grounded } = getLocalPhysics(dt);

  // FPS rig animation
  updateFpsRig(dt, speed);

  // Local avatar update (always follows physics position)
  if (MESH.avatarRoot) {
    const p = getSafePlayerPos();

    MESH.avatarRoot.position.set(p[0], p[1] + 0.075, p[2]);
    MESH.avatarRoot.rotation.y = safeNum(noa.camera.heading, 0);

    MESH.avatarRoot.computeWorldMatrix(true);
    forceRigBounds(MESH.avParts);

    updateAvatarAnim(MESH.avParts, speed, grounded, STATE.swingT < STATE.swingDuration);
  }

  // 3rd-person hard camera follow (ONLY in 3rd person)
  hardFollowThirdPersonCamera();

  // Remote interpolation
  for (const sid in remotePlayers) {
    const rp = remotePlayers[sid];
    if (!rp || !rp.mesh) continue;

    const t = 0.2;

    rp.mesh.position.x = lerp(rp.mesh.position.x, rp.targetPos.x, t);
    rp.mesh.position.y = lerp(rp.mesh.position.y, rp.targetPos.y + 0.075, t);
    rp.mesh.position.z = lerp(rp.mesh.position.z, rp.targetPos.z, t);

    rp.mesh.rotation.y = lerp(rp.mesh.rotation.y, rp.targetRot, t);

    forceRigBounds(rp.parts);

    // basic speed estimate for animation
    const dx = rp.mesh.position.x - rp.lastPos.x;
    const dz = rp.mesh.position.z - rp.lastPos.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    const remoteSpeed = dt > 0 ? dist / dt : 0;

    rp.lastPos.x = rp.mesh.position.x;
    rp.lastPos.y = rp.mesh.position.y;
    rp.lastPos.z = rp.mesh.position.z;

    updateAvatarAnim(rp.parts, remoteSpeed, true, false);
  }

  // debug cube in front of camera
  if (showDebugProof && MESH.frontCube && STATE.scene?.activeCamera) {
    const cam = STATE.scene.activeCamera;
    const fwd = cam.getForwardRay(3).direction;
    MESH.frontCube.position.copyFrom(cam.position).addInPlace(fwd.scale(3));
  }

  // send move at 10Hz
  // (simple throttle without setInterval, keeps it in sync with render loop)
  if (colyRoom) {
    STATE._moveAccum = (STATE._moveAccum || 0) + dt;
    if (STATE._moveAccum >= 0.1) {
      STATE._moveAccum = 0;

      const p = getSafePlayerPos();
      const yaw = noa.camera.heading;
      const pitch = noa.camera.pitch;

      try {
        colyRoom.send("move", { x: p[0], y: p[1], z: p[2], yaw, pitch, viewMode });
      } catch (e) {}
    }
  }
});

/* ============================================================
 * COLYSEUS CLIENT
 * ============================================================
 */

const ENDPOINT =
  import.meta.env && import.meta.env.VITE_COLYSEUS_ENDPOINT
    ? import.meta.env.VITE_COLYSEUS_ENDPOINT
    : "ws://localhost:2567";

const colyseusClient = new ColyClient(ENDPOINT);

async function connectColyseus() {
  console.log("Connecting to Colyseus at:", ENDPOINT);

  try {
    const room = await colyseusClient.joinOrCreate("my_room", { name: "Steve" });
    colyRoom = room;

    console.log("Colyseus Connected. Session ID:", room.sessionId);

    room.onMessage("welcome", (msg) => {
      console.log("[server] welcome:", msg);
    });

    room.onMessage("hello_ack", (msg) => {
      console.log("[server] hello_ack:", msg);
    });

    if (room.state) syncPlayersFromState(room.state);

    room.onStateChange((state) => {
      syncPlayersFromState(state);
    });

    // optional ping
    room.send("hello", { hi: true });
  } catch (err) {
    console.error("Colyseus Connection Failed:", err);
  }
}

connectColyseus();

/* ============================================================
 * BOOT
 * ============================================================
 */

const bootInterval = setInterval(() => {
  if (ensureSceneReady()) {
    clearInterval(bootInterval);
    applyViewModeOnce();
    console.log("Scene Ready.");
  }
}, 100);
