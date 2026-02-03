/*
 * Fresh2 - noa hello-world (main game entry) - FIXED VERSION
 *
 * Key fixes for invisible arms/avatar:
 *  1. Explicitly set isVisible=true on ALL child meshes, not just root
 *  2. Defer layer mask application until after first render
 *  3. Adjust FP arms z-position closer to avoid near-clip issues
 *  4. Use noa.rendering.getScene() for reliable camera access
 *  5. Force alwaysSelectAsActiveMesh on all meshes
 *  6. Add renderingGroupId to ensure proper render order
 */

import { Engine } from "noa-engine";
import { Client } from "@colyseus/sdk";

import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Vector4 } from "@babylonjs/core/Maths/math.vector";
import { Color3 } from "@babylonjs/core/Maths/math.color";

/* ============================================================
 * Engine options + instantiate noa
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

let debugCube = null;
let debugCubeOn = false;

/* ============================================================
 * Small helpers
 * ============================================================
 */

function safeNum(v, fallback = 0) {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

/* ============================================================
 * Pointer lock target (noa container, NOT canvas)
 * ============================================================
 */

/** @returns {HTMLElement|null} */
function getPointerLockTarget() {
  const c = /** @type {any} */ (noa).container;

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
    lockTarget: "(none)",
    lockEl: "(none)",

    camName: "(none)",
    camClass: "(none)",
    camMask: "(none)",
    camNearClip: "(none)",

    avatarEnabled: false,
    avatarVisible: false,
    avatarMask: "(n/a)",
    avatarChildCount: 0,

    armsEnabled: false,
    armsExists: false,
    armsMask: "(n/a)",
    armsParent: "(none)",
    armsPos: "(none)",

    crosshair: false,
    last: "(boot)",
    lastError: "(none)",

    debugCube: false,
  };

  function render() {
    el.textContent =
      `Fresh2 Debug (FIXED)\n` +
      `viewMode: ${state.viewMode} (${state.viewMode === 0 ? "first" : state.viewMode === 1 ? "third-back" : "third-front"})\n` +
      `locked: ${state.locked}\n` +
      `lockTarget: ${state.lockTarget}\n` +
      `pointerLockEl: ${state.lockEl}\n` +
      `camera: ${state.camName} (${state.camClass}) mask=${state.camMask} near=${state.camNearClip}\n` +
      `avatar: enabled=${state.avatarEnabled} visible=${state.avatarVisible} mask=${state.avatarMask} children=${state.avatarChildCount}\n` +
      `arms: exists=${state.armsExists} enabled=${state.armsEnabled} mask=${state.armsMask}\n` +
      `armsParent: ${state.armsParent} pos=${state.armsPos}\n` +
      `crosshair: ${state.crosshair} (F6 force=${forceCrosshair})\n` +
      `debugCube (F8): ${state.debugCube}\n` +
      `last: ${state.last}\n` +
      `error: ${state.lastError}\n` +
      `\nKeys: F5 view | F6 crosshair | F7 flip arms Z | F8 debug cube\n`;
  }

  return { el, state, render };
}

const debugHUD = createDebugHUD();

/* ============================================================
 * Crosshair overlay
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

  const lineStyle = {
    position: "absolute",
    backgroundColor: "rgba(255,255,255,0.95)",
    boxShadow: "0px 0px 3px rgba(0,0,0,0.95)",
  };

  const h = document.createElement("div");
  Object.assign(h.style, lineStyle, { width: "100%", height: "3px", top: "9px", left: "0px" });

  const v = document.createElement("div");
  Object.assign(v.style, lineStyle, { width: "3px", height: "100%", left: "9px", top: "0px" });

  crosshair.appendChild(h);
  crosshair.appendChild(v);
  document.body.appendChild(crosshair);

  function refresh() {
    const locked = isPointerLockedToNoa();
    const show = forceCrosshair || (locked && viewMode === 0);
    crosshair.style.display = show ? "flex" : "none";

    debugHUD.state.crosshair = show;

    const target = getPointerLockTarget();
    debugHUD.state.lockTarget = target ? `${target.tagName.toLowerCase()}#${target.id || "(no-id)"}` : "(none)";
    debugHUD.state.locked = locked;
    debugHUD.state.lockEl = document.pointerLockElement
      ? `${/** @type {any} */ (document.pointerLockElement).tagName?.toLowerCase?.() || "el"}#${/** @type {any} */ (document.pointerLockElement).id || "(no-id)"}`
      : "(none)";
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
 * Click-to-lock pointer
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
        debugHUD.state.lastError = String(e?.message || e);
        debugHUD.state.last = "pointerlock.request failed";
        debugHUD.render();
      }
    });

    console.log("[PointerLock] click handler attached to lock target:", target);
  }, 100);
})();

/* ============================================================
 * Babylon camera + layerMask forcing - FIXED
 * ============================================================
 */

function getBabylonCamera(scene) {
  return scene && scene.activeCamera ? scene.activeCamera : null;
}

/**
 * FIX: Ensure ALL meshes in hierarchy are visible and have correct layer mask
 */
function ensureMeshVisibility(scene, rootNode) {
  if (!rootNode) return;

  const cam = getBabylonCamera(scene);
  const mask = cam ? (/** @type {any} */ (cam).layerMask ?? 0x0fffffff) : 0x0fffffff;

  // Set on root
  try {
    rootNode.layerMask = mask;
    rootNode.isVisible = true;
    rootNode.alwaysSelectAsActiveMesh = true;
    rootNode.isPickable = false;
    // Use rendering group 1 to render after terrain
    if (typeof rootNode.renderingGroupId !== 'undefined') {
      rootNode.renderingGroupId = 1;
    }
  } catch (e) {
    console.warn("[ensureMeshVisibility] root error:", e);
  }

  // Set on ALL children recursively
  try {
    const allChildren = rootNode.getChildMeshes ? rootNode.getChildMeshes(false) : [];
    for (const m of allChildren) {
      try {
        m.layerMask = mask;
        m.isVisible = true;
        m.alwaysSelectAsActiveMesh = true;
        m.isPickable = false;
        if (typeof m.renderingGroupId !== 'undefined') {
          m.renderingGroupId = 1;
        }
      } catch (e) {
        console.warn("[ensureMeshVisibility] child error:", e);
      }
    }
  } catch (e) {
    console.warn("[ensureMeshVisibility] getChildMeshes error:", e);
  }
}

/* ============================================================
 * F5 / F6 / F7 / F8
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
    console.log("[View] mode:", viewMode === 0 ? "first" : viewMode === 1 ? "third-back" : "third-front");
  }

  if (e.code === "F6") {
    e.preventDefault();
    forceCrosshair = !forceCrosshair;
    crosshairUI.refresh();
  }

  if (e.code === "F7") {
    e.preventDefault();
    if (fpArmsRef && fpArmsRef.root) {
      fpArmsRef.root.position.z *= -1;
      console.log("[Debug] flipped FP arms Z:", fpArmsRef.root.position.z);
      if (typeof applyViewModeGlobal === "function") applyViewModeGlobal();
    }
  }

  if (e.code === "F8") {
    e.preventDefault();
    debugCubeOn = !debugCubeOn;
    if (debugCube) {
      debugCube.setEnabled(debugCubeOn);
    }
    debugHUD.state.debugCube = debugCubeOn;
    debugHUD.state.last = "F8 debugCube toggled";
    debugHUD.render();
  }
});

/* ============================================================
 * Colyseus (kept)
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
 * UV helpers + material
 * ============================================================
 */

function uvRect(px, py, pw, ph) {
  const texW = 64;
  const texH = 64;
  return new Vector4(px / texW, py / texH, (px + pw) / texW, (py + ph) / texH);
}

function makeFaceUV(front, back, right, left, top, bottom) {
  return [front, back, right, left, top, bottom];
}

function createSkinMaterial(scene, skinUrl, name) {
  const skinTexture = new Texture(skinUrl, scene, false, false, Texture.NEAREST_NEAREST);
  skinTexture.hasAlpha = true;
  skinTexture.wrapU = Texture.CLAMP_ADDRESSMODE;
  skinTexture.wrapV = Texture.CLAMP_ADDRESSMODE;

  const mat = new StandardMaterial(name, scene);
  mat.diffuseTexture = skinTexture;
  mat.emissiveColor = new Color3(0.15, 0.15, 0.15); // Slight boost for visibility
  mat.specularColor = new Color3(0, 0, 0);
  mat.backFaceCulling = false;

  if (skinTexture.onLoadObservable && typeof skinTexture.onLoadObservable.add === "function") {
    skinTexture.onLoadObservable.add(() => console.log("[Skin] loaded:", skinUrl));
  }
  return mat;
}

/* ============================================================
 * Third-person avatar (player body) - FIXED
 * ============================================================
 */

function createPlayerAvatar(scene, skinUrl) {
  const root = new Mesh("mc-avatar-root", scene);
  root.isVisible = true;

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
  head.isVisible = true; // FIX: explicit visibility

  const body = MeshBuilder.CreateBox("mc-body", { width: bodySize.width, height: bodySize.height, depth: bodySize.depth, faceUV: bodyUV }, scene);
  body.material = mat;
  body.parent = root;
  body.isVisible = true;

  const rightArm = MeshBuilder.CreateBox("mc-rightArm", { width: limbSize.width, height: limbSize.height, depth: limbSize.depth, faceUV: armUV }, scene);
  rightArm.material = mat;
  rightArm.parent = root;
  rightArm.isVisible = true;

  const leftArm = MeshBuilder.CreateBox("mc-leftArm", { width: limbSize.width, height: limbSize.height, depth: limbSize.depth, faceUV: armUV }, scene);
  leftArm.material = mat;
  leftArm.parent = root;
  leftArm.isVisible = true;

  const rightLeg = MeshBuilder.CreateBox("mc-rightLeg", { width: limbSize.width, height: limbSize.height, depth: limbSize.depth, faceUV: legUV }, scene);
  rightLeg.material = mat;
  rightLeg.parent = root;
  rightLeg.isVisible = true;

  const leftLeg = MeshBuilder.CreateBox("mc-leftLeg", { width: limbSize.width, height: limbSize.height, depth: limbSize.depth, faceUV: legUV }, scene);
  leftLeg.material = mat;
  leftLeg.parent = root;
  leftLeg.isVisible = true;

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

  // FIX: Ensure all meshes have proper visibility settings immediately
  ensureMeshVisibility(scene, root);

  return { root, material: mat };
}

/* ============================================================
 * First-person arms (parent to scene.activeCamera) - FIXED
 * ============================================================
 */

function createFirstPersonArms(scene, skinUrl) {
  const cam = getBabylonCamera(scene);
  if (!cam) {
    console.warn("[FPArms] no activeCamera - will retry");
    return null;
  }

  // FIX: Check and adjust camera near clip plane if needed
  const camAny = /** @type {any} */ (cam);
  console.log("[FPArms] Camera near clip:", camAny.minZ, "far clip:", camAny.maxZ);
  
  // If near clip is too large, our arms won't render
  if (camAny.minZ && camAny.minZ > 0.05) {
    console.warn("[FPArms] Near clip too large, arms may be clipped. Current:", camAny.minZ);
  }

  const root = new Mesh("fp-arms-root", scene);
  root.isVisible = true;
  root.parent = cam;

  // FIX: Position arms closer to camera to avoid near-clip issues
  // Original was (0.38, -0.42, 1.10) - try closer
  root.position.set(0.35, -0.38, 0.65);
  root.rotation.set(0, 0, 0);
  root.scaling.set(0.75, 0.75, 0.75);

  const mat = createSkinMaterial(scene, skinUrl, "fp-skin-mat");
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
  rightArm.isVisible = true; // FIX: explicit

  const leftArm = MeshBuilder.CreateBox("fp-leftArm", { width: armSize.width, height: armSize.height, depth: armSize.depth, faceUV: armUV }, scene);
  leftArm.material = mat;
  leftArm.parent = root;
  leftArm.isVisible = true; // FIX: explicit

  rightArm.position.set(0.32, -0.15, 0.0);
  leftArm.position.set(-0.22, -0.22, -0.05);

  rightArm.rotation.set(0.15, 0.2, 0.15);
  leftArm.rotation.set(0.05, -0.25, -0.05);

  const anim = { active: false, t: 0, duration: 0.18 };

  const base = {
    rootRotX: root.rotation.x,
    rx: rightArm.rotation.x, ry: rightArm.rotation.y, rz: rightArm.rotation.z,
    lx: leftArm.rotation.x, ly: leftArm.rotation.y, lz: leftArm.rotation.z,
  };

  function startSwing() {
    anim.active = true;
    anim.t = 0;
  }

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

    root.rotation.x = base.rootRotX + swing * 0.08;

    if (p >= 1) {
      anim.active = false;
      rightArm.rotation.set(base.rx, base.ry, base.rz);
      leftArm.rotation.set(base.lx, base.ly, base.lz);
      root.rotation.x = base.rootRotX;
    }
  }

  function setEnabled(enabled) {
    root.setEnabled(enabled);
    // FIX: Also set children explicitly
    rightArm.setEnabled(enabled);
    leftArm.setEnabled(enabled);
  }

  // FIX: Ensure visibility after a short delay (scene fully ready)
  setTimeout(() => {
    ensureMeshVisibility(scene, root);
  }, 100);

  console.log("[FPArms] created. parent:", root.parent?.name, "cam:", cam.name, "pos:", root.position.toString());
  return { root, rightArm, leftArm, startSwing, update, setEnabled };
}

/* ============================================================
 * Debug cube (proves mesh visibility)
 * ============================================================
 */

function ensureDebugCube(scene) {
  if (debugCube) return;

  const cam = getBabylonCamera(scene);
  debugCube = MeshBuilder.CreateBox("debugCube", { size: 0.7 }, scene);
  const m = new StandardMaterial("debugCubeMat", scene);
  m.diffuseColor = new Color3(1, 0, 1);
  m.emissiveColor = new Color3(0.4, 0, 0.4);
  m.backFaceCulling = false;
  debugCube.material = m;

  if (cam) {
    debugCube.parent = cam;
    debugCube.position.set(0.0, 0.0, 2.0);
  }

  debugCube.setEnabled(false);
  ensureMeshVisibility(scene, debugCube);
}

/* ============================================================
 * Register voxel types (materials + blocks)
 * ============================================================
 */

const brownish = [0.45, 0.36, 0.22];
const greenish = [0.1, 0.8, 0.2];

noa.registry.registerMaterial("dirt", { color: brownish });
noa.registry.registerMaterial("grass", { color: greenish });

const dirtID = noa.registry.registerBlock(1, { material: "dirt" });
const grassID = noa.registry.registerBlock(2, { material: "grass" });

/* ============================================================
 * World generation
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
        const voxelID = getVoxelID(x + i, y + j, z + k);
        data.set(i, j, k, voxelID);
      }
    }
  }
  noa.world.setChunkData(id, data);
});

/* ============================================================
 * Local avatar attach + view mode logic - FIXED
 * ============================================================
 */

let localAvatarAttached = false;

function initLocalAvatarOnce(scene, playerIdentifier) {
  if (localAvatarAttached) return;

  const entities = /** @type {any} */ (noa.entities);
  const playerEntity = noa.playerEntity;

  const skinUrl = getMcHeadsSkinUrl(playerIdentifier);
  console.log("[Skin] Using MCHeads skin URL:", skinUrl);

  localAvatar = createPlayerAvatar(scene, skinUrl);
  fpArmsRef = createFirstPersonArms(scene, skinUrl);

  ensureDebugCube(scene);

  // FIX: Use noa's actual player height for proper offset
  // The mesh origin is at the bottom of the avatar, so offset should be 0 or small
  const offset = [0, 0, 0]; // Avatar feet at entity position

  try {
    if (entities && typeof entities.hasComponent === "function") {
      if (!entities.hasComponent(playerEntity, noa.entities.names.mesh)) {
        entities.addComponent(playerEntity, noa.entities.names.mesh, {
          mesh: localAvatar.root,
          offset: offset,
        });
        console.log("[Avatar] attached to player entity with offset:", offset);
      }
    } else {
      entities.addComponent(playerEntity, noa.entities.names.mesh, {
        mesh: localAvatar.root,
        offset: offset,
      });
      console.log("[Avatar] attached to player entity with offset:", offset);
    }
  } catch (e) {
    console.error("[Avatar] add mesh component failed:", e);
    debugHUD.state.lastError = String(e?.message || e);
  }

  // FIX: Delay visibility enforcement to ensure scene is ready
  setTimeout(() => {
    ensureMeshVisibility(scene, localAvatar.root);
    if (fpArmsRef) ensureMeshVisibility(scene, fpArmsRef.root);
    console.log("[Avatar] visibility enforced after delay");
  }, 200);

  function applyViewMode() {
    const locked = isPointerLockedToNoa();
    const isFirst = viewMode === 0;

    // Camera zoom control
    if (viewMode === 0) noa.camera.zoomDistance = 0;
    if (viewMode === 1) noa.camera.zoomDistance = 6;
    if (viewMode === 2) noa.camera.zoomDistance = 6;

    // Avatar only visible in 3rd person
    localAvatar.root.setEnabled(!isFirst);
    
    // FIX: Also set all children explicitly
    const avatarChildren = localAvatar.root.getChildMeshes ? localAvatar.root.getChildMeshes(false) : [];
    for (const child of avatarChildren) {
      child.setEnabled(!isFirst);
    }

    // Arms only visible in first-person AND locked
    const armsEnabled = !!(fpArmsRef && isFirst && locked);
    if (fpArmsRef) fpArmsRef.setEnabled(armsEnabled);

    // FIX: Re-enforce visibility settings periodically
    ensureMeshVisibility(scene, localAvatar.root);
    if (fpArmsRef) ensureMeshVisibility(scene, fpArmsRef.root);
    if (debugCube) ensureMeshVisibility(scene, debugCube);

    crosshairUI.refresh();

    // HUD camera info
    const cam = getBabylonCamera(scene);
    const camAny = /** @type {any} */ (cam);
    debugHUD.state.camName = cam ? cam.name : "(none)";
    debugHUD.state.camClass = cam && cam.getClassName ? cam.getClassName() : "(none)";
    debugHUD.state.camMask = cam ? String(camAny.layerMask ?? "(none)") : "(none)";
    debugHUD.state.camNearClip = cam ? String(camAny.minZ ?? "(none)") : "(none)";

    debugHUD.state.viewMode = viewMode;
    debugHUD.state.locked = locked;

    debugHUD.state.avatarEnabled = localAvatar.root.isEnabled();
    debugHUD.state.avatarVisible = localAvatar.root.isVisible;
    debugHUD.state.avatarMask = String(localAvatar.root.layerMask ?? "(none)");
    debugHUD.state.avatarChildCount = avatarChildren.length;

    debugHUD.state.armsExists = !!fpArmsRef;
    debugHUD.state.armsEnabled = armsEnabled;
    debugHUD.state.armsMask = fpArmsRef ? String(fpArmsRef.root.layerMask ?? "(none)") : "(n/a)";
    debugHUD.state.armsParent = fpArmsRef && fpArmsRef.root.parent ? (fpArmsRef.root.parent.name || "(parent)") : "(none)";
    debugHUD.state.armsPos = fpArmsRef ? fpArmsRef.root.position.toString() : "(n/a)";

    debugHUD.state.debugCube = debugCubeOn;
    if (debugCube) debugCube.setEnabled(debugCubeOn);

    debugHUD.state.last = "applyViewMode";
    debugHUD.render();

    console.log("[applyViewMode]", {
      viewMode,
      locked,
      avatarEnabled: localAvatar.root.isEnabled(),
      avatarVisible: localAvatar.root.isVisible,
      avatarChildren: avatarChildren.length,
      armsEnabled,
      cam: cam ? cam.name : "(none)",
      camMask: cam ? camAny.layerMask : "(none)",
      camNearClip: cam ? camAny.minZ : "(none)",
      avatarMask: localAvatar.root.layerMask,
      armsMask: fpArmsRef ? fpArmsRef.root.layerMask : "(n/a)",
    });
  }

  applyViewModeGlobal = applyViewMode;

  // FIX: Call applyViewMode after a short delay to ensure everything is ready
  setTimeout(applyViewMode, 250);
  
  document.addEventListener("pointerlockchange", applyViewMode);

  // FIX: Also update on render tick to catch any camera changes
  let tickCount = 0;
  noa.on("tick", () => {
    tickCount++;
    // Re-apply every ~2 seconds to ensure meshes stay visible
    if (tickCount % 120 === 0) {
      ensureMeshVisibility(scene, localAvatar.root);
      if (fpArmsRef && fpArmsRef.root.isEnabled()) {
        ensureMeshVisibility(scene, fpArmsRef.root);
      }
    }
  });

  localAvatarAttached = true;
}

/* ============================================================
 * Remote players (kept minimal + safe)
 * ============================================================
 */

function createRemotePlayersManager(scene, room) {
  const remotes = new Map();

  function spawnRemote(sessionId, playerState) {
    const name =
      playerState && typeof playerState.name === "string" && playerState.name
        ? playerState.name
        : "Steve";

    const skinUrl = getMcHeadsSkinUrl(name);
    const avatar = createPlayerAvatar(scene, skinUrl);
    avatar.root.setEnabled(true);

    ensureMeshVisibility(scene, avatar.root);

    const x = safeNum(playerState.x, 0);
    const y = safeNum(playerState.y, 10);
    const z = safeNum(playerState.z, 0);
    avatar.root.position.set(x, y, z);

    remotes.set(sessionId, { avatar, tx: x, ty: y, tz: z });
    console.log("[Remote] spawned", sessionId, "name:", name);
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

        players.onAdd = (playerState, sessionId) => {
          if (sessionId === room.sessionId) return;
          spawnRemote(sessionId, playerState);
          try { playerState.onChange = () => updateRemote(sessionId, playerState); } catch {}
        };

        players.onRemove = (_ps, sessionId) => removeRemote(sessionId);

        console.log("[Remote] hooked room.state.players");
        return;
      }
      if (performance.now() - start > 5000) {
        clearInterval(interval);
        console.warn("[Remote] no room.state.players found (schema mismatch?)");
      }
    }, 50);
  })();
}

/* ============================================================
 * Local transform sender (client -> server)
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
  const yaw = safeNum(cam.heading, safeNum(cam.yaw, 0));
  const pitch = safeNum(cam.pitch, 0);
  return { yaw, pitch };
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

    room.onMessage("*", (type, message) => console.log("[Colyseus] message:", type, message));

    room.onLeave(() => {
      console.warn("[Colyseus] left room");
      noaAny.colyseus.room = null;
    });

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
    debugHUD.state.lastError = String(err?.message || err);
    debugHUD.render();

    // Still init local avatar offline
    const scene = noa.rendering.getScene();
    initLocalAvatarOnce(scene, "Steve");
  }
}

connectColyseus().catch((e) => console.error("[Colyseus] connect crash:", e));

/* ============================================================
 * Minimal interactivity
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
  // Third-person scroll zoom
  const scroll = noa.inputs.pointerState.scrolly;
  if (scroll !== 0 && viewMode !== 0) {
    noa.camera.zoomDistance += scroll > 0 ? 1 : -1;
    noa.camera.zoomDistance = clamp(noa.camera.zoomDistance, 2, 12);
  }

  if (fpArmsRef) fpArmsRef.update(1 / 60);
});