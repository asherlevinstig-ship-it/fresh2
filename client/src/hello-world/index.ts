// @ts-nocheck
/*
 * fresh2 - client main/index (PRODUCTION - FULL LOGIC)
 * -----------------------------------------------------------------------
 * DIAGNOSTIC VERSION
 * - Adds logs to confirm Patch arrival.
 * - Adds F7 key to force re-download Town.
 */

import { Engine } from "noa-engine";
import * as BABYLON from "babylonjs";
import * as Colyseus from "colyseus.js";

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

const TOWN = { cx: 0, cz: 0, radius: 48, groundY: 6 };

const RENDER_PRESET_OUTSIDE = { chunkAddDistance: 2.5, chunkRemoveDistance: 3.5, cameraMaxZ: 220, fog: false, fogDensity: 0.0 };
const RENDER_PRESET_TOWN = { chunkAddDistance: 1.35, chunkRemoveDistance: 2.15, cameraMaxZ: 120, fog: true, fogDensity: 0.018 };

const opts = {
  debug: true, showFPS: true, chunkSize: 32,
  chunkAddDistance: RENDER_PRESET_OUTSIDE.chunkAddDistance,
  chunkRemoveDistance: RENDER_PRESET_OUTSIDE.chunkRemoveDistance,
  stickyPointerLock: true, dragCameraOutsidePointerLock: true,
  initialZoom: 0, zoomSpeed: 0.25,
};

const noa = new Engine(opts);
console.log("noa-engine booted:", noa.version);

// --- GLOBAL STATE ---
let viewMode = 0; 
let inventoryOpen = false;
let chatOpen = false;
let colyRoom = null;
let mySessionId = null;
const remotePlayers = {}; 
const mobs = {};          
let inTown = false;
let lastTownToggleAt = 0;

// CLIENT EDITS (The fix for invisible town)
const CLIENT_EDITS = new Map();
function getEditKey(x, y, z) {
    return `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`;
}

const LOCAL_STATE = {
  hp: 20, maxHp: 20, stamina: 100, hotbarIndex: 0,
  inventory: [], craft: [], craftResult: null, cursor: null, equip: { tool: "" }
};

const STATE = {
  scene: null, lastTime: performance.now(), bobPhase: 0, swingT: 999, swingDuration: 0.22, moveAccum: 0,
  worldReady: false, spawnSnapDone: false, pendingTeleport: null,
  desiredSpawn: { x: 0, y: TOWN.groundY + 2, z: 0 },
  freezeUntil: performance.now() + 2000,
  logPos: false, lastPosLogAt: 0,
};

// --- UI CONSOLE ---
const UI_CONSOLE = (() => {
  const wrap = document.createElement("div");
  Object.assign(wrap.style, { position: "fixed", left: "14px", bottom: "90px", width: "min(600px, 90vw)", maxHeight: "300px", zIndex: "10050", display: "none", pointerEvents: "none", fontFamily: "monospace", color: "white", fontSize: "12px", textShadow: "1px 1px 0 #000" });
  const scroller = document.createElement("div");
  Object.assign(scroller.style, { background: "rgba(0,0,0,0.6)", padding: "10px", borderRadius: "8px", overflowY: "auto", maxHeight: "100%", pointerEvents: "auto" });
  wrap.appendChild(scroller); document.body.appendChild(wrap);
  function log(msg, color = "#fff") { const el = document.createElement("div"); el.textContent = `> ${msg}`; el.style.color = color; scroller.appendChild(el); scroller.scrollTop = scroller.scrollHeight; }
  return { log: (m) => log(m), warn: (m) => log(m, "#ffaa00"), error: (m) => log(m, "#ff5555"), toggle: () => { wrap.style.display = wrap.style.display === "none" ? "block" : "none"; } };
})();
const uiLog = UI_CONSOLE.log;

// --- CHAT UI ---
function createChatUI() {
  const wrap = document.createElement("div"); Object.assign(wrap.style, { position: "fixed", left: "14px", bottom: "150px", width: "400px", height: "200px", display: "flex", flexDirection: "column", gap: "5px", zIndex: "10060", pointerEvents: "none" });
  const logArea = document.createElement("div"); Object.assign(logArea.style, { flex: "1", overflowY: "auto", background: "rgba(0,0,0,0.4)", borderRadius: "6px", padding: "8px", fontFamily: "monospace", fontSize: "13px", color: "white", textShadow: "1px 1px 0 #000", display: "flex", flexDirection: "column", justifyContent: "flex-end", maskImage: "linear-gradient(to bottom, transparent, black 10%)" });
  const input = document.createElement("input"); Object.assign(input.style, { width: "100%", background: "rgba(0,0,0,0.7)", border: "1px solid #555", color: "white", padding: "8px", borderRadius: "4px", outline: "none", fontFamily: "monospace", display: "none", pointerEvents: "auto" });
  wrap.appendChild(logArea); wrap.appendChild(input); document.body.appendChild(wrap);
  return { add: (t, c="#eee") => { const el = document.createElement("div"); el.textContent = t; el.style.color = c; el.style.marginBottom = "2px"; logArea.appendChild(el); logArea.scrollTop = logArea.scrollHeight; }, toggle: () => { chatOpen = !chatOpen; if (chatOpen) { input.style.display = "block"; document.exitPointerLock(); input.focus(); wrap.style.pointerEvents = "auto"; } else { input.style.display = "none"; input.value = ""; noa.container.canvas.requestPointerLock(); wrap.style.pointerEvents = "none"; } }, isOpen: () => chatOpen, input };
}
const chatUI = createChatUI();

// --- INVENTORY UI ---
function createInventoryUI() {
  const overlay = document.createElement("div"); Object.assign(overlay.style, { position: "fixed", inset: "0", display: "none", zIndex: "9998", background: "rgba(0,0,0,0.5)", backdropFilter: "blur(4px)" });
  const cursorEl = document.createElement("div"); Object.assign(cursorEl.style, { position: "fixed", width: "48px", height: "48px", pointerEvents: "none", zIndex: "10000", display: "none", background: "none", color: "white", fontSize: "10px", textAlign: "center", lineHeight: "48px", textShadow: "1px 1px 2px black", fontWeight: "bold" }); document.body.appendChild(cursorEl);
  const panel = document.createElement("div"); Object.assign(panel.style, { position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -50%)", width: "min(800px, 95vw)", background: "rgba(30,30,35,0.95)", borderRadius: "12px", border: "1px solid #444", padding: "20px", display: "grid", gridTemplateColumns: "240px 1fr", gap: "20px", fontFamily: "system-ui, sans-serif", color: "#eee" });
  
  // Left: Crafting
  const leftCol = document.createElement("div"); leftCol.innerHTML = `<div style="font-weight:bold; margin-bottom:8px">Crafting</div>`;
  const craftWrap = document.createElement("div"); Object.assign(craftWrap.style, { display: "flex", gap: "10px", alignItems: "center", background: "#222", padding: "10px", borderRadius: "8px" });
  const craftGrid = document.createElement("div"); Object.assign(craftGrid.style, { display: "grid", gridTemplateColumns: "repeat(3, 48px)", gap: "4px" });
  const craftCells = [];
  for (let i = 0; i < 9; i++) { const { cell, icon, qty, durabilityBar } = makeSlot("craft", i); craftGrid.appendChild(cell); craftCells.push({ cell, icon, qty, durabilityBar }); }
  const resWrap = document.createElement("div"); const { cell: resCell, icon: resIcon, qty: resQty, durabilityBar: resDur } = makeSlot("result", 0); resCell.style.border = "1px solid #6c6"; resWrap.appendChild(resCell);
  craftWrap.appendChild(craftGrid); craftWrap.appendChild(document.createTextNode("→")); craftWrap.appendChild(resWrap); leftCol.appendChild(craftWrap);
  leftCol.appendChild(document.createElement("hr"));
  const eqGrid = document.createElement("div"); Object.assign(eqGrid.style, { display: "grid", gridTemplateColumns: "repeat(3, 48px)", gap: "4px" });
  ["head", "chest", "legs"].forEach(k => { const d = document.createElement("div"); Object.assign(d.style, { width:"48px", height:"48px", border:"1px solid #333", background:"#111" }); eqGrid.appendChild(d); }); leftCol.appendChild(eqGrid);

  // Right: Inventory
  const rightCol = document.createElement("div"); rightCol.innerHTML = `<div style="font-weight:bold; margin-bottom:8px">Inventory</div>`;
  const invGrid = document.createElement("div"); Object.assign(invGrid.style, { display: "grid", gridTemplateColumns: "repeat(9, 48px)", gap: "4px" });
  const invCells = [];
  for (let i = 0; i < 36; i++) { const { cell, icon, qty, durabilityBar } = makeSlot("inv", i); invGrid.appendChild(cell); invCells.push({ cell, icon, qty, durabilityBar }); }
  rightCol.appendChild(invGrid);
  panel.appendChild(leftCol); panel.appendChild(rightCol); overlay.appendChild(panel); document.body.appendChild(overlay);

  function makeSlot(loc, idx) {
    const cell = document.createElement("div"); Object.assign(cell.style, { width: "48px", height: "48px", background: "rgba(255,255,255,0.05)", border: "1px solid #444", borderRadius: "4px", position: "relative", cursor: "pointer", userSelect: "none" });
    const icon = document.createElement("div"); Object.assign(icon.style, { position: "absolute", inset: "2px", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "10px", textAlign: "center", pointerEvents: "none" });
    const qty = document.createElement("div"); Object.assign(qty.style, { position: "absolute", bottom: "1px", right: "2px", fontSize: "11px", fontWeight: "bold", pointerEvents: "none" });
    const durabilityBar = document.createElement("div"); Object.assign(durabilityBar.style, { position: "absolute", bottom: "2px", left: "2px", right: "2px", height: "3px", background: "#555", display: "none" });
    const durInner = document.createElement("div"); Object.assign(durInner.style, { height: "100%", width: "0%", background: "linear-gradient(to right, #f00, #0f0)" });
    durabilityBar.appendChild(durInner); cell.appendChild(durabilityBar); cell.appendChild(icon); cell.appendChild(qty);
    cell.addEventListener("mousedown", (e) => { e.stopPropagation(); if (colyRoom) colyRoom.send("inv:click", { location: loc, index: idx, button: e.button === 2 ? 1 : 0 }); });
    cell.addEventListener("contextmenu", e => e.preventDefault());
    return { cell, icon, qty, durabilityBar: { outer: durabilityBar, inner: durInner } };
  }
  function getShortName(kind) { if(!kind) return ""; return kind.split(":")[1] || kind; }
  function updateSlotVisual(uiObj, item) {
      uiObj.icon.textContent = item ? getShortName(item.kind) : "";
      uiObj.qty.textContent = (item && item.qty > 1) ? item.qty : "";
      if (item && item.maxDurability && item.durability < item.maxDurability) {
          uiObj.durabilityBar.outer.style.display = "block";
          const pct = Math.max(0, Math.min(100, (item.durability / item.maxDurability) * 100));
          uiObj.durabilityBar.inner.style.width = pct + "%";
      } else { uiObj.durabilityBar.outer.style.display = "none"; }
  }
  function refresh() {
    for(let i=0; i<36; i++) updateSlotVisual(invCells[i], LOCAL_STATE.inventory[i]);
    for(let i=0; i<9; i++) updateSlotVisual(craftCells[i], LOCAL_STATE.craft[i]);
    updateSlotVisual({ icon: resIcon, qty: resQty, durabilityBar: resDur }, LOCAL_STATE.craftResult);
    const cur = LOCAL_STATE.cursor;
    if (cur && cur.kind && cur.qty > 0) { cursorEl.style.display = "block"; cursorEl.textContent = `${getShortName(cur.kind)} (${cur.qty})`; } else { cursorEl.style.display = "none"; }
  }
  window.addEventListener("mousemove", (e) => { if (inventoryOpen) { cursorEl.style.left = (e.clientX + 10) + "px"; cursorEl.style.top = (e.clientY + 10) + "px"; } });
  return { toggle: () => { const open = overlay.style.display === "none"; overlay.style.display = open ? "block" : "none"; inventoryOpen = open; if (open) document.exitPointerLock(); else { noa.container.canvas.requestPointerLock(); if(colyRoom) colyRoom.send("inv:close"); } }, refresh, isOpen: () => overlay.style.display !== "none" };
}
const inventoryUI = createInventoryUI();

// --- HOTBAR UI ---
function createHotbarUI() {
  const div = document.createElement("div"); Object.assign(div.style, { position: "fixed", bottom: "10px", left: "50%", transform: "translateX(-50%)", display: "flex", gap: "5px", padding: "5px", background: "rgba(0,0,0,0.5)", borderRadius: "8px", pointerEvents: "none" });
  const slots = [];
  for (let i = 0; i < 9; i++) {
    const s = document.createElement("div"); Object.assign(s.style, { width: "50px", height: "50px", border: "2px solid #555", borderRadius: "4px", position: "relative", background: "rgba(0,0,0,0.3)" });
    const icon = document.createElement("div"); Object.assign(icon.style, { position: "absolute", inset: "0", display: "flex", justifyContent: "center", alignItems: "center", color: "white", fontSize: "10px", textAlign: "center" });
    const qty = document.createElement("div"); Object.assign(qty.style, { position: "absolute", bottom: "2px", right: "2px", fontSize: "10px", fontWeight: "bold", color: "#fff" });
    s.appendChild(icon); s.appendChild(qty); div.appendChild(s); slots.push({ s, icon, qty });
  }
  document.body.appendChild(div);
  return { refresh: () => { for (let i = 0; i < 9; i++) { const item = LOCAL_STATE.inventory[i]; const isSel = (i === LOCAL_STATE.hotbarIndex); slots[i].s.style.borderColor = isSel ? "white" : "#555"; slots[i].icon.textContent = item ? item.kind.split(":")[1] : ""; slots[i].qty.textContent = (item && item.qty > 1) ? item.qty : ""; } } };
}
const hotbarUI = createHotbarUI();

// --- BLOCKS ---
const mats = {
  dirt: [0.45, 0.36, 0.22], grass: [0.1, 0.8, 0.2], stone: [0.5, 0.5, 0.5], bedrock: [0.2, 0.2, 0.2],
  log: [0.4, 0.3, 0.1], leaves: [0.2, 0.6, 0.2], planks: [0.6, 0.45, 0.25], sand: [0.85, 0.8, 0.55],
  snow: [0.92, 0.94, 0.98], clay: [0.6, 0.62, 0.7], gravel: [0.55, 0.55, 0.55], mud: [0.28, 0.22, 0.18], ice: [0.7, 0.85, 1.0],
  coal_ore: [0.25, 0.25, 0.25], copper_ore: [0.72, 0.42, 0.25], iron_ore: [0.76, 0.65, 0.55], silver_ore: [0.78, 0.78, 0.85], gold_ore: [0.9, 0.78, 0.2],
  ruby_ore: [0.85, 0.15, 0.25], sapphire_ore: [0.15, 0.35, 0.9], mythril_ore: [0.3, 0.9, 0.85], dragonstone: [0.5, 0.1, 0.75],
  crafting_table: [0.55, 0.35, 0.18], chest: [0.58, 0.38, 0.18],
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
  crafting_table: noa.registry.registerBlock(30, { material: "crafting_table" }),
  chest: noa.registry.registerBlock(31, { material: "chest" }),
};

const PALETTE = {
  AIR: 0, DIRT: 1, GRASS: 2, STONE: 3, BEDROCK: 4, LOG: 5, LEAVES: 6,
  SAND: 8, SNOW: 9, CLAY: 10, GRAVEL: 11, MUD: 12, ICE: 13,
  COAL_ORE: 14, COPPER_ORE: 15, IRON_ORE: 16, SILVER_ORE: 17, GOLD_ORE: 18,
  RUBY_ORE: 19, SAPPHIRE_ORE: 20, MYTHRIL_ORE: 21, DRAGONSTONE: 22,
};
const ORE_TABLES = buildDefaultOreTablesFromPalette(PALETTE);

function getVoxelID(x, y, z) {
  // 1. Check Server Edits (Fixes Invisible Town)
  // Use Math.floor to strictly match server logic
  const key = getEditKey(x, y, z);
  const edit = CLIENT_EDITS.get(key);
  if (edit !== undefined) return edit;

  // 2. Procedural
  if (y < -10) return ID.bedrock;
  const sb = sampleBiome(x, z);
  const biome = sb.biome;
  const height = sb.height;

  if (y > height) {
    const maxVegetationY = height + 8;
    if (y >= maxVegetationY) return 0;
    if (shouldSpawnTree(x, z, biome)) {
      const spec = getTreeSpec(x, z, biome);
      const treeBaseY = height + 1;
      const trunkTopY = treeBaseY + spec.trunkHeight - 1;
      if (y >= treeBaseY && y <= trunkTopY) return ID.log;
      const dy = y - trunkTopY;
      if (spec.type === "oak") {
        if (y >= trunkTopY - 1 && y <= trunkTopY + 2) { if (dy > 0) return ID.leaves; }
      } else {
        if (y >= trunkTopY && y <= trunkTopY + 3) { if (dy > 0) return ID.leaves; }
      }
    }
    if (shouldSpawnCactus(x, z, biome)) {
      const cactusBaseY = height + 1;
      const cactusH = getCactusHeight(x, z);
      if (y >= cactusBaseY && y < cactusBaseY + cactusH) return ID.log;
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

// --- RENDER RIGS ---
function createSolidMat(scene, name, col) { const m = new BABYLON.StandardMaterial(name, scene); m.diffuseColor = new BABYLON.Color3(...col); return m; }
function initFpsRig(scene) {
  if (MESH.weaponRoot) return;
  const cam = scene.activeCamera; const root = new BABYLON.TransformNode("weaponRoot", scene); root.parent = cam;
  const armMat = createSolidMat(scene, "armMat", [0.2, 0.8, 0.2]); const toolMat = createSolidMat(scene, "toolMat", [0.8, 0.8, 0.8]);
  const armR = BABYLON.MeshBuilder.CreateBox("armR", { width: 0.3, height: 0.8, depth: 0.3 }, scene);
  armR.material = armMat; armR.parent = root; armR.position.set(0.5, -0.5, 1); armR.rotation.set(0.5, 0, 0);
  const tool = BABYLON.MeshBuilder.CreateBox("tool", { width: 0.1, height: 0.1, depth: 0.6 }, scene);
  tool.material = toolMat; tool.parent = armR; tool.position.set(0, 0.5, 0.2);
  [armR, tool].forEach((m) => { noa.rendering.addMeshToScene(m, false); m.isPickable = false; });
  MESH.weaponRoot = root; MESH.armR = armR; MESH.tool = tool;
}
function createAvatar(scene) {
  const root = new BABYLON.TransformNode("avRoot", scene);
  const skin = createSolidMat(scene, "skin", [1, 0.8, 0.6]); const shirt = createSolidMat(scene, "shirt", [0.2, 0.4, 0.9]);
  const head = BABYLON.MeshBuilder.CreateBox("head", { size: 0.5 }, scene); head.material = skin; head.parent = root; head.position.y = 1.6;
  const body = BABYLON.MeshBuilder.CreateBox("body", { width: 0.5, height: 0.8, depth: 0.25 }, scene); body.material = shirt; body.parent = root; body.position.y = 0.9;
  [head, body].forEach((m) => { noa.rendering.addMeshToScene(m, false); m.isPickable = false; });
  return { root, head, body };
}
function createSlimeMesh(scene) {
    const root = new BABYLON.TransformNode("mob_root", scene);
    const mat = new BABYLON.StandardMaterial("slime_mat", scene); mat.diffuseColor = new BABYLON.Color3(0.2, 0.8, 0.2); mat.alpha = 0.8;
    const box = BABYLON.MeshBuilder.CreateBox("slime_body", { size: 0.8 }, scene); box.material = mat; box.parent = root; box.position.y = 0.4;
    const eyeMat = new BABYLON.StandardMaterial("eye_mat", scene); eyeMat.diffuseColor = BABYLON.Color3.Black();
    const eyeL = BABYLON.MeshBuilder.CreateBox("eyeL", { width:0.1, height:0.1, depth:0.1}, scene); eyeL.material = eyeMat; eyeL.parent = box; eyeL.position.set(-0.2, 0.2, 0.4);
    const eyeR = eyeL.clone("eyeR"); eyeR.parent = box; eyeR.position.set(0.2, 0.2, 0.4);
    return root;
}
function updateRigAnim(dt) {
  if (viewMode === 0 && MESH.weaponRoot) {
    const vel = noa.entities.getPhysicsBody(noa.playerEntity).velocity;
    const moving = Math.abs(vel[0]) > 0.1 || Math.abs(vel[2]) > 0.1;
    if (moving) STATE.bobPhase += dt * 10;
    MESH.weaponRoot.position.y = Math.sin(STATE.bobPhase) * 0.02; MESH.weaponRoot.position.x = Math.cos(STATE.bobPhase) * 0.02;
  }
  STATE.swingT += dt;
  if (STATE.swingT < STATE.swingDuration) {
    const prog = STATE.swingT / STATE.swingDuration; const ang = Math.sin(prog * Math.PI) * 1.5;
    if (MESH.armR) MESH.armR.rotation.x = 0.5 + ang;
  } else { if (MESH.armR) MESH.armR.rotation.x = 0.5; }
}

// --- NETWORKING ---
function resolveItem(uid, playersMap) {
    if (!uid || !playersMap) return null;
    const me = playersMap.get(mySessionId);
    if (!me || !me.items) return null;
    const it = me.items.get(uid);
    return it ? { kind: it.kind, qty: it.qty, durability: it.durability, maxDurability: it.maxDurability } : null;
}
function snapshotState(me, playersMap) {
  if (!me) return;
  LOCAL_STATE.hp = me.hp; LOCAL_STATE.stamina = me.stamina; LOCAL_STATE.hotbarIndex = me.hotbarIndex;
  LOCAL_STATE.inventory = me.inventory.slots.map(uid => resolveItem(uid, playersMap));
  LOCAL_STATE.craft = me.craft.slots.map(uid => resolveItem(uid, playersMap));
  LOCAL_STATE.craftResult = { kind: me.craft.resultKind, qty: me.craft.resultQty };
  LOCAL_STATE.cursor = { kind: me.cursor.kind, qty: me.cursor.qty };
  inventoryUI.refresh(); hotbarUI.refresh();
}
function forcePlayerPosition(x, y, z, reason = "") {
  try {
    noa.entities.setPosition(noa.playerEntity, x, y, z);
    const body = noa.entities.getPhysicsBody(noa.playerEntity);
    if(body) { body.velocity[0] = 0; body.velocity[1] = 0; body.velocity[2] = 0; }
    if (reason) uiLog(`snap -> (${x.toFixed(1)},${y.toFixed(1)},${z.toFixed(1)}) ${reason}`);
  } catch {}
}

const ENDPOINT = window.location.hostname.includes("localhost") ? "ws://localhost:2567" : "https://us-mia-ea26ba04.colyseus.cloud";
const client = new Colyseus.Client(ENDPOINT);
function getDistinctId() {
  const key = "fresh2_player_id"; let id = localStorage.getItem(key);
  if (!id) { id = "user_" + Math.random().toString(36).substr(2, 9); localStorage.setItem(key, id); }
  return id;
}

client.joinOrCreate("my_room", { name: "Steve", distinctId: getDistinctId() }).then((room) => {
    colyRoom = room; mySessionId = room.sessionId; uiLog("Connected to Server!");

    room.onMessage("welcome", (msg) => {
      uiLog(`Welcome: ${msg?.roomId || ""} (${msg?.sessionId || ""})`);
      chatUI.add("Welcome! Press [ENTER] to chat or use commands.", "#88ff88");
      // Initial patch request
      room.send("world:patch:req", { r: 48 });
    });

    room.onMessage("block:reject", (msg) => {
      UI_CONSOLE.warn(`block:reject (${msg?.reason || "reject"}) - Resyncing...`);
      room.send("world:patch:req", { r: 8 }); 
    });

    room.onMessage("chat:sys", (msg) => { if (msg?.text) chatUI.add(msg.text, "#88ffff"); });

    room.onMessage("spawn:teleport", (msg) => {
      const x = Number(msg?.x); const y = Number(msg?.y); const z = Number(msg?.z);
      if (!Number.isFinite(x)) return;
      STATE.desiredSpawn = { x, y, z };
      forcePlayerPosition(x, y, z, "(spawn:teleport)");
      STATE.spawnSnapDone = true;
      const ls = document.getElementById("loading-screen"); if (ls) ls.style.display = "none";
    });

    room.onStateChange((state) => {
        const me = state.players.get(room.sessionId);
        if (me) snapshotState(me, state.players);
        state.players.forEach((p, sid) => {
            if (sid === room.sessionId) return;
            if (!remotePlayers[sid]) {
                const rig = createAvatar(noa.rendering.getScene());
                remotePlayers[sid] = { mesh: rig.root, targetPos: [p.x, p.y, p.z] };
            }
            remotePlayers[sid].targetPos = [p.x, p.y, p.z];
            if(remotePlayers[sid].mesh) remotePlayers[sid].mesh.rotation.y = p.yaw;
        });
    });

    room.state.mobs.onAdd = (mob, key) => {
        const mesh = createSlimeMesh(noa.rendering.getScene());
        mesh.position.set(mob.x, mob.y, mob.z);
        mobs[key] = { mesh, targetPos: [mob.x, mob.y, mob.z], targetYaw: mob.yaw };
        mob.onChange = () => { if (mobs[key]) { mobs[key].targetPos = [mob.x, mob.y, mob.z]; mobs[key].targetYaw = mob.yaw; } };
    };
    room.state.mobs.onRemove = (mob, key) => { if (mobs[key]) { mobs[key].mesh.dispose(); delete mobs[key]; } };

    // FIX: PATCH HANDLER
    room.onMessage("world:patch", (patch) => {
      const arr = patch?.data;
      if (arr && Array.isArray(arr)) {
         let count = 0;
         for (let i = 0; i < arr.length; i += 4) {
            const x = arr[i];
            const y = arr[i+1];
            const z = arr[i+2];
            const id = arr[i+3];
            
            // 1. Update Persistent Map (for terrain gen)
            CLIENT_EDITS.set(getEditKey(x, y, z), id);
            
            // 2. Update Visuals (for already loaded chunks)
            noa.setBlock(id, x, y, z);
            count++;
         }
         
         if (!STATE.worldReady) { 
             STATE.worldReady = true; 
             // LOG TO UI TO CONFIRM RECEIPT
             uiLog(`worldReady=true (loaded ${count} blocks)`); 
         }
      } 
    });

    room.onMessage("block:update", (msg) => {
      CLIENT_EDITS.set(getEditKey(msg.x, msg.y, msg.z), msg.id);
      noa.setBlock(msg.id, msg.x, msg.y, msg.z);
    });

}).catch((e) => uiLog(`Connect Error: ${e}`, "red"));

// --- INPUTS ---
function setView(mode) {
  viewMode = mode; noa.camera.zoomDistance = mode === 1 ? 6 : 0;
  if (MESH.weaponRoot) MESH.weaponRoot.setEnabled(mode === 0);
  if (MESH.avatarRoot) MESH.avatarRoot.setEnabled(mode === 1);
}

noa.inputs.down.on("fire", () => {
  if (inventoryOpen || chatOpen) return;
  STATE.swingT = 0; if (colyRoom) colyRoom.send("swing");
  if (noa.targetedBlock) {
    const p = noa.targetedBlock.position;
    if (colyRoom) colyRoom.send("block:break", { x: p[0], y: p[1], z: p[2], src: "client" });
    CLIENT_EDITS.set(getEditKey(p[0], p[1], p[2]), 0);
    noa.setBlock(0, p[0], p[1], p[2]); 
  }
});

noa.inputs.down.on("alt-fire", () => {
  if (inventoryOpen || chatOpen || !noa.targetedBlock) return;
  const p = noa.targetedBlock.adjacent;
  const idx = LOCAL_STATE.hotbarIndex;
  const item = LOCAL_STATE.inventory[idx];
  if (item && item.kind.startsWith("block:")) {
      let id = ID.dirt;
      const k = item.kind;
      if (k.includes("stone")) id = ID.stone;
      if (k.includes("plank")) id = ID.planks;
      if (k.includes("log")) id = ID.log;
      if (k.includes("chest")) id = ID.chest;
      if (k.includes("crafting")) id = ID.crafting_table;
      
      if (colyRoom) colyRoom.send("block:place", { x: p[0], y: p[1], z: p[2], kind: item.kind });
      CLIENT_EDITS.set(getEditKey(p[0], p[1], p[2]), id);
      noa.setBlock(id, p[0], p[1], p[2]); 
  }
});

window.addEventListener("keydown", (e) => {
  if (e.code === "Enter") {
    e.preventDefault();
    if (chatOpen) {
      const text = chatUI.input.value.trim();
      if (text && colyRoom) { chatUI.add(`> ${text}`, "#ccc"); colyRoom.send("chat", { text }); }
      chatUI.toggle();
    } else { chatUI.toggle(); }
    return;
  }
  if (chatOpen) return;
  if (e.code === "KeyI" || e.code === "Tab") { e.preventDefault(); inventoryUI.toggle(); }
  if (e.code === "F4") { e.preventDefault(); UI_CONSOLE.toggle(); }
  if (e.code === "KeyV") setView(viewMode === 0 ? 1 : 0);
  if (!inventoryOpen && e.key >= "1" && e.key <= "9") {
    const idx = parseInt(e.key) - 1;
    if (colyRoom) colyRoom.send("hotbar:set", { index: idx });
    LOCAL_STATE.hotbarIndex = idx; hotbarUI.refresh();
  }
  if (e.code === "ShiftLeft") if(colyRoom) colyRoom.send("sprint", { on: true });
  
  if (e.code === "F6") {
    try { if (colyRoom) colyRoom.send("world:patch:req", { r: 160 }); uiLog("Requested town patch (F6)"); } catch {}
  }
  
  // FIX: F7 Force Reload
  if (e.code === "F7") {
      uiLog("Forcing full town reload...");
      if(colyRoom) colyRoom.send("world:patch:req", { r: 64, limit: 100000 });
  }

  if (e.code === "F8") { STATE.logPos = !STATE.logPos; uiLog(`pos logging: ${STATE.logPos ? "ON" : "OFF"} (F8)`); }
  if (e.code === "F9") {
    forcePlayerPosition(TOWN.cx + 0.5, TOWN.groundY + 3, TOWN.cz + 0.5, "(F9 manual snap)");
    if (colyRoom) {
      try { const cam = noa.camera; colyRoom.send("move", { x: TOWN.cx + 0.5, y: TOWN.groundY + 3, z: TOWN.cz + 0.5, yaw: cam.heading, pitch: cam.pitch }); } catch {}
    }
  }
});
window.addEventListener("keyup", (e) => { if (e.code === "ShiftLeft") if(colyRoom) colyRoom.send("sprint", { on: false }); });

noa.on("beforeRender", () => {
  if (!STATE.scene) {
    const scene = noa.rendering.getScene();
    if (scene) { STATE.scene = scene; initFpsRig(STATE.scene); applyRenderPreset(STATE.scene, RENDER_PRESET_OUTSIDE); } else return;
  }
  const now = performance.now(); const dt = (now - STATE.lastTime) / 1000; STATE.lastTime = now;
  if (dt > 0.1) return;

  const shouldFreeze = !STATE.spawnSnapDone || now < STATE.freezeUntil;
  if (shouldFreeze) { const s = STATE.desiredSpawn; forcePlayerPosition(s.x, s.y + 0.5, s.z, ""); }

  updateRigAnim(dt);
  try {
    const p = noa.entities.getPosition(noa.playerEntity); const px = p[0], pz = p[2];
    const inside = isInsideTown(px, pz, inTown);
    if (inside !== inTown) {
      if (now - lastTownToggleAt > 350) {
        inTown = inside; lastTownToggleAt = now; applyRenderPreset(STATE.scene, inTown ? RENDER_PRESET_TOWN : RENDER_PRESET_OUTSIDE);
        uiLog(inTown ? "Entered Town render clamp" : "Exited Town render clamp");
      }
    }
  } catch {}
  if (STATE.logPos && now - STATE.lastPosLogAt > 800) {
      STATE.lastPosLogAt = now;
      try { const p = noa.entities.getPosition(noa.playerEntity); uiLog(`pos=(${p[0].toFixed(1)}, ${p[1].toFixed(1)}, ${p[2].toFixed(1)})`); } catch {}
  }
  for (const sid in remotePlayers) {
    const rp = remotePlayers[sid];
    if (rp && rp.mesh) {
      const cur = rp.mesh.position; const tgt = rp.targetPos;
      cur.x += (tgt[0] - cur.x) * 0.1; cur.y += (tgt[1] - cur.y) * 0.1; cur.z += (tgt[2] - cur.z) * 0.1;
    }
  }
  for (const mid in mobs) {
    const m = mobs[mid];
    if (m && m.mesh) {
      m.mesh.position.x += (m.targetPos[0] - m.mesh.position.x) * 0.1;
      m.mesh.position.y += (m.targetPos[1] - m.mesh.position.y) * 0.1;
      m.mesh.position.z += (m.targetPos[2] - m.mesh.position.z) * 0.1;
      m.mesh.rotation.y += (m.targetYaw - m.mesh.rotation.y) * 0.1;
      const isMoving = Math.abs(m.targetPos[0] - m.mesh.position.x) > 0.01;
      if (isMoving) { const s = 1 + Math.sin(now * 0.01) * 0.1; m.mesh.scaling.y = s; m.mesh.scaling.x = 1/s; m.mesh.scaling.z = 1/s; } else { m.mesh.scaling.set(1, 1, 1); }
    }
  }
  STATE.moveAccum += dt;
  if (colyRoom && !inventoryOpen && !chatOpen && !shouldFreeze && STATE.moveAccum > 0.05) {
    STATE.moveAccum = 0;
    const p = noa.entities.getPosition(noa.playerEntity); const cam = noa.camera;
    colyRoom.send("move", { x: p[0], y: p[1], z: p[2], yaw: cam.heading, pitch: cam.pitch });
  }
});

// Initial
noa.entities.setPosition(noa.playerEntity, 0, TOWN.groundY + 5, 0);