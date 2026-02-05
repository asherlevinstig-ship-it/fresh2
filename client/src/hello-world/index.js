// @ts-nocheck
/*
 * Fresh2 - hello-world (NOA main entry) - FULL REWRITE (NO OMITS)
 *
 * IMPORTANT (Root cause solved):
 * - Use the SAME Babylon runtime as NOA: `babylonjs`
 * - Do NOT mix `@babylonjs/core` with NOA unless you fully unify Babylon runtimes.
 *
 * NOA facts:
 * - Engine is constructed via `new Engine(opts)` :contentReference[oaicite:0]{index=0}
 * - Custom meshes must be registered via `noa.rendering.addMeshToScene(mesh, ...)` :contentReference[oaicite:1]{index=1}
 *
 * Features:
 * - FPS arms (sway + bob) on a weapon/tool socket (camera-parented)
 * - Third-person shoulder camera (cameraTarget offset) + avatar that follows/rotates
 * - Debug proof meshes toggle (P)
 * - Crosshair + click-to-pointerlock
 * - Colyseus connect (kept minimal)
 */

import { Engine } from "noa-engine";
import { Client } from "@colyseus/sdk";
import * as BABYLON from "babylonjs";

/**
 * OPTIONAL (for loading .glb/.gltf models with babylonjs build):
 *   npm i babylonjs-loaders
 * then uncomment this line:
 *
 * import "babylonjs-loaders";
 *
 * Note: Babylon’s official docs often mention the ES6 loader package @babylonjs/loaders, :contentReference[oaicite:2]{index=2}
 * but that is for the @babylonjs/* modular build. Since we are intentionally using `babylonjs`
 * to match NOA’s runtime, `babylonjs-loaders` is the compatible choice. :contentReference[oaicite:3]{index=3}
 */
// import "babylonjs-loaders";

/* ============================================================
 * NOA bootstrap
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

  // camera defaults (NOA module reads from engine options)
  initialZoom: 0,
  zoomSpeed: 0.25,
};

console.log("========================================");
console.log("[NOA_BOOT] typeof Engine:", typeof Engine);
console.log("[NOA_BOOT] BABYLON.Engine:", typeof BABYLON.Engine);
console.log("========================================");

const noa = new Engine(opts);
const noaAny = /** @type {any} */ (noa);

console.log("noa-engine booted:", noa.version);

/* ============================================================
 * State
 * ============================================================
 */

let viewMode = 0; // 0 = first, 1 = third
let forceCrosshair = true;
let showDebugProof = false;

let colyRoom = null;

const STATE = {
  // camera offsets (for shoulder cam)
  camFollowState: null,
  baseFollowOffset: [0, 0, 0],

  // timing
  lastTime: performance.now(),

  // camera angles (for sway)
  lastHeading: 0,
  lastPitch: 0,

  // movement (for bob)
  bobPhase: 0,

  // player last pos (fallback speed)
  lastPlayerPos: null,

  // debug: has the scene been resolved
  scene: null,
  engine: null,
};

/** Mesh refs */
const MESH = {
  // debug proof meshes
  proofA: null,
  proofB: null,
  frontCube: null,

  // first-person rig
  weaponRoot: null, // TransformNode, parented to camera
  armsRoot: null, // TransformNode, child of weaponRoot
  armL: null,
  armR: null,
  heldTool: null,

  // third-person avatar
  avatarRoot: null, // Mesh or TransformNode
  avatarBody: null, // optional child mesh
};

/* ============================================================
 * Helpers
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

function getPointerLockTarget() {
  const c = noaAny.container;
  if (c && typeof c === "object") return c;
  return document.getElementById("noa-container") || document.querySelector("canvas");
}

function isPointerLockedToNoa() {
  const target = getPointerLockTarget();
  return !!(target && document.pointerLockElement === target);
}

function resolveScene() {
  const r = noaAny.rendering;
  try {
    if (r && typeof r.getScene === "function") return r.getScene();
  } catch {}
  try {
    if (r && r.scene) return r.scene;
  } catch {}
  return null;
}

function resolveBabylonEngine(scene) {
  try {
    if (scene && typeof scene.getEngine === "function") return scene.getEngine();
  } catch {}
  try {
    const r = noaAny.rendering;
    if (r && r.engine) return r.engine;
  } catch {}
  return null;
}

/**
 * CRITICAL for NOA: register any custom mesh so it renders. :contentReference[oaicite:4]{index=4}
 */
function noaAddMesh(mesh, isStatic = false, pos = null, containingChunk = null) {
  try {
    noa.rendering.addMeshToScene(mesh, !!isStatic, pos || null, containingChunk || null);
  } catch (e) {
    console.warn("[NOA_RENDER] addMeshToScene failed:", e);
  }
}

function setMeshEnabled(mesh, on) {
  if (!mesh) return;
  try {
    if (typeof mesh.setEnabled === "function") mesh.setEnabled(!!on);
    else mesh.isVisible = !!on;
  } catch {}
}

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
    const show = forceCrosshair || viewMode === 0 || locked;
    crosshair.style.display = show ? "flex" : "none";
  }

  document.addEventListener("pointerlockchange", refresh);
  setInterval(refresh, 200);

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

    const el = /** @type {any} */ (target);

    try {
      if (typeof el.setAttribute === "function" && typeof el.hasAttribute === "function") {
        if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "1");
      }
      if (el.style) el.style.outline = "none";
    } catch {}

    const addEvt = el && (el.addEventListener || el.addListener);
    if (typeof addEvt === "function") {
      addEvt.call(el, "click", () => {
        try {
          if (document.pointerLockElement !== el && typeof el.requestPointerLock === "function") {
            el.requestPointerLock();
          }
        } catch (e) {
          console.warn("[PointerLock] request failed:", e);
        }
      });
    }

    console.log("[PointerLock] handler attached");
  }, 100);
})();

/* ============================================================
 * Key handlers
 * ============================================================
 */

document.addEventListener("keydown", (e) => {
  // V = view toggle
  if (e.code === "KeyV") {
    e.preventDefault();
    viewMode = (viewMode + 1) % 2;

    // optional unlock when leaving first-person
    if (viewMode !== 0) {
      try {
        document.exitPointerLock?.();
      } catch {}
    }

    applyViewMode();
    crosshairUI.refresh();
    console.log("[View] mode:", viewMode === 0 ? "first" : "third");
  }

  // C = crosshair forced
  if (e.code === "KeyC") {
    e.preventDefault();
    forceCrosshair = !forceCrosshair;
    crosshairUI.refresh();
    console.log("[Crosshair] forced:", forceCrosshair);
  }

  // P = proof meshes
  if (e.code === "KeyP") {
    e.preventDefault();
    showDebugProof = !showDebugProof;
    refreshDebugProofMeshes();
    console.log("[DebugProof] show:", showDebugProof);
  }
});

/* ============================================================
 * Worldgen
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
 * Babylon convenience
 * ============================================================
 */

function createSolidMat(scene, name, color3) {
  const mat = new BABYLON.StandardMaterial(name, scene);
  mat.diffuseColor = color3;
  mat.emissiveColor = color3.scale(0.45);
  mat.specularColor = new BABYLON.Color3(0, 0, 0);
  mat.backFaceCulling = false;
  return mat;
}

function ensureSceneReadyOnce() {
  if (STATE.scene && STATE.engine) return true;

  const scene = resolveScene();
  const engine = resolveBabylonEngine(scene);
  if (!scene || !engine) return false;

  STATE.scene = scene;
  STATE.engine = engine;

  // keep camera clipping forgiving
  try {
    if (scene.activeCamera) {
      scene.activeCamera.minZ = 0.05;
      scene.activeCamera.maxZ = 10000;
    }
  } catch {}

  // unfreeze active meshes (debug safety)
  try {
    if (typeof scene.unfreezeActiveMeshes === "function") scene.unfreezeActiveMeshes();
  } catch {}

  // capture cameraTarget follow offset
  try {
    const st = noa.ents.getState(noa.camera.cameraTarget, "followsEntity");
    STATE.camFollowState = st;
    STATE.baseFollowOffset = st && st.offset ? [st.offset[0], st.offset[1], st.offset[2]] : [0, 0, 0];
  } catch {
    STATE.camFollowState = null;
    STATE.baseFollowOffset = [0, 0, 0];
  }

  console.log("[Scene] ready. camera:", scene.activeCamera?.name, "baseFollowOffset:", STATE.baseFollowOffset);
  return true;
}

/* ============================================================
 * Debug proof meshes (optional)
 * ============================================================
 */

function initDebugProofMeshesOnce() {
  if (!ensureSceneReadyOnce()) return false;
  if (MESH.proofA || MESH.frontCube) return true;

  const scene = STATE.scene;

  // optional magenta background (comment out if you hate it)
  try {
    scene.clearColor = new BABYLON.Color4(0.85, 0.25, 0.85, 1);
  } catch {}

  const proofA = BABYLON.MeshBuilder.CreateBox("proofA", { size: 3 }, scene);
  proofA.material = createSolidMat(scene, "mat_proofA", new BABYLON.Color3(0, 1, 0));
  proofA.position.set(0, 14, 0);
  proofA.isPickable = false;
  proofA.alwaysSelectAsActiveMesh = true;

  const proofB = BABYLON.MeshBuilder.CreateBox("proofB", { size: 3 }, scene);
  proofB.material = createSolidMat(scene, "mat_proofB", new BABYLON.Color3(1, 1, 0));
  proofB.position.set(6, 14, 0);
  proofB.isPickable = false;
  proofB.alwaysSelectAsActiveMesh = true;

  const frontCube = BABYLON.MeshBuilder.CreateBox("frontCube", { size: 1.5 }, scene);
  frontCube.material = createSolidMat(scene, "mat_frontCube", new BABYLON.Color3(0, 0.6, 1));
  frontCube.isPickable = false;
  frontCube.alwaysSelectAsActiveMesh = true;

  // register with NOA renderer :contentReference[oaicite:5]{index=5}
  noaAddMesh(proofA, true);
  noaAddMesh(proofB, true);
  noaAddMesh(frontCube, false);

  MESH.proofA = proofA;
  MESH.proofB = proofB;
  MESH.frontCube = frontCube;

  refreshDebugProofMeshes();
  console.log("[DebugProof] created (toggle with P)");
  return true;
}

function refreshDebugProofMeshes() {
  setMeshEnabled(MESH.proofA, showDebugProof);
  setMeshEnabled(MESH.proofB, showDebugProof);
  setMeshEnabled(MESH.frontCube, showDebugProof);
}

/* ============================================================
 * FPS arms rig + tool socket
 * ============================================================
 */

function initFpsRigOnce() {
  if (!ensureSceneReadyOnce()) return false;
  if (MESH.weaponRoot) return true;

  const scene = STATE.scene;
  const cam = scene.activeCamera;
  if (!cam) return false;

  // weapon root is a TransformNode parented to camera
  const weaponRoot = new BABYLON.TransformNode("weaponRoot", scene);
  weaponRoot.parent = cam;
  weaponRoot.position.set(0, 0, 0);

  // arms root under weapon root
  const armsRoot = new BABYLON.TransformNode("armsRoot", scene);
  armsRoot.parent = weaponRoot;
  armsRoot.position.set(0, 0, 0);

  // placeholder arms (boxes)
  const armL = BABYLON.MeshBuilder.CreateBox("armL", { size: 0.6 }, scene);
  armL.parent = armsRoot;
  armL.material = createSolidMat(scene, "mat_armL", new BABYLON.Color3(0.2, 0.8, 0.2));
  armL.position.set(-0.55, -0.35, 1.05);
  armL.rotation.set(0.1, 0.25, 0);
  armL.isPickable = false;
  armL.alwaysSelectAsActiveMesh = true;

  const armR = BABYLON.MeshBuilder.CreateBox("armR", { size: 0.6 }, scene);
  armR.parent = armsRoot;
  armR.material = createSolidMat(scene, "mat_armR", new BABYLON.Color3(0.2, 0.8, 0.2));
  armR.position.set(0.55, -0.35, 1.05);
  armR.rotation.set(0.1, -0.25, 0);
  armR.isPickable = false;
  armR.alwaysSelectAsActiveMesh = true;

  // tool placeholder
  const heldTool = BABYLON.MeshBuilder.CreateBox("heldTool", { size: 0.35 }, scene);
  heldTool.parent = weaponRoot;
  heldTool.material = createSolidMat(scene, "mat_tool", new BABYLON.Color3(0.9, 0.9, 0.95));
  heldTool.position.set(0.25, -0.45, 1.15);
  heldTool.rotation.set(0.2, 0.1, 0);
  heldTool.isPickable = false;
  heldTool.alwaysSelectAsActiveMesh = true;

  // register meshes with NOA renderer (TransformNodes don’t need registration; meshes do)
  noaAddMesh(armL, false);
  noaAddMesh(armR, false);
  noaAddMesh(heldTool, false);

  MESH.weaponRoot = weaponRoot;
  MESH.armsRoot = armsRoot;
  MESH.armL = armL;
  MESH.armR = armR;
  MESH.heldTool = heldTool;

  console.log("[FPS] rig initialized");
  return true;
}

/**
 * Optional: load a GLB model and attach it to a parent.
 * Requires loaders to be available (see import "babylonjs-loaders" above). :contentReference[oaicite:6]{index=6}
 */
async function tryLoadGlbIntoParent(glbUrl, parentNode, namePrefix) {
  if (!ensureSceneReadyOnce()) return null;
  const scene = STATE.scene;

  try {
    const result = await BABYLON.SceneLoader.ImportMeshAsync("", "", glbUrl, scene);
    const meshes = result.meshes || [];
    const rootMeshes = meshes.filter((m) => m && m !== scene.meshes && m.name !== "__root__");

    // parent + register
    for (const m of meshes) {
      try {
        if (m && parentNode && typeof m.setParent === "function") m.setParent(parentNode);
      } catch {}
      try {
        if (m && m.getClassName && m.getClassName() === "Mesh") noaAddMesh(m, false);
      } catch {}
      try {
        if (m && typeof m.name === "string") m.name = `${namePrefix}_${m.name}`;
      } catch {}
    }

    console.log("[GLB] loaded:", glbUrl, "meshes:", meshes.length);
    return { result, meshes, rootMeshes };
  } catch (e) {
    console.warn("[GLB] load failed (did you install/enable loaders?)", e);
    return null;
  }
}

/* ============================================================
 * Third-person avatar
 * ============================================================
 */

function initAvatarOnce() {
  if (!ensureSceneReadyOnce()) return false;
  if (MESH.avatarRoot) return true;

  const scene = STATE.scene;

  // placeholder avatar: a red box
  const avatar = BABYLON.MeshBuilder.CreateBox("avatarBody", { size: 1.5 }, scene);
  avatar.material = createSolidMat(scene, "mat_avatar", new BABYLON.Color3(1, 0.1, 0.1));
  avatar.position.set(0, 12, 0);
  avatar.isPickable = false;
  avatar.alwaysSelectAsActiveMesh = true;

  // register with NOA renderer
  noaAddMesh(avatar, false);

  // best effort: attach to NOA mesh component (optional)
  try {
    const entities = noa.entities;
    const playerEntity = noa.playerEntity;
    const meshCompName = entities.names?.mesh ?? "mesh";
    if (typeof entities.addComponent === "function") {
      if (!entities.hasComponent || !entities.hasComponent(playerEntity, meshCompName)) {
        entities.addComponent(playerEntity, meshCompName, { mesh: avatar, offset: [0, 0, 0] });
      }
      console.log("[Avatar] attached via NOA mesh component");
    }
  } catch (e) {
    console.warn("[Avatar] attach failed (non-fatal):", e);
  }

  MESH.avatarRoot = avatar;
  MESH.avatarBody = avatar;

  console.log("[Avatar] initialized");
  return true;
}

/* ============================================================
 * View mode behavior (first/third)
 * ============================================================
 */

function applyViewMode() {
  // ensure stuff exists
  initFpsRigOnce();
  initAvatarOnce();
  initDebugProofMeshesOnce();

  const isFirst = viewMode === 0;

  // Camera zoom controls third-person distance
  try {
    const z = isFirst ? 0 : 6;
    noa.camera.zoomDistance = z;
    noa.camera.currentZoom = z;
    noa.camera.zoomSpeed = 0.35;
  } catch {}

  // Shoulder camera offset via cameraTarget follow offset (NOA API docs describe this pattern)
  // In first-person we keep it centered; in third-person we offset slightly right.
  try {
    const st = STATE.camFollowState || (noa.ents.getState(noa.camera.cameraTarget, "followsEntity") || null);
    if (st && st.offset && st.offset.length >= 3) {
      if (isFirst) {
        st.offset[0] = STATE.baseFollowOffset[0];
        st.offset[1] = STATE.baseFollowOffset[1];
        st.offset[2] = STATE.baseFollowOffset[2];
      } else {
        st.offset[0] = STATE.baseFollowOffset[0] + 0.35; // shoulder right
        st.offset[1] = STATE.baseFollowOffset[1]; // keep eye height
        st.offset[2] = STATE.baseFollowOffset[2];
      }
      STATE.camFollowState = st;
    }
  } catch {}

  // Arms visible only in first-person
  setMeshEnabled(MESH.armL, isFirst);
  setMeshEnabled(MESH.armR, isFirst);
  setMeshEnabled(MESH.heldTool, isFirst);

  // Avatar visible only in third-person
  setMeshEnabled(MESH.avatarRoot, !isFirst);

  // Debug proof meshes remain independent toggle
  refreshDebugProofMeshes();

  crosshairUI.refresh();

  console.log("[applyViewMode] mode:", isFirst ? "first" : "third", "zoom:", safeNum(noa.camera.zoomDistance, -1));
}

document.addEventListener("pointerlockchange", () => {
  crosshairUI.refresh();
});

/* ============================================================
 * Arms animation (sway + bob)
 * ============================================================
 */

function updateFpsArms(dt) {
  if (viewMode !== 0) return; // only first-person
  if (!MESH.weaponRoot || !STATE.scene?.activeCamera) return;

  // camera delta for sway
  const heading = safeNum(noa.camera.heading, 0);
  const pitch = safeNum(noa.camera.pitch, 0);

  let dHeading = heading - STATE.lastHeading;
  let dPitch = pitch - STATE.lastPitch;

  // wrap yaw delta to [-pi, pi]
  if (dHeading > Math.PI) dHeading -= Math.PI * 2;
  if (dHeading < -Math.PI) dHeading += Math.PI * 2;

  STATE.lastHeading = heading;
  STATE.lastPitch = pitch;

  // movement magnitude (prefer physics velocity if available)
  let speed = 0;
  try {
    const body = noa.entities.getPhysicsBody(noa.playerEntity);
    const v = body?.velocity;
    if (v) speed = Math.sqrt(v[0] * v[0] + v[2] * v[2]);
  } catch {}

  // fallback speed from position diff
  if (!speed) {
    try {
      const p = noa.entities.getPosition(noa.playerEntity);
      if (p) {
        if (STATE.lastPlayerPos) {
          const dx = p[0] - STATE.lastPlayerPos[0];
          const dz = p[2] - STATE.lastPlayerPos[2];
          const dist = Math.sqrt(dx * dx + dz * dz);
          speed = dist / Math.max(dt, 0.0001);
        }
        STATE.lastPlayerPos = [p[0], p[1], p[2]];
      }
    } catch {}
  }

  // bobbing
  const bobSpeed = clamp(speed * 6, 0, 10);
  STATE.bobPhase += bobSpeed * dt;
  const bob = Math.sin(STATE.bobPhase) * 0.03;
  const bob2 = Math.sin(STATE.bobPhase * 2) * 0.02;

  // sway from mouse deltas
  const swayX = clamp(-dHeading * 1.8, -0.08, 0.08);
  const swayY = clamp(dPitch * 1.2, -0.06, 0.06);

  // settle smooth
  const targetPos = new BABYLON.Vector3(swayX, -0.02 + bob, 0.0);
  const targetRot = new BABYLON.Vector3(swayY + bob2 * 0.25, swayX * 0.8, swayX * 0.6);

  const wr = MESH.weaponRoot;

  wr.position.x = lerp(wr.position.x, targetPos.x, clamp(dt * 10, 0, 1));
  wr.position.y = lerp(wr.position.y, targetPos.y, clamp(dt * 10, 0, 1));
  wr.position.z = lerp(wr.position.z, targetPos.z, clamp(dt * 10, 0, 1));

  wr.rotation.x = lerp(wr.rotation.x, targetRot.x, clamp(dt * 10, 0, 1));
  wr.rotation.y = lerp(wr.rotation.y, targetRot.y, clamp(dt * 10, 0, 1));
  wr.rotation.z = lerp(wr.rotation.z, targetRot.z, clamp(dt * 10, 0, 1));
}

/* ============================================================
 * Third-person avatar update
 * ============================================================
 */

function updateAvatar(dt) {
  if (viewMode !== 1) return;
  if (!MESH.avatarRoot) return;

  // position avatar at player position
  try {
    const p = noa.entities.getPosition(noa.playerEntity);
    if (p && p.length >= 3) {
      // lift by ~half height so it sits on ground nicely
      MESH.avatarRoot.position.set(p[0], p[1] + 0.9, p[2]);
    }
  } catch {}

  // rotate avatar with heading (yaw)
  try {
    const yaw = safeNum(noa.camera.heading, 0);
    // Babylon uses rotation.y for yaw
    MESH.avatarRoot.rotation.y = yaw;
  } catch {}
}

/* ============================================================
 * Debug frontCube update
 * ============================================================
 */

function updateFrontCube() {
  if (!showDebugProof) return;
  if (!MESH.frontCube) return;
  const scene = STATE.scene;
  const cam = scene?.activeCamera;
  if (!cam) return;

  let fwd = null;
  try {
    if (typeof cam.getForwardRay === "function") fwd = cam.getForwardRay(1).direction;
    else if (typeof cam.getDirection === "function") fwd = cam.getDirection(new BABYLON.Vector3(0, 0, 1));
  } catch {}

  if (!fwd) {
    MESH.frontCube.position.copyFrom(cam.position);
    MESH.frontCube.position.z += 2;
  } else {
    const pos = cam.position.add(fwd.scale(3));
    MESH.frontCube.position.copyFrom(pos);
  }
}

/* ============================================================
 * Main loop hooks
 * ============================================================
 */

(function bootCore() {
  let tries = 0;
  const t = setInterval(() => {
    tries++;

    if (ensureSceneReadyOnce()) {
      initFpsRigOnce();
      initAvatarOnce();
      initDebugProofMeshesOnce();
      applyViewMode(); // ensures correct visibility at startup
      clearInterval(t);
      console.log("[Boot] core initialized");
    } else if (tries > 200) {
      clearInterval(t);
      console.warn("[Boot] failed to resolve scene after retries.");
    }
  }, 100);
})();

noa.on("beforeRender", function () {
  const now = performance.now();
  const dt = clamp((now - STATE.lastTime) / 1000, 0, 0.05);
  STATE.lastTime = now;

  // keep camera clipping forgiving
  try {
    const cam = STATE.scene?.activeCamera;
    if (cam) {
      cam.minZ = 0.05;
      if (cam.maxZ < 5000) cam.maxZ = 10000;
    }
  } catch {}

  // update debug + rigs
  updateFrontCube();
  updateFpsArms(dt);
  updateAvatar(dt);
});

/* ============================================================
 * tick: third-person zoom with scroll
 * ============================================================
 */

noa.on("tick", function () {
  // Only adjust zoom in third-person
  const scroll = noa.inputs.pointerState.scrolly;
  if (scroll !== 0 && viewMode === 1) {
    const delta = scroll > 0 ? 1 : -1;
    noa.camera.zoomDistance = clamp(noa.camera.zoomDistance + delta, 2, 12);
    noa.camera.currentZoom = noa.camera.zoomDistance;
  }
});

/* ============================================================
 * Interactivity: break / place blocks
 * ============================================================
 */

noa.inputs.down.on("fire", function () {
  if (noa.targetedBlock) {
    const pos = noa.targetedBlock.position;
    noa.setBlock(0, pos[0], pos[1], pos[2]);
  }
});

noa.inputs.down.on("alt-fire", function () {
  if (noa.targetedBlock) {
    const pos = noa.targetedBlock.adjacent;
    noa.setBlock(grassID, pos[0], pos[1], pos[2]);
  }
});

noa.inputs.bind("alt-fire", "KeyE");

/* ============================================================
 * Colyseus (minimal; does not affect rendering)
 * ============================================================
 */

const DEFAULT_LOCAL_ENDPOINT = "ws://localhost:2567";
const COLYSEUS_ENDPOINT =
  import.meta.env && import.meta.env.VITE_COLYSEUS_ENDPOINT ? import.meta.env.VITE_COLYSEUS_ENDPOINT : DEFAULT_LOCAL_ENDPOINT;

function toHttpEndpoint(wsEndpoint) {
  if (wsEndpoint.startsWith("wss://")) return wsEndpoint.replace("wss://", "https://");
  if (wsEndpoint.startsWith("ws://")) return wsEndpoint.replace("ws://", "http://");
  return wsEndpoint;
}

async function debugMatchmake(endpointWsOrHttp) {
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

async function connectColyseus() {
  console.log("[Colyseus] connecting to:", COLYSEUS_ENDPOINT);
  await debugMatchmake(COLYSEUS_ENDPOINT);

  try {
    const room = await colyseusClient.joinOrCreate("my_room", { name: "Steve" });
    colyRoom = room;

    console.log("[Colyseus] connected, session:", room.sessionId);

    room.onMessage("welcome", (msg) => console.log("[Colyseus] welcome:", msg));
    room.onMessage("*", (type, message) => console.log("[Colyseus] msg:", type, message));

    room.onLeave(() => {
      console.warn("[Colyseus] left");
      colyRoom = null;
    });

    // send movement (optional)
    setInterval(() => {
      if (!colyRoom) return;
      let p = [0, 10, 0];
      try {
        const pos = noa.entities.getPosition(noa.playerEntity);
        if (pos && pos.length >= 3) p = [pos[0], pos[1], pos[2]];
      } catch {}
      const yaw = safeNum(noa.camera.heading, 0);
      const pitch = safeNum(noa.camera.pitch, 0);
      colyRoom.send("move", { x: p[0], y: p[1], z: p[2], yaw, pitch });
    }, 100);
  } catch (err) {
    console.error("[Colyseus] failed:", err);
  }
}

connectColyseus();
