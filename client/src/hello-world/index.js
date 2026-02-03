/*
 * Fresh2 - noa hello-world (main game entry)
 *
 * Features:
 *  - Crosshair overlay + pointer lock on #noa-container
 *  - Colyseus joinOrCreate
 *  - MCHeads skins (CORS)
 *  - Minecraft-style avatar (3rd person) + Minecraft-style FP arms
 *  - F5 toggles view modes: first / third-back / third-front
 *  - F6 forces crosshair
 *  - F7 flips FP arms Z
 *  - F8 toggles debug cube (should ALWAYS render if overlays are working)
 *
 * Key fixes:
 *  - Avatar root is TransformNode (NOT Mesh) so parent visibility never hides children
 *  - Explicitly force noa mesh component "visible" when in 3rd person
 *  - FP arms use renderingGroupId + infiniteDistance + disableDepthWrite
 */

import { Engine } from "noa-engine";
import { Client } from "@colyseus/sdk";

import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Vector4 } from "@babylonjs/core/Maths/math.vector";
import { Color3 } from "@babylonjs/core/Maths/math.color";

/* ============================================================
 * Engine
 * ============================================================
 */

const opts = {
  debug: true,
  showFPS: true,
  chunkSize: 32,
  chunkAddDistance: 2.5,
  chunkRemoveDistance: 3.5,
};

const noa = new Engine(opts);
const noaAny = /** @type {any} */ (noa);

/* ============================================================
 * State
 * ============================================================
 */

let viewMode = 0; // 0 first, 1 third-back, 2 third-front
let forceCrosshair = false;

let applyViewModeGlobal = null;

let fpArmsRef = null;
let localAvatar = null;
let localAvatarMeshes = [];

let debugCube = null;
let debugCubeOn = false;

/* ============================================================
 * Helpers
 * ============================================================
 */

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

function safeNum(v, fallback = 0) {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** @returns {HTMLElement|null} */
function getPointerLockTarget() {
  const c = /** @type {any} */ (noa).container;

  // Runtime: noa.container is DOM element
  if (c && typeof c === "object" && "addEventListener" in c && "requestPointerLock" in c) {
    return /** @type {HTMLElement} */ (/** @type {any} */ (c));
  }

  const div = document.getElementById("noa-container");
  if (div) return div;

  const canvas = document.querySelector("canvas");
  return canvas ? /** @type {HTMLElement} */ (/** @type {any} */ (canvas)) : null;
}

function isPointerLockedToNoa() {
  const target = getPointerLockTarget();
  return !!(target && document.pointerLockElement === target);
}

/* ============================================================
 * Debug HUD
 * ============================================================
 */

function createDebugHUD() {
  const el = document.createElement("div");
  el.id = "noa-debug-hud";
  Object.assign(el.style, {
    position: "fixed",
    top: "10px",
    left: "10px",
    zIndex: "1000000",
    padding: "8px 10px",
    background: "rgba(0,0,0,0.65)",
    color: "#fff",
    fontFamily: "monospace",
    fontSize: "12px",
    lineHeight: "1.35",
    borderRadius: "6px",
    pointerEvents: "none",
    whiteSpace: "pre",
    maxWidth: "70vw",
  });
  document.body.appendChild(el);

  const state = {
    viewMode: 0,
    locked: false,
    crosshair: false,
    camName: "(none)",
    camClass: "(none)",
    avatarEnabled: false,
    avatarChildMeshes: 0,
    noaMeshVisible: "(unknown)",
    armsEnabled: false,
    debugCube: false,
    last: "(boot)",
    err: "(none)",
  };

  function render() {
    el.textContent =
      `Fresh2 Debug\n` +
      `viewMode: ${state.viewMode} (${state.viewMode === 0 ? "first" : state.viewMode === 1 ? "third-back" : "third-front"})\n` +
      `locked: ${state.locked}\n` +
      `crosshair: ${state.crosshair} (F6 force=${forceCrosshair})\n` +
      `camera: ${state.camName} (${state.camClass})\n` +
      `avatar: enabled=${state.avatarEnabled} childMeshes=${state.avatarChildMeshes}\n` +
      `noa mesh.visible: ${state.noaMeshVisible}\n` +
      `armsEnabled: ${state.armsEnabled}\n` +
      `debugCube(F8): ${state.debugCube}\n` +
      `last: ${state.last}\n` +
      `err: ${state.err}\n` +
      `\nKeys: F5 view | F6 crosshair | F7 flip arms Z | F8 cube\n`;
  }

  return { el, state, render };
}

const debugHUD = createDebugHUD();

/* ============================================================
 * Crosshair
 * ============================================================
 */

function createCrosshairOverlay() {
  const crosshair = document.createElement("div");
  crosshair.id = "noa-crosshair";
  Object.assign(crosshair.style, {
    position: "fixed",
    top: "50%",
    left: "50%",
    width: "22px",
    height: "22px",
    transform: "translate(-50%, -50%)",
    pointerEvents: "none",
    zIndex: "999999",
    display: "none",
    alignItems: "center",
    justifyContent: "center",
  });

  const style = {
    position: "absolute",
    backgroundColor: "rgba(255,255,255,0.95)",
    boxShadow: "0px 0px 3px rgba(0,0,0,0.95)",
  };

  const h = document.createElement("div");
  Object.assign(h.style, style, { width: "100%", height: "3px", top: "9px", left: "0px" });

  const v = document.createElement("div");
  Object.assign(v.style, style, { width: "3px", height: "100%", left: "9px", top: "0px" });

  crosshair.appendChild(h);
  crosshair.appendChild(v);
  document.body.appendChild(crosshair);

  function refresh() {
    const locked = isPointerLockedToNoa();
    const show = forceCrosshair || (locked && viewMode === 0);
    crosshair.style.display = show ? "flex" : "none";
    debugHUD.state.crosshair = show;
    debugHUD.state.locked = locked;
    debugHUD.state.last = "crosshair.refresh";
    debugHUD.render();
  }

  document.addEventListener("pointerlockchange", refresh);

  const i = setInterval(() => {
    refresh();
    if (getPointerLockTarget()) clearInterval(i);
  }, 250);

  return { refresh };
}

const crosshairUI = createCrosshairOverlay();

/* ============================================================
 * Pointer lock click handler
 * ============================================================
 */

(function enableClickToPointerLock() {
  const interval = setInterval(() => {
    const target = getPointerLockTarget();
    if (!target) return;

    clearInterval(interval);

    if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "1");
    target.style.outline = "none";

    target.addEventListener("click", () => {
      try {
        if (viewMode !== 0) return;
        if (document.pointerLockElement !== target) target.requestPointerLock();
      } catch (e) {
        debugHUD.state.err = String(e?.message || e);
        debugHUD.state.last = "pointerlock failed";
        debugHUD.render();
      }
    });

    console.log("[PointerLock] click handler attached to lock target:", target);
  }, 100);
})();

/* ============================================================
 * Keybinds
 * ============================================================
 */

document.addEventListener("keydown", (e) => {
  if (e.code === "F5") {
    e.preventDefault();
    viewMode = (viewMode + 1) % 3;

    if (viewMode !== 0) {
      try { document.exitPointerLock?.(); } catch {}
    }

    try { if (typeof applyViewModeGlobal === "function") applyViewModeGlobal(); } catch {}
    crosshairUI.refresh();
  }

  if (e.code === "F6") {
    e.preventDefault();
    forceCrosshair = !forceCrosshair;
    crosshairUI.refresh();
  }

  if (e.code === "F7") {
    e.preventDefault();
    if (fpArmsRef?.root) {
      fpArmsRef.root.position.z *= -1;
      if (typeof applyViewModeGlobal === "function") applyViewModeGlobal();
      console.log("[Debug] flipped FP arms Z:", fpArmsRef.root.position.z);
    }
  }

  if (e.code === "F8") {
    e.preventDefault();
    debugCubeOn = !debugCubeOn;
    if (debugCube) debugCube.setEnabled(debugCubeOn);
    debugHUD.state.debugCube = debugCubeOn;
    debugHUD.state.last = "F8 debug cube toggle";
    debugHUD.render();
  }
});

/* ============================================================
 * Colyseus
 * ============================================================
 */

const DEFAULT_LOCAL_ENDPOINT = "ws://localhost:2567";
let COLYSEUS_ENDPOINT =
  import.meta.env && import.meta.env.VITE_COLYSEUS_ENDPOINT
    ? import.meta.env.VITE_COLYSEUS_ENDPOINT
    : DEFAULT_LOCAL_ENDPOINT;

function toHttpEndpoint(wsEndpoint) {
  if (wsEndpoint.startsWith("wss://")) return wsEndpoint.replace("wss://", "https://");
  if (wsEndpoint.startsWith("ws://")) return wsEndpoint.replace("ws://", "http://");
  return wsEndpoint;
}

async function debugMatchmake(endpointWsOrHttp) {
  const http = toHttpEndpoint(endpointWsOrHttp);

  console.log("[Colyseus][debug] ws endpoint:", endpointWsOrHttp);
  console.log("[Colyseus][debug] http endpoint:", http);

  try {
    const r1 = await fetch(`${http}/hi`, { method: "GET" });
    const t1 = await r1.text();
    console.log("[Colyseus][debug] GET /hi status:", r1.status);
    console.log("[Colyseus][debug] GET /hi body:", t1.slice(0, 200));
  } catch (e) {
    console.error("[Colyseus][debug] GET /hi failed:", e);
  }

  try {
    const r2 = await fetch(`${http}/matchmake/joinOrCreate/my_room`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const t2 = await r2.text();
    console.log("[Colyseus][debug] POST joinOrCreate status:", r2.status);
    console.log("[Colyseus][debug] raw body:", t2.slice(0, 400));
  } catch (e) {
    console.error("[Colyseus][debug] matchmake POST failed:", e);
  }
}

const colyseusClient = new Client(COLYSEUS_ENDPOINT);
noaAny.colyseus = { endpoint: COLYSEUS_ENDPOINT, client: colyseusClient, room: null };

/* ============================================================
 * Skins (MCHeads)
 * ============================================================
 */

function getMcHeadsSkinUrl(identifier) {
  return `https://mc-heads.net/skin/${encodeURIComponent(identifier)}.png`;
}

/* ============================================================
 * UV helpers
 * ============================================================
 */

function uvRect(px, py, pw, ph) {
  const texW = 64;
  const texH = 64;
  return new Vector4(px / texW, py / texH, (px + pw) / texW, (py + ph) / texH);
}

// Babylon box face order: [0]=front, [1]=back, [2]=right, [3]=left, [4]=top, [5]=bottom
function makeFaceUV(front, back, right, left, top, bottom) {
  return [front, back, right, left, top, bottom];
}

function createSkinMaterial(scene, skinUrl, name) {
  const tex = new Texture(skinUrl, scene, false, false, Texture.NEAREST_NEAREST);
  tex.hasAlpha = true;

  const mat = new StandardMaterial(name, scene);
  mat.diffuseTexture = tex;
  mat.emissiveColor = new Color3(0.05, 0.05, 0.05);
  mat.specularColor = new Color3(0, 0, 0);
  mat.backFaceCulling = false;

  if (tex.onLoadObservable && typeof tex.onLoadObservable.add === "function") {
    tex.onLoadObservable.add(() => console.log("[Skin] loaded:", skinUrl));
  }
  return mat;
}

/* ============================================================
 * Avatar (3rd person) - TransformNode root
 * ============================================================
 */

function createPlayerAvatar(scene, skinUrl) {
  const root = new TransformNode("mc-avatar-root", scene);

  const mat = createSkinMaterial(scene, skinUrl, "mc-skin-mat");

  const headUV = makeFaceUV(
    uvRect(8, 8, 8, 8),
    uvRect(24, 8, 8, 8),
    uvRect(16, 8, 8, 8),
    uvRect(0, 8, 8, 8),
    uvRect(8, 0, 8, 8),
    uvRect(16, 0, 8, 8)
  );

  const bodyUV = makeFaceUV(
    uvRect(20, 20, 8, 12),
    uvRect(32, 20, 8, 12),
    uvRect(28, 20, 4, 12),
    uvRect(16, 20, 4, 12),
    uvRect(20, 16, 8, 4),
    uvRect(28, 16, 8, 4)
  );

  const armUV = makeFaceUV(
    uvRect(44, 20, 4, 12),
    uvRect(52, 20, 4, 12),
    uvRect(48, 20, 4, 12),
    uvRect(40, 20, 4, 12),
    uvRect(44, 16, 4, 4),
    uvRect(48, 16, 4, 4)
  );

  const legUV = makeFaceUV(
    uvRect(4, 20, 4, 12),
    uvRect(12, 20, 4, 12),
    uvRect(8, 20, 4, 12),
    uvRect(0, 20, 4, 12),
    uvRect(4, 16, 4, 4),
    uvRect(8, 16, 4, 4)
  );

  const headSize = { width: 1.0, height: 1.0, depth: 1.0 };
  const bodySize = { width: 1.0, height: 1.5, depth: 0.5 };
  const limbSize = { width: 0.5, height: 1.5, depth: 0.5 };

  const head = MeshBuilder.CreateBox("mc-head", { width: headSize.width, height: headSize.height, depth: headSize.depth, faceUV: headUV }, scene);
  head.material = mat;
  head.parent = root;

  const body = MeshBuilder.CreateBox("mc-body", { width: bodySize.width, height: bodySize.height, depth: bodySize.depth, faceUV: bodyUV }, scene);
  body.material = mat;
  body.parent = root;

  const rightArm = MeshBuilder.CreateBox("mc-rightArm", { width: limbSize.width, height: limbSize.height, depth: limbSize.depth, faceUV: armUV }, scene);
  rightArm.material = mat;
  rightArm.parent = root;

  const leftArm = MeshBuilder.CreateBox("mc-leftArm", { width: limbSize.width, height: limbSize.height, depth: limbSize.depth, faceUV: armUV }, scene);
  leftArm.material = mat;
  leftArm.parent = root;

  const rightLeg = MeshBuilder.CreateBox("mc-rightLeg", { width: limbSize.width, height: limbSize.height, depth: limbSize.depth, faceUV: legUV }, scene);
  rightLeg.material = mat;
  rightLeg.parent = root;

  const leftLeg = MeshBuilder.CreateBox("mc-leftLeg", { width: limbSize.width, height: limbSize.height, depth: limbSize.depth, faceUV: legUV }, scene);
  leftLeg.material = mat;
  leftLeg.parent = root;

  const legY = limbSize.height / 2;
  rightLeg.position.set(-0.25, legY, 0);
  leftLeg.position.set(0.25, legY, 0);

  const bodyY = limbSize.height + bodySize.height / 2;
  body.position.set(0, bodyY, 0);

  const headY = limbSize.height + bodySize.height + headSize.height / 2;
  head.position.set(0, headY, 0);

  const armY = limbSize.height + bodySize.height - limbSize.height / 2;
  rightArm.position.set(-(bodySize.width / 2 + limbSize.width / 2), armY, 0);
  leftArm.position.set(bodySize.width / 2 + limbSize.width / 2, armY, 0);

  const meshes = [head, body, rightArm, leftArm, rightLeg, leftLeg];
  for (const m of meshes) {
    m.alwaysSelectAsActiveMesh = true;
    m.isPickable = false;
  }

  return { root, meshes };
}

/* ============================================================
 * FP arms (renderingGroupId + infiniteDistance)
 * ============================================================
 */

function createFirstPersonArms(scene, skinUrl) {
  const cam = scene.activeCamera;
  if (!cam) return null;

  const root = new TransformNode("fp-arms-root", scene);
  root.parent = cam;

  // Local position relative to camera
  root.position.set(0.38, -0.42, 1.1);

  const mat = createSkinMaterial(scene, skinUrl, "fp-skin-mat");
  mat.disableDepthWrite = true;   // draw on top-ish
  mat.backFaceCulling = false;

  const armUV = makeFaceUV(
    uvRect(44, 20, 4, 12),
    uvRect(52, 20, 4, 12),
    uvRect(48, 20, 4, 12),
    uvRect(40, 20, 4, 12),
    uvRect(44, 16, 4, 4),
    uvRect(48, 16, 4, 4)
  );

  const armSize = { width: 0.42, height: 1.05, depth: 0.42 };

  const rightArm = MeshBuilder.CreateBox("fp-rightArm", { width: armSize.width, height: armSize.height, depth: armSize.depth, faceUV: armUV }, scene);
  rightArm.material = mat;
  rightArm.parent = root;

  const leftArm = MeshBuilder.CreateBox("fp-leftArm", { width: armSize.width, height: armSize.height, depth: armSize.depth, faceUV: armUV }, scene);
  leftArm.material = mat;
  leftArm.parent = root;

  // Force render group + infinite distance (no culling weirdness)
  for (const m of [rightArm, leftArm]) {
    m.renderingGroupId = 2;
    m.infiniteDistance = true;
    m.alwaysSelectAsActiveMesh = true;
    m.isPickable = false;
  }

  rightArm.position.set(0.32, -0.15, 0.0);
  leftArm.position.set(-0.22, -0.22, -0.05);

  rightArm.rotation.set(0.15, 0.2, 0.15);
  leftArm.rotation.set(0.05, -0.25, -0.05);

  const anim = { active: false, t: 0, duration: 0.18 };
  const base = {
    rx: rightArm.rotation.x, ry: rightArm.rotation.y, rz: rightArm.rotation.z,
    lx: leftArm.rotation.x, ly: leftArm.rotation.y, lz: leftArm.rotation.z,
  };

  function startSwing() { anim.active = true; anim.t = 0; }

  function easeInOutQuad(x) {
    return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
  }

  function update(dt) {
    if (!anim.active) return;
    anim.t += dt;
    const p = clamp(anim.t / anim.duration, 0, 1);
    const e = easeInOutQuad(p);
    const swing = Math.sin(e * Math.PI);

    rightArm.rotation.x = base.rx + swing * 0.9;
    rightArm.rotation.y = base.ry + swing * 0.25;
    rightArm.rotation.z = base.rz - swing * 0.15;

    leftArm.rotation.x = base.lx + swing * 0.25;
    leftArm.rotation.y = base.ly - swing * 0.15;
    leftArm.rotation.z = base.lz + swing * 0.05;

    if (p >= 1) {
      anim.active = false;
      rightArm.rotation.set(base.rx, base.ry, base.rz);
      leftArm.rotation.set(base.lx, base.ly, base.lz);
    }
  }

  function setEnabled(enabled) {
    root.setEnabled(enabled);
  }

  console.log("[FPArms] created. parent camera:", cam.name || "(unnamed)");
  return { root, setEnabled, startSwing, update };
}

/* ============================================================
 * Debug cube (camera-parented, renderingGroupId=2)
 * ============================================================
 */

function ensureDebugCube(scene) {
  if (debugCube) return;

  const cam = scene.activeCamera;
  const cube = MeshBuilder.CreateBox("debugCube", { size: 0.7 }, scene);
  const mat = new StandardMaterial("debugCubeMat", scene);
  mat.diffuseColor = new Color3(1, 0, 1);
  mat.emissiveColor = new Color3(0.2, 0, 0.2);
  mat.backFaceCulling = false;

  cube.material = mat;
  cube.renderingGroupId = 2;
  cube.infiniteDistance = true;
  cube.alwaysSelectAsActiveMesh = true;
  cube.isPickable = false;

  if (cam) {
    cube.parent = cam;
    cube.position.set(0, 0, 2.0);
  }

  cube.setEnabled(false);
  debugCube = cube;
}

/* ============================================================
 * Register blocks
 * ============================================================
 */

const brownish = [0.45, 0.36, 0.22];
const greenish = [0.1, 0.8, 0.2];

noa.registry.registerMaterial("dirt", { color: brownish });
noa.registry.registerMaterial("grass", { color: greenish });

const dirtID = noa.registry.registerBlock(1, { material: "dirt" });
const grassID = noa.registry.registerBlock(2, { material: "grass" });

/* ============================================================
 * World gen
 * ============================================================
 */

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
        data.set(i, j, k, getVoxelID(x + i, y + j, z + k));
      }
    }
  }
  noa.world.setChunkData(id, data);
});

/* ============================================================
 * Init local avatar + override noa mesh visibility
 * ============================================================
 */

let localAvatarAttached = false;

function setNoaPlayerMeshVisible(visible) {
  try {
    const ents = /** @type {any} */ (noa.entities);
    const compName = noa.entities.names.mesh;
    const ent = noa.playerEntity;

    if (ents && typeof ents.getComponent === "function") {
      const meshComp = ents.getComponent(ent, compName);
      if (meshComp) {
        meshComp.visible = visible; // noa internal flag
        debugHUD.state.noaMeshVisible = String(meshComp.visible);
      }
    }
  } catch (e) {
    debugHUD.state.noaMeshVisible = "(error)";
  }
}

function initLocalAvatarOnce(scene, playerIdentifier) {
  if (localAvatarAttached) return;

  const entities = /** @type {any} */ (noa.entities);
  const playerEntity = noa.playerEntity;

  const skinUrl = getMcHeadsSkinUrl(playerIdentifier);
  console.log("[Skin] Using MCHeads skin URL:", skinUrl);

  const avatar = createPlayerAvatar(scene, skinUrl);
  localAvatar = avatar;
  localAvatarMeshes = avatar.meshes;

  fpArmsRef = createFirstPersonArms(scene, skinUrl);

  ensureDebugCube(scene);

  const playerHeight = typeof noaAny.playerHeight === "number" ? noaAny.playerHeight : 1.8;
  const meshOffsetY = playerHeight * 0.5;

  try {
    // Attach avatar root to player via noa mesh component
    entities.addComponent(playerEntity, noa.entities.names.mesh, {
      mesh: avatar.root,
      offset: [0, meshOffsetY, 0],
    });
  } catch (e) {
    // If mesh component already exists, update it instead of crashing
    try {
      const comp = entities.getComponent(playerEntity, noa.entities.names.mesh);
      if (comp) {
        comp.mesh = avatar.root;
        comp.offset = [0, meshOffsetY, 0];
      }
    } catch {}
  }

  function applyViewMode() {
    const locked = isPointerLockedToNoa();
    const isFirst = viewMode === 0;

    // Set camera zoom for 3rd person
    if (viewMode === 0) noa.camera.zoomDistance = 0;
    if (viewMode === 1) noa.camera.zoomDistance = 6;
    if (viewMode === 2) noa.camera.zoomDistance = 6;

    // Force NOA mesh component visibility (NOA can hide local player)
    setNoaPlayerMeshVisible(!isFirst);

    // Also enable/disable the avatar root as a backup
    avatar.root.setEnabled(!isFirst);

    // Arms only when locked and first-person
    const armsEnabled = !!(fpArmsRef && isFirst && locked);
    if (fpArmsRef) fpArmsRef.setEnabled(armsEnabled);

    // Debug cube toggle
    if (debugCube) debugCube.setEnabled(debugCubeOn);

    // HUD camera info
    const cam = scene.activeCamera;
    debugHUD.state.camName = cam ? (cam.name || "(unnamed)") : "(none)";
    debugHUD.state.camClass = cam && cam.getClassName ? cam.getClassName() : "(none)";

    debugHUD.state.viewMode = viewMode;
    debugHUD.state.locked = locked;

    debugHUD.state.avatarEnabled = avatar.root.isEnabled();
    debugHUD.state.avatarChildMeshes = localAvatarMeshes.length;

    debugHUD.state.armsEnabled = armsEnabled;
    debugHUD.state.debugCube = debugCubeOn;

    debugHUD.state.last = "applyViewMode";
    debugHUD.render();

    console.log("[applyViewMode]", { viewMode, locked, isFirst, avatarEnabled: avatar.root.isEnabled(), armsEnabled, debugCubeOn });
  }

  applyViewModeGlobal = applyViewMode;

  applyViewMode();
  document.addEventListener("pointerlockchange", applyViewMode);

  localAvatarAttached = true;
}

/* ============================================================
 * Remote players (kept minimal)
 * ============================================================
 */

function createRemotePlayersManager(scene, room) {
  const remotes = new Map();

  function spawnRemote(sessionId, playerState) {
    const name = playerState?.name || "Steve";
    const skinUrl = getMcHeadsSkinUrl(name);
    const avatar = createPlayerAvatar(scene, skinUrl);
    avatar.root.setEnabled(true);

    const x = safeNum(playerState.x, 0);
    const y = safeNum(playerState.y, 10);
    const z = safeNum(playerState.z, 0);
    avatar.root.position.set(x, y, z);

    remotes.set(sessionId, { avatar, tx: x, ty: y, tz: z });
  }

  function removeRemote(sessionId) {
    const r = remotes.get(sessionId);
    if (!r) return;
    try { r.avatar.root.dispose(false, true); } catch {}
    remotes.delete(sessionId);
  }

  function updateRemote(sessionId, playerState) {
    const r = remotes.get(sessionId);
    if (!r) return;
    r.tx = safeNum(playerState.x, r.tx);
    r.ty = safeNum(playerState.y, r.ty);
    r.tz = safeNum(playerState.z, r.tz);
  }

  noa.on("tick", () => {
    const alpha = 0.2;
    remotes.forEach((r) => {
      const root = r.avatar.root;
      root.position.set(
        root.position.x + (r.tx - root.position.x) * alpha,
        root.position.y + (r.ty - root.position.y) * alpha,
        root.position.z + (r.tz - root.position.z) * alpha
      );
    });
  });

  (function waitForPlayersMap() {
    const start = performance.now();
    const interval = setInterval(() => {
      const players = room && room.state ? room.state.players : null;
      if (players) {
        clearInterval(interval);

        players.onAdd = (ps, sid) => {
          if (sid === room.sessionId) return;
          spawnRemote(sid, ps);
          try { ps.onChange = () => updateRemote(sid, ps); } catch {}
        };

        players.onRemove = (_ps, sid) => removeRemote(sid);

        console.log("[Remote] hooked room.state.players");
        return;
      }
      if (performance.now() - start > 5000) {
        clearInterval(interval);
        console.warn("[Remote] no room.state.players found");
      }
    }, 50);
  })();
}

/* ============================================================
 * Local transform sender
 * ============================================================
 */

function getLocalPlayerPositionFallback() {
  try {
    const ent = noa.playerEntity;
    const ents = /** @type {any} */ (noa.entities);
    if (ents && typeof ents.getPosition === "function") {
      const p = ents.getPosition(ent);
      if (p && p.length >= 3) return [p[0], p[1], p[2]];
    }
  } catch {}
  return [0, 10, 0];
}

function getCameraYawPitchFallback() {
  const cam = noa.camera || noaAny.camera;
  if (!cam) return { yaw: 0, pitch: 0 };
  return {
    yaw: safeNum(cam.heading, safeNum(cam.yaw, 0)),
    pitch: safeNum(cam.pitch, 0),
  };
}

/* ============================================================
 * Connect Colyseus
 * ============================================================
 */

async function connectColyseus() {
  console.log("[Colyseus] attempting connection...");
  console.log("[Colyseus] endpoint:", COLYSEUS_ENDPOINT);

  await debugMatchmake(COLYSEUS_ENDPOINT);

  try {
    const room = await colyseusClient.joinOrCreate("my_room", { name: "Steve" });
    noaAny.colyseus.room = room;

    console.log("[Colyseus] connected OK");
    console.log("[Colyseus] roomId:", room.roomId || "(unknown)");
    console.log("[Colyseus] sessionId:", room.sessionId);

    room.onMessage("*", (type, msg) => console.log("[Colyseus] message:", type, msg));

    const scene = noa.rendering.getScene();
    initLocalAvatarOnce(scene, "Steve");
    createRemotePlayersManager(scene, room);

    setInterval(() => {
      const activeRoom = noaAny.colyseus.room;
      if (!activeRoom) return;

      const [x, y, z] = getLocalPlayerPositionFallback();
      const { yaw, pitch } = getCameraYawPitchFallback();
      activeRoom.send("move", { x, y, z, yaw, pitch });
    }, 50);
  } catch (err) {
    console.error("[Colyseus] connection failed:", err);
    debugHUD.state.err = String(err?.message || err);
    debugHUD.render();

    const scene = noa.rendering.getScene();
    initLocalAvatarOnce(scene, "Steve");
  }
}

connectColyseus().catch((e) => console.error("[Colyseus] crash:", e));

/* ============================================================
 * Interactivity
 * ============================================================
 */

noa.inputs.down.on("fire", function () {
  if (fpArmsRef && viewMode === 0) fpArmsRef.startSwing();

  if (noa.targetedBlock) {
    const pos = noa.targetedBlock.position;
    noa.setBlock(0, pos[0], pos[1], pos[2]);
  }
});

noa.inputs.down.on("alt-fire", function () {
  if (fpArmsRef && viewMode === 0) fpArmsRef.startSwing();

  if (noa.targetedBlock) {
    const pos = noa.targetedBlock.adjacent;
    noa.setBlock(grassID, pos[0], pos[1], pos[2]);
  }
});

noa.inputs.bind("alt-fire", "KeyE");

noa.on("tick", function () {
  const scroll = noa.inputs.pointerState.scrolly;
  if (scroll !== 0 && viewMode !== 0) {
    noa.camera.zoomDistance += scroll > 0 ? 1 : -1;
    noa.camera.zoomDistance = clamp(noa.camera.zoomDistance, 2, 12);
  }

  if (fpArmsRef) fpArmsRef.update(1 / 60);
});
