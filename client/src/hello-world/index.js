/*
 * Fresh2 - noa hello-world (main game entry) - FIXED V4
 *
 * Changes included:
 * - FIX: Avatar + FP arms were never visible because parent roots had `isVisible = false`
 *        (in Babylon, a parent with isVisible=false hides all children)
 * - Roots now start disabled via `setEnabled(false)` instead of invisible
 * - Arms can optionally show in first-person even when not pointer-locked (debug toggle)
 * - Minor safety: make sure root visibility tracks enable state
 *
 * Note on NOA/Babylon “compatibility”:
 * - If you still see nothing AFTER this, it’s very likely you have two Babylon instances
 *   (NOA using one, your app importing another). In that case, dedupe Babylon in your bundler
 *   or standardize imports (see comment near imports).
 */

import { Engine } from "noa-engine";
import { Client } from "@colyseus/sdk";

/**
 * ⚠️ If you still get “ghost meshes” after this fix, consider switching to a single Babylon import:
 *   - Option A: `import * as BABYLON from "babylonjs";` and use BABYLON.MeshBuilder, etc
 *   - Option B (Vite): resolve.dedupe for @babylonjs/* so only one copy exists.
 *
 * For now, keeping your @babylonjs/core imports but fixing the visibility bug.
 */
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Vector3, Quaternion, Vector4 } from "@babylonjs/core/Maths/math.vector";
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

/* ============================================================
 * State
 * ============================================================
 */

let viewMode = 0; // 0 first, 1 third-back, 2 third-front
let forceCrosshair = false;

/**
 * Debug toggle: allow arms to show in first-person even when not pointer locked.
 * Helpful for diagnosing pointer-lock issues. Toggle with F9.
 */
let armsRequirePointerLock = true;

let applyViewModeGlobal: null | (() => void) = null;

let fpArmsRef: any = null;
let localAvatar: any = null;

let debugSphere: any = null;
let debugSphereOn = false;

/* ============================================================
 * Small helpers
 * ============================================================
 */

function safeNum(v: any, fallback = 0) {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function clamp(v: number, a: number, b: number) {
  return Math.max(a, Math.min(b, v));
}

/* ============================================================
 * Pointer lock target
 * ============================================================
 */

/**
 * @returns {any} The pointer lock target element
 */
function getPointerLockTarget() {
  // noa.container is the #noa-container div
  const noaAny = noa as any;
  const c = noaAny.container;
  if (c && typeof c === "object" && "requestPointerLock" in c) {
    return c;
  }
  const div = document.getElementById("noa-container");
  if (div) return div;
  return document.querySelector("canvas");
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

  const state: any = {
    viewMode: 0,
    locked: false,

    camPos: "(none)",
    camHeading: 0,
    camPitch: 0,

    avatarEnabled: false,
    avatarPos: "(none)",

    armsEnabled: false,
    armsPos: "(none)",
    armsRequireLock: true,

    debugSphere: false,
    debugSpherePos: "(none)",

    crosshair: false,
    last: "(boot)",
    lastError: "(none)",
  };

  function render() {
    el.textContent =
      `Fresh2 Debug V4\n` +
      `viewMode: ${state.viewMode} (${state.viewMode === 0 ? "first" : state.viewMode === 1 ? "third-back" : "third-front"})\n` +
      `locked: ${state.locked}\n` +
      `camPos: ${state.camPos}\n` +
      `camHeading: ${state.camHeading.toFixed(2)} pitch: ${state.camPitch.toFixed(2)}\n` +
      `avatar: enabled=${state.avatarEnabled} pos=${state.avatarPos}\n` +
      `arms: enabled=${state.armsEnabled} pos=${state.armsPos} (requireLock=${state.armsRequireLock})\n` +
      `debugSphere (F8): ${state.debugSphere} pos=${state.debugSpherePos}\n` +
      `crosshair: ${state.crosshair}\n` +
      `last: ${state.last}\n` +
      `error: ${state.lastError}\n` +
      `\nKeys: F5 view | F6 crosshair | F7 flip arms | F8 debug sphere | F9 arms lock toggle\n`;
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

  const lineStyle: any = {
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
    debugHUD.state.locked = locked;
    debugHUD.render();
  }

  document.addEventListener("pointerlockchange", refresh);
  setInterval(refresh, 500);

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

    const el = target as any;

    if (typeof el.hasAttribute === "function" && !el.hasAttribute("tabindex")) {
      el.setAttribute("tabindex", "1");
    }
    if (el.style) {
      el.style.outline = "none";
    }

    el.addEventListener("click", () => {
      try {
        if (viewMode !== 0) return;
        if (document.pointerLockElement !== el) {
          el.requestPointerLock();
        }
      } catch (e: any) {
        debugHUD.state.lastError = String(e?.message || e);
      }
    });

    console.log("[PointerLock] handler attached");
  }, 100);
})();

/* ============================================================
 * noa Camera helpers
 * ============================================================
 */

function getNoaCameraPosition() {
  try {
    const pos = noa.camera.getPosition();
    if (pos && pos.length >= 3) {
      return new Vector3(pos[0], pos[1], pos[2]);
    }
  } catch {}

  // Fallback: player position + eye offset
  try {
    const ent = (noa as any).playerEntity;
    const pos = (noa as any).entities.getPosition(ent);
    if (pos && pos.length >= 3) {
      return new Vector3(pos[0], pos[1] + 1.6, pos[2]);
    }
  } catch {}

  return new Vector3(0, 10, 0);
}

function getNoaCameraRotation() {
  const heading = safeNum((noa as any).camera.heading, 0);
  const pitch = safeNum((noa as any).camera.pitch, 0);
  return { heading, pitch };
}

/* ============================================================
 * Key handlers: F5/F6/F7/F8/F9
 * ============================================================
 */

document.addEventListener("keydown", (e) => {
  if (e.code === "F5") {
    e.preventDefault();
    viewMode = (viewMode + 1) % 3;
    if (viewMode !== 0) {
      try {
        (document as any).exitPointerLock?.();
      } catch {}
    }
    try {
      if (typeof applyViewModeGlobal === "function") applyViewModeGlobal();
    } catch {}
    crosshairUI.refresh();
    console.log("[View] mode:", viewMode);
  }

  if (e.code === "F6") {
    e.preventDefault();
    forceCrosshair = !forceCrosshair;
    crosshairUI.refresh();
  }

  if (e.code === "F7") {
    e.preventDefault();
    if (fpArmsRef) {
      fpArmsRef.flipZ = !fpArmsRef.flipZ;
      console.log("[Debug] arms flipZ:", fpArmsRef.flipZ);
    }
  }

  if (e.code === "F8") {
    e.preventDefault();
    debugSphereOn = !debugSphereOn;
    if (debugSphere) {
      debugSphere.setEnabled(debugSphereOn);
      debugSphere.isVisible = debugSphereOn;
    }
    debugHUD.state.debugSphere = debugSphereOn;
    debugHUD.render();
    console.log("[Debug] sphere:", debugSphereOn);
  }

  if (e.code === "F9") {
    e.preventDefault();
    armsRequirePointerLock = !armsRequirePointerLock;
    debugHUD.state.armsRequireLock = armsRequirePointerLock;
    debugHUD.state.last = "toggle armsRequirePointerLock";
    debugHUD.render();
    try {
      if (typeof applyViewModeGlobal === "function") applyViewModeGlobal();
    } catch {}
    console.log("[Debug] armsRequirePointerLock:", armsRequirePointerLock);
  }
});

/* ============================================================
 * Colyseus
 * ============================================================
 */

const DEFAULT_LOCAL_ENDPOINT = "ws://localhost:2567";
let COLYSEUS_ENDPOINT =
  (import.meta as any).env && (import.meta as any).env.VITE_COLYSEUS_ENDPOINT
    ? (import.meta as any).env.VITE_COLYSEUS_ENDPOINT
    : DEFAULT_LOCAL_ENDPOINT;

function toHttpEndpoint(wsEndpoint: string) {
  if (wsEndpoint.startsWith("wss://")) return wsEndpoint.replace("wss://", "https://");
  if (wsEndpoint.startsWith("ws://")) return wsEndpoint.replace("ws://", "http://");
  return wsEndpoint;
}

async function debugMatchmake(endpointWsOrHttp: string) {
  const http = toHttpEndpoint(endpointWsOrHttp);
  console.log("[Colyseus][debug] http endpoint:", http);
  try {
    const r1 = await fetch(`${http}/hi`, { method: "GET" });
    console.log("[Colyseus][debug] GET /hi status:", r1.status);
  } catch (e) {
    console.error("[Colyseus][debug] GET /hi failed:", e);
  }
}

const colyseusClient = new Client(COLYSEUS_ENDPOINT);
const noaAny = noa as any;
noaAny.colyseus = { endpoint: COLYSEUS_ENDPOINT, client: colyseusClient, room: null };

/* ============================================================
 * Skins
 * ============================================================
 */

function getMcHeadsSkinUrl(identifier: string) {
  return `https://mc-heads.net/skin/${encodeURIComponent(identifier)}.png`;
}

/* ============================================================
 * UV helpers + material
 * ============================================================
 */

function uvRect(px: number, py: number, pw: number, ph: number) {
  const texW = 64,
    texH = 64;
  return new Vector4(px / texW, py / texH, (px + pw) / texW, (py + ph) / texH);
}

function makeFaceUV(front: Vector4, back: Vector4, right: Vector4, left: Vector4, top: Vector4, bottom: Vector4) {
  return [front, back, right, left, top, bottom];
}

function createSkinMaterial(scene: any, skinUrl: string, name: string) {
  const skinTexture = new Texture(skinUrl, scene, false, false, Texture.NEAREST_NEAREST);
  skinTexture.hasAlpha = true;
  skinTexture.wrapU = Texture.CLAMP_ADDRESSMODE;
  skinTexture.wrapV = Texture.CLAMP_ADDRESSMODE;

  const mat = new StandardMaterial(name, scene);
  mat.diffuseTexture = skinTexture;
  mat.emissiveColor = new Color3(0.15, 0.15, 0.15);
  mat.specularColor = new Color3(0, 0, 0);
  mat.backFaceCulling = false;

  skinTexture.onLoadObservable?.add(() => console.log("[Skin] loaded:", skinUrl));
  return mat;
}

/* ============================================================
 * Third-person avatar
 * ============================================================
 */

function createPlayerAvatar(scene: any, skinUrl: string) {
  const root = new Mesh("mc-avatar-root", scene);

  // ✅ FIX: Do NOT set root.isVisible=false (it hides children). Start disabled instead.
  root.isVisible = true;
  root.isPickable = false;
  root.setEnabled(false);

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

  function makePart(name: string, size: any, uv: any) {
    const mesh = MeshBuilder.CreateBox(
      name,
      { width: size.width, height: size.height, depth: size.depth, faceUV: uv },
      scene
    );
    mesh.material = mat;
    mesh.parent = root;
    mesh.isVisible = true;
    mesh.isPickable = false;

    // Help avoid odd culling
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.doNotSyncBoundingInfo = false;
    mesh.refreshBoundingInfo();

    // Render AFTER terrain
    mesh.renderingGroupId = 1;

    return mesh;
  }

  const head = makePart("mc-head", headSize, headUV);
  const body = makePart("mc-body", bodySize, bodyUV);
  const rightArm = makePart("mc-rightArm", limbSize, armUV);
  const leftArm = makePart("mc-leftArm", limbSize, armUV);
  const rightLeg = makePart("mc-rightLeg", limbSize, legUV);
  const leftLeg = makePart("mc-leftLeg", limbSize, legUV);

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

  root.alwaysSelectAsActiveMesh = true;

  console.log("[Avatar] created with 6 parts");
  return { root, head, body, rightArm, leftArm, rightLeg, leftLeg, material: mat };
}

/* ============================================================
 * First-person arms - NO PARENTING, manual positioning
 * ============================================================
 */

function createFirstPersonArms(scene: any, skinUrl: string) {
  const root = new Mesh("fp-arms-root", scene);

  // ✅ FIX: Do NOT set root.isVisible=false (it hides children). Start disabled instead.
  root.isVisible = true;
  root.isPickable = false;
  root.setEnabled(false);

  const mat = createSkinMaterial(scene, skinUrl, "fp-skin-mat");

  const armUV = makeFaceUV(
    uvRect(44, 20, 4, 12),
    uvRect(52, 20, 4, 12),
    uvRect(48, 20, 4, 12),
    uvRect(40, 20, 4, 12),
    uvRect(44, 16, 4, 4),
    uvRect(48, 16, 4, 4)
  );

  const armSize = { width: 0.35, height: 0.9, depth: 0.35 };

  const rightArm = MeshBuilder.CreateBox(
    "fp-rightArm",
    { width: armSize.width, height: armSize.height, depth: armSize.depth, faceUV: armUV },
    scene
  );
  rightArm.material = mat;
  rightArm.parent = root;
  rightArm.isVisible = true;
  rightArm.isPickable = false;
  rightArm.alwaysSelectAsActiveMesh = true;
  rightArm.renderingGroupId = 1;

  const leftArm = MeshBuilder.CreateBox(
    "fp-leftArm",
    { width: armSize.width, height: armSize.height, depth: armSize.depth, faceUV: armUV },
    scene
  );
  leftArm.material = mat;
  leftArm.parent = root;
  leftArm.isVisible = true;
  leftArm.isPickable = false;
  leftArm.alwaysSelectAsActiveMesh = true;
  leftArm.renderingGroupId = 1;

  const rightArmOffset = new Vector3(0.45, -0.35, 0.55);
  const leftArmOffset = new Vector3(-0.35, -0.40, 0.50);

  rightArm.position.copyFrom(rightArmOffset);
  leftArm.position.copyFrom(leftArmOffset);

  rightArm.rotation.set(0.15, 0.2, 0.15);
  leftArm.rotation.set(0.05, -0.25, -0.05);

  root.alwaysSelectAsActiveMesh = true;

  const anim = { active: false, t: 0, duration: 0.18 };
  const base = {
    rx: rightArm.rotation.x,
    ry: rightArm.rotation.y,
    rz: rightArm.rotation.z,
    lx: leftArm.rotation.x,
    ly: leftArm.rotation.y,
    lz: leftArm.rotation.z,
  };

  let enabled = false;
  let flipZ = false;

  function startSwing() {
    anim.active = true;
    anim.t = 0;
  }

  function easeInOutQuad(x: number) {
    return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
  }

  function updateAnim(dt: number) {
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

  function updatePosition() {
    if (!enabled) return;

    const camPos = getNoaCameraPosition();
    const { heading, pitch } = getNoaCameraRotation();
    const quat = Quaternion.RotationYawPitchRoll(heading, pitch, 0);

    const forwardDist = flipZ ? -0.6 : 0.6;
    const downDist = -0.3;
    const rightDist = 0.1;

    const localOffset = new Vector3(rightDist, downDist, forwardDist);
    const worldOffset = localOffset.rotateByQuaternionToRef(quat, new Vector3());

    root.position.copyFrom(camPos.add(worldOffset));
    root.rotationQuaternion = quat;
  }

  function setEnabled(val: boolean) {
    enabled = val;
    root.setEnabled(val);

    // Keep visibility aligned with enabled (helps avoid accidental invisibility)
    root.isVisible = val;
    rightArm.setEnabled(val);
    leftArm.setEnabled(val);
    rightArm.isVisible = val;
    leftArm.isVisible = val;
  }

  console.log("[FPArms] created (manual positioning)");
  return {
    root,
    rightArm,
    leftArm,
    startSwing,
    updateAnim,
    updatePosition,
    setEnabled,
    get flipZ() {
      return flipZ;
    },
    set flipZ(v: boolean) {
      flipZ = v;
    },
    get enabled() {
      return enabled;
    },
  };
}

/* ============================================================
 * Debug sphere - world space
 * ============================================================
 */

function createDebugSphere(scene: any) {
  const sphere = MeshBuilder.CreateSphere("debugSphere", { diameter: 1.5 }, scene);
  const mat = new StandardMaterial("debugSphereMat", scene);
  mat.diffuseColor = new Color3(1, 0, 1);
  mat.emissiveColor = new Color3(0.5, 0, 0.5);
  mat.backFaceCulling = false;
  sphere.material = mat;
  sphere.isPickable = false;

  sphere.alwaysSelectAsActiveMesh = true;
  sphere.doNotSyncBoundingInfo = false;
  sphere.refreshBoundingInfo();
  sphere.renderingGroupId = 1;

  sphere.setEnabled(false);
  sphere.isVisible = false;

  console.log("[DebugSphere] created in world space, renderingGroupId:", sphere.renderingGroupId);
  return sphere;
}

/**
 * Create a simple solid-color test cube to diagnose rendering issues
 */
function createTestCube(scene: any) {
  const cube = MeshBuilder.CreateBox("testCube", { size: 2 }, scene);

  const mat = new StandardMaterial("testCubeMat", scene);
  mat.diffuseColor = new Color3(1, 0, 0);
  mat.emissiveColor = new Color3(0.5, 0, 0);
  mat.specularColor = new Color3(0, 0, 0);
  mat.backFaceCulling = false;

  cube.material = mat;
  cube.isPickable = false;
  cube.isVisible = true;

  cube.alwaysSelectAsActiveMesh = true;
  cube.doNotSyncBoundingInfo = false;
  cube.refreshBoundingInfo();
  cube.renderingGroupId = 1;

  // Put it somewhere the camera should be able to see easily
  cube.position.set(0, 30, 6);

  console.log("[TestCube] created at (0, 30, 6) - bright red, should be visible!");
  console.log("[TestCube] isVisible:", cube.isVisible, "isEnabled:", cube.isEnabled());
  console.log("[TestCube] material:", (cube.material as any)?.name);
  console.log("[TestCube] position:", cube.position.toString());
  console.log("[TestCube] renderingGroupId:", cube.renderingGroupId);

  return cube;
}

/* ============================================================
 * Register voxel types
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

function getVoxelID(x: number, y: number, z: number) {
  if (y < -3) return dirtID;
  const height = 2 * Math.sin(x / 10) + 3 * Math.cos(z / 20);
  if (y < height) return grassID;
  return 0;
}

noa.world.on("worldDataNeeded", function (id: any, data: any, x: number, y: number, z: number) {
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
 * Local avatar init + view mode
 * ============================================================
 */

let localAvatarAttached = false;
let testCube: any = null;

function initLocalAvatarOnce(scene: any, playerIdentifier: string) {
  if (localAvatarAttached) return;

  const skinUrl = getMcHeadsSkinUrl(playerIdentifier);
  console.log("[Skin] URL:", skinUrl);

  testCube = createTestCube(scene);

  localAvatar = createPlayerAvatar(scene, skinUrl);
  fpArmsRef = createFirstPersonArms(scene, skinUrl);
  debugSphere = createDebugSphere(scene);

  // Attach avatar to player entity using bracket notation to avoid TS errors
  const playerEntity = (noa as any).playerEntity;
  try {
    const entities = (noa as any).entities;
    const meshCompName = entities.names?.mesh ?? "mesh";

    const hasComp = entities["hasComponent"];
    const addComp = entities["addComponent"];

    if (typeof hasComp === "function" && typeof addComp === "function") {
      if (!hasComp.call(entities, playerEntity, meshCompName)) {
        addComp.call(entities, playerEntity, meshCompName, {
          mesh: localAvatar.root,
          offset: [0, 0, 0],
        });
        console.log("[Avatar] attached to player entity");
      }
    } else {
      console.warn("[Avatar] hasComponent/addComponent not found, trying direct add");
      if (addComp) {
        addComp.call(entities, playerEntity, meshCompName, {
          mesh: localAvatar.root,
          offset: [0, 0, 0],
        });
        console.log("[Avatar] attached (fallback)");
      }
    }
  } catch (e: any) {
    console.error("[Avatar] attach failed:", e);
    debugHUD.state.lastError = String(e?.message || e);
  }

  function applyViewMode() {
    const locked = isPointerLockedToNoa();
    const isFirst = viewMode === 0;

    (noa as any).camera.zoomDistance = isFirst ? 0 : 6;

    // Avatar: hidden in first person
    const avatarOn = !isFirst;
    localAvatar.root.setEnabled(avatarOn);
    localAvatar.root.isVisible = avatarOn;

    localAvatar.head.setEnabled(avatarOn);
    localAvatar.body.setEnabled(avatarOn);
    localAvatar.rightArm.setEnabled(avatarOn);
    localAvatar.leftArm.setEnabled(avatarOn);
    localAvatar.rightLeg.setEnabled(avatarOn);
    localAvatar.leftLeg.setEnabled(avatarOn);

    // Arms: shown only in first person, and (optionally) only when locked
    const armsOn = isFirst && (!armsRequirePointerLock || locked);
    fpArmsRef.setEnabled(armsOn);

    debugHUD.state.viewMode = viewMode;
    debugHUD.state.avatarEnabled = avatarOn;
    debugHUD.state.armsEnabled = armsOn;
    debugHUD.state.armsRequireLock = armsRequirePointerLock;
    debugHUD.state.last = "applyViewMode";
    debugHUD.render();

    console.log("[applyViewMode] viewMode:", viewMode, "locked:", locked, "avatar:", avatarOn, "arms:", armsOn);
  }

  applyViewModeGlobal = applyViewMode;
  applyViewMode();

  document.addEventListener("pointerlockchange", applyViewMode);

  localAvatarAttached = true;
}

/* ============================================================
 * Remote players
 * ============================================================
 */

function createRemotePlayersManager(scene: any, room: any) {
  const remotes = new Map<string, any>();

  function spawnRemote(sessionId: string, playerState: any) {
    const name = playerState?.name || "Steve";
    const skinUrl = getMcHeadsSkinUrl(name);
    const avatar = createPlayerAvatar(scene, skinUrl);

    // Ensure enabled + visible
    avatar.root.setEnabled(true);
    avatar.root.isVisible = true;

    avatar.head.setEnabled(true);
    avatar.body.setEnabled(true);
    avatar.rightArm.setEnabled(true);
    avatar.leftArm.setEnabled(true);
    avatar.rightLeg.setEnabled(true);
    avatar.leftLeg.setEnabled(true);

    const x = safeNum(playerState.x, 0);
    const y = safeNum(playerState.y, 10);
    const z = safeNum(playerState.z, 0);
    avatar.root.position.set(x, y, z);

    remotes.set(sessionId, { avatar, tx: x, ty: y, tz: z });
    console.log("[Remote] spawned", sessionId, name);
  }

  function removeRemote(sessionId: string) {
    const r = remotes.get(sessionId);
    if (!r) return;
    try {
      r.avatar.root.dispose(false, true);
    } catch {}
    remotes.delete(sessionId);
  }

  function updateRemote(sessionId: string, playerState: any) {
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
      root.position.x += (r.tx - root.position.x) * alpha;
      root.position.y += (r.ty - root.position.y) * alpha;
      root.position.z += (r.tz - root.position.z) * alpha;
    });
  });

  (function waitForPlayersMap() {
    const interval = setInterval(() => {
      const players = room?.state?.players;
      if (players) {
        clearInterval(interval);
        players.onAdd = (playerState: any, sessionId: string) => {
          if (sessionId === room.sessionId) return;
          spawnRemote(sessionId, playerState);
          try {
            playerState.onChange = () => updateRemote(sessionId, playerState);
          } catch {}
        };
        players.onRemove = (_ps: any, sessionId: string) => removeRemote(sessionId);
        console.log("[Remote] hooked");
      }
    }, 50);
    setTimeout(() => clearInterval(interval), 5000);
  })();
}

/* ============================================================
 * Position helpers
 * ============================================================
 */

function getLocalPlayerPosition() {
  try {
    const p = (noa as any).entities.getPosition((noa as any).playerEntity);
    if (p?.length >= 3) return [p[0], p[1], p[2]];
  } catch {}
  return [0, 10, 0];
}

/* ============================================================
 * Connect Colyseus
 * ============================================================
 */

async function connectColyseus() {
  console.log("[Colyseus] connecting to:", COLYSEUS_ENDPOINT);
  await debugMatchmake(COLYSEUS_ENDPOINT);

  try {
    const room = await colyseusClient.joinOrCreate("my_room", { name: "Steve" });
    noaAny.colyseus.room = room;

    console.log("[Colyseus] connected, session:", room.sessionId);

    room.onMessage("*", (type: any, message: any) => console.log("[Colyseus] msg:", type, message));
    room.onLeave(() => {
      console.warn("[Colyseus] left");
      noaAny.colyseus.room = null;
    });

    const scene = (noa as any).rendering.getScene();

    // Quick sanity logs
    try {
      console.log("[Babylon] scene:", scene?.constructor?.name);
      console.log("[Babylon] engine:", scene?.getEngine?.()?.constructor?.name);
    } catch {}

    initLocalAvatarOnce(scene, "Steve");
    createRemotePlayersManager(scene, room);

    setInterval(() => {
      const activeRoom = noaAny.colyseus.room;
      if (!activeRoom) return;
      const [x, y, z] = getLocalPlayerPosition();
      const { heading, pitch } = getNoaCameraRotation();
      activeRoom.send("move", { x, y, z, yaw: heading, pitch });
    }, 50);
  } catch (err: any) {
    console.error("[Colyseus] failed:", err);
    debugHUD.state.lastError = String(err?.message || err);

    const scene = (noa as any).rendering.getScene();
    initLocalAvatarOnce(scene, "Steve");
  }
}

connectColyseus();

/* ============================================================
 * Main tick
 * ============================================================
 */

noa.on("tick", function () {
  const dt = 1 / 60;

  if (fpArmsRef) {
    fpArmsRef.updateAnim(dt);
  }

  const scroll = (noa as any).inputs.pointerState.scrolly;
  if (scroll !== 0 && viewMode !== 0) {
    (noa as any).camera.zoomDistance += scroll > 0 ? 1 : -1;
    (noa as any).camera.zoomDistance = clamp((noa as any).camera.zoomDistance, 2, 12);
  }
});

noa.on("beforeRender", function () {
  if (fpArmsRef && fpArmsRef.enabled) {
    fpArmsRef.updatePosition();
  }

  if (debugSphere && debugSphereOn) {
    const camPos = getNoaCameraPosition();
    const { heading } = getNoaCameraRotation();

    const forwardX = Math.sin(heading) * 3;
    const forwardZ = Math.cos(heading) * 3;
    debugSphere.position.set(camPos.x + forwardX, camPos.y, camPos.z + forwardZ);

    debugHUD.state.debugSpherePos = `${debugSphere.position.x.toFixed(1)},${debugSphere.position.y.toFixed(
      1
    )},${debugSphere.position.z.toFixed(1)}`;
  }

  if (localAvatar) {
    const pos = localAvatar.root.position;
    debugHUD.state.avatarPos = `${pos.x.toFixed(1)},${pos.y.toFixed(1)},${pos.z.toFixed(1)}`;

    if (localAvatar.head) {
      localAvatar.head.computeWorldMatrix(true);
      const worldPos = localAvatar.head.getAbsolutePosition();
      debugHUD.state.avatarPos += ` head@${worldPos.x.toFixed(1)},${worldPos.y.toFixed(1)},${worldPos.z.toFixed(1)}`;
    }
  }

  if (fpArmsRef) {
    const pos = fpArmsRef.root.position;
    debugHUD.state.armsPos = `${pos.x.toFixed(1)},${pos.y.toFixed(1)},${pos.z.toFixed(1)}`;
  }

  const camPos = getNoaCameraPosition();
  const { heading, pitch } = getNoaCameraRotation();
  debugHUD.state.camPos = `${camPos.x.toFixed(1)},${camPos.y.toFixed(1)},${camPos.z.toFixed(1)}`;
  debugHUD.state.camHeading = heading;
  debugHUD.state.camPitch = pitch;
  debugHUD.render();
});

/* ============================================================
 * Interactivity
 * ============================================================
 */

noa.inputs.down.on("fire", function () {
  if (fpArmsRef && viewMode === 0) fpArmsRef.startSwing();
  if ((noa as any).targetedBlock) {
    const pos = (noa as any).targetedBlock.position;
    (noa as any).setBlock(0, pos[0], pos[1], pos[2]);
  }
});

noa.inputs.down.on("alt-fire", function () {
  if (fpArmsRef && viewMode === 0) fpArmsRef.startSwing();
  if ((noa as any).targetedBlock) {
    const pos = (noa as any).targetedBlock.adjacent;
    (noa as any).setBlock(grassID, pos[0], pos[1], pos[2]);
  }
});

noa.inputs.bind("alt-fire", "KeyE");
