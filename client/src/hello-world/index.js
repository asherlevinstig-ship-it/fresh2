/*
 * Fresh2 - noa hello-world (single Babylon runtime via "babylonjs" alias)
 *
 * This version adds:
 *   ✅ Test A: force the scene clearColor to MAGENTA to prove we're editing the rendered scene
 *
 * IMPORTANT SETUP:
 * - vite.config.js:
 *     alias: { babylonjs: '@babylonjs/core/Legacy/legacy' }
 *     dedupe: ['@babylonjs/core']
 * - uninstall old UMD runtime:
 *     npm remove babylonjs
 */
console.log("=== RUNNING HELLO-WORLD INDEX.JS :: TEST-A-FORCED v1 ===");

import { Engine } from "noa-engine";
import { Client } from "@colyseus/sdk";
import * as BABYLON from "babylonjs";

/* ============================================================
 * NOA init
 * ============================================================
 */

const noa = new Engine({
  debug: true,
  showFPS: true,
  chunkSize: 32,
  chunkAddDistance: 2.5,
  chunkRemoveDistance: 3.5,
});

const noaAny = /** @type {any} */ (noa);

/* ============================================================
 * State
 * ============================================================
 */

let viewMode = 0; // 0 = first, 1 = third-back, 2 = third-front
let meshesBuilt = false;

let avatarRoot = null;
let armsRoot = null;
let diagCube = null;

/* ============================================================
 * World generation
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
        data.set(i, j, k, getVoxelID(x + i, y + j, z + k));
      }
    }
  }
  noa.world.setChunkData(id, data);
});

/* ============================================================
 * Helpers
 * ============================================================
 */

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

function getNoaScene() {
  try {
    const r = noaAny.rendering;
    if (r && typeof r.getScene === "function") return r.getScene();
  } catch {}
  return null;
}

function getNoaCamera() {
  try {
    const r = noaAny.rendering;
    return r && r.camera ? r.camera : null;
  } catch {}
  return null;
}

function getPointerLockTarget() {
  try {
    if (noaAny.container && typeof noaAny.container.querySelector === "function") {
      const canvas = noaAny.container.querySelector("canvas");
      if (canvas) return canvas;
      return noaAny.container;
    }
  } catch {}
  return document.querySelector("canvas");
}

function isPointerLockedToNoa() {
  const el = getPointerLockTarget();
  return !!(el && document.pointerLockElement === el);
}

function makeEmissiveMat(scene, name, color3) {
  const mat = new BABYLON.StandardMaterial(name, scene);
  mat.diffuseColor = color3.clone();
  mat.emissiveColor = color3.scale(0.6);
  mat.specularColor = new BABYLON.Color3(0, 0, 0);
  mat.backFaceCulling = false;
  mat.disableLighting = true;
  mat.alpha = 1;
  return mat;
}

function forceMeshVisible(mesh) {
  if (!mesh) return;
  mesh.isVisible = true;
  mesh.visibility = 1;
  mesh.setEnabled(true);
  mesh.alwaysSelectAsActiveMesh = true;

  // Render after terrain chunks (defensive)
  mesh.renderingGroupId = 2;

  // Ensure camera can see it regardless of layer mask
  mesh.layerMask = 0xFFFFFFFF;
}

/* ============================================================
 * Pointer lock click-to-lock
 * ============================================================
 */

(function enableClickToPointerLock() {
  const interval = setInterval(() => {
    const el = getPointerLockTarget();
    if (!el) return;
    clearInterval(interval);

    try {
      if (typeof el.setAttribute === "function") el.setAttribute("tabindex", "1");
      if (el.style) el.style.outline = "none";
    } catch {}

    el.addEventListener("click", () => {
      try {
        if (viewMode !== 0) return;
        if (document.pointerLockElement !== el && typeof el.requestPointerLock === "function") {
          el.requestPointerLock();
        }
      } catch (e) {
        console.warn("[PointerLock] request failed:", e);
      }
    });

    console.log("[PointerLock] handler attached");
  }, 100);
})();

/* ============================================================
 * Inputs: break / place blocks
 * ============================================================
 */

noa.inputs.bind("alt-fire", "KeyE");

// Break (LMB)
noa.inputs.down.on("fire", function () {
  if (noa.targetedBlock) {
    const pos = noa.targetedBlock.position;
    noa.setBlock(0, pos[0], pos[1], pos[2]);
  }
});

// Place (E)
noa.inputs.down.on("alt-fire", function () {
  if (noa.targetedBlock) {
    const pos = noa.targetedBlock.adjacent;
    noa.setBlock(grassID, pos[0], pos[1], pos[2]);
  }
});

/* ============================================================
 * View modes
 * ============================================================
 */

document.addEventListener("keydown", (e) => {
  if (e.code === "F5") {
    e.preventDefault();
    viewMode = (viewMode + 1) % 3;

    if (viewMode !== 0) {
      try { document.exitPointerLock?.(); } catch {}
    }

    applyViewMode();
    console.log("[View] mode:", viewMode);
  }
});

function applyViewMode() {
  const locked = isPointerLockedToNoa();
  const isFirst = viewMode === 0;

  noa.camera.zoomDistance = isFirst ? 0 : 6;

  // Avatar visible in third-person always
  if (avatarRoot) avatarRoot.setEnabled(!isFirst);

  // Arms only in first-person + locked
  const armsOn = isFirst && locked;
  if (armsRoot) armsRoot.setEnabled(armsOn);
}

/* ============================================================
 * Mesh creation
 * ============================================================
 */

function createDiagnosticCube(scene) {
  const cube = BABYLON.MeshBuilder.CreateBox("diagCube", { size: 8 }, scene);
  cube.material = makeEmissiveMat(scene, "diagCubeMat", new BABYLON.Color3(1, 0, 1)); // magenta
  cube.position.set(0, 10, 0);
  cube.isPickable = false;
  forceMeshVisible(cube);
  console.log("[Diag] Magenta cube created at (0,10,0)");
  return cube;
}

function createThirdPersonAvatar(scene) {
  const root = new BABYLON.Mesh("avatarRoot", scene);
  root.isPickable = false;
  forceMeshVisible(root);

  const matBody = makeEmissiveMat(scene, "avBodyMat", new BABYLON.Color3(0.2, 0.9, 0.2));
  const matHead = makeEmissiveMat(scene, "avHeadMat", new BABYLON.Color3(0.9, 0.85, 0.2));
  const matLimb = makeEmissiveMat(scene, "avLimbMat", new BABYLON.Color3(0.2, 0.4, 1.0));

  const head = BABYLON.MeshBuilder.CreateBox("avHead", { size: 1 }, scene);
  head.material = matHead;
  head.parent = root;
  head.position.set(0, 2.6, 0);
  forceMeshVisible(head);

  const body = BABYLON.MeshBuilder.CreateBox("avBody", { width: 1, height: 1.5, depth: 0.5 }, scene);
  body.material = matBody;
  body.parent = root;
  body.position.set(0, 1.6, 0);
  forceMeshVisible(body);

  const armR = BABYLON.MeshBuilder.CreateBox("avArmR", { width: 0.35, height: 1.2, depth: 0.35 }, scene);
  armR.material = matLimb;
  armR.parent = root;
  armR.position.set(-0.8, 1.7, 0);
  forceMeshVisible(armR);

  const armL = BABYLON.MeshBuilder.CreateBox("avArmL", { width: 0.35, height: 1.2, depth: 0.35 }, scene);
  armL.material = matLimb;
  armL.parent = root;
  armL.position.set(0.8, 1.7, 0);
  forceMeshVisible(armL);

  const legR = BABYLON.MeshBuilder.CreateBox("avLegR", { width: 0.4, height: 1.2, depth: 0.4 }, scene);
  legR.material = matLimb;
  legR.parent = root;
  legR.position.set(-0.25, 0.6, 0);
  forceMeshVisible(legR);

  const legL = BABYLON.MeshBuilder.CreateBox("avLegL", { width: 0.4, height: 1.2, depth: 0.4 }, scene);
  legL.material = matLimb;
  legL.parent = root;
  legL.position.set(0.25, 0.6, 0);
  forceMeshVisible(legL);

  // Start enabled (we may still disable in applyViewMode)
  root.setEnabled(true);

  console.log("[Avatar] created (solid color)");
  return root;
}

function createFirstPersonArms(scene) {
  const root = new BABYLON.Mesh("armsRoot", scene);
  root.isPickable = false;
  forceMeshVisible(root);

  const matArms = makeEmissiveMat(scene, "fpArmsMat", new BABYLON.Color3(1.0, 0.1, 0.1));

  const armR = BABYLON.MeshBuilder.CreateBox("fpArmR", { width: 0.25, height: 0.8, depth: 0.25 }, scene);
  armR.material = matArms;
  armR.parent = root;
  armR.position.set(0.35, -0.25, 0.8);
  armR.rotation.set(0.15, 0.2, 0.15);
  forceMeshVisible(armR);

  const armL = BABYLON.MeshBuilder.CreateBox("fpArmL", { width: 0.25, height: 0.8, depth: 0.25 }, scene);
  armL.material = matArms;
  armL.parent = root;
  armL.position.set(-0.35, -0.3, 0.75);
  armL.rotation.set(0.05, -0.2, -0.05);
  forceMeshVisible(armL);

  console.log("[FPArms] created (solid color)");
  return root;
}

/* ============================================================
 * Update transforms
 * ============================================================
 */

function getPlayerPosition() {
  try {
    const p = noa.entities.getPosition(noa.playerEntity);
    if (p && p.length >= 3) return [p[0], p[1], p[2]];
  } catch {}
  return [0, 10, 0];
}

function updateAvatarFollowPlayer() {
  if (!avatarRoot) return;

  const [x, y, z] = getPlayerPosition();
  avatarRoot.position.set(x, y, z);
  forceMeshVisible(avatarRoot);
}

function updateArmsFollowCamera(cam) {
  if (!armsRoot || !armsRoot.isEnabled()) return;

  try {
    const dist = 0.7;
    const ray = cam.getForwardRay(dist);
    const p = ray.origin.add(ray.direction.scale(dist));

    const right = cam.getDirection(new BABYLON.Vector3(1, 0, 0)).scale(0.15);
    const down = cam.getDirection(new BABYLON.Vector3(0, -1, 0)).scale(0.18);

    armsRoot.position.copyFrom(p.add(right).add(down));

    if (cam.rotationQuaternion) {
      armsRoot.rotationQuaternion = cam.rotationQuaternion.clone();
    } else {
      armsRoot.rotationQuaternion = null;
      armsRoot.rotation.copyFrom(cam.rotation);
    }

    forceMeshVisible(armsRoot);
  } catch (e) {
    console.warn("[FPArms] update failed:", e);
  }
}

/* ============================================================
 * Build meshes once scene exists (includes TEST A)
 * ============================================================
 */

function ensureMeshes() {
  if (meshesBuilt) return;

  const scene = getNoaScene();
  const cam = getNoaCamera();
  if (!scene || !cam) return;

  console.log(
    "[Babylon] imported Engine.Version:",
    BABYLON.Engine && BABYLON.Engine.Version ? BABYLON.Engine.Version : "(unknown)"
  );
  console.log(
    "[NOA] scene exists?",
    !!scene,
    "camera exists?",
    !!cam,
    "cameraType:",
    cam && cam.getClassName ? cam.getClassName() : "(unknown)"
  );

  // TEST A: if you do NOT see a magenta background, you're not editing the rendered scene.
  try {
    scene.clearColor = new BABYLON.Color4(1, 0, 1, 1);
    console.log("[Diag][TestA] set scene.clearColor = magenta");
  } catch (e) {
    console.warn("[Diag][TestA] failed to set clearColor:", e);
  }

  // Defensive camera settings
  try {
    if (scene.activeCamera) {
      scene.activeCamera.layerMask = 0xFFFFFFFF;
      scene.activeCamera.minZ = 0.01;
      scene.activeCamera.maxZ = 5000;
    }
  } catch {}

  diagCube = createDiagnosticCube(scene);
  avatarRoot = createThirdPersonAvatar(scene);
  armsRoot = createFirstPersonArms(scene);

  applyViewMode();
  document.addEventListener("pointerlockchange", applyViewMode);

  meshesBuilt = true;
}

/* ============================================================
 * Main loops
 * ============================================================
 */

noa.on("tick", function () {
  // Third-person scroll zoom
  const scroll = noa.inputs.pointerState.scrolly;
  if (scroll !== 0 && viewMode !== 0) {
    noa.camera.zoomDistance += scroll > 0 ? 1 : -1;
    noa.camera.zoomDistance = clamp(noa.camera.zoomDistance, 2, 12);
  }
});

noa.on("beforeRender", function () {
  ensureMeshes();

  const scene = getNoaScene();
  const cam = getNoaCamera();
  if (!scene || !cam) return;

  // Keep camera layer mask wide open
  try {
    if (scene.activeCamera) scene.activeCamera.layerMask = 0xFFFFFFFF;
  } catch {}

  // Avatar follows player
  updateAvatarFollowPlayer();

  // Arms follow camera
  updateArmsFollowCamera(cam);
});

/* ============================================================
 * Colyseus (minimal)
 * ============================================================
 */

const DEFAULT_LOCAL_ENDPOINT = "ws://localhost:2567";
const COLYSEUS_ENDPOINT =
  import.meta.env && import.meta.env.VITE_COLYSEUS_ENDPOINT
    ? import.meta.env.VITE_COLYSEUS_ENDPOINT
    : DEFAULT_LOCAL_ENDPOINT;

const colyseusClient = new Client(COLYSEUS_ENDPOINT);

function toHttpEndpoint(wsEndpoint) {
  if (typeof wsEndpoint !== "string") return wsEndpoint;
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
    console.warn("[Colyseus][debug] GET /hi failed:", e);
  }
}

(async function connectColyseus() {
  console.log("[Colyseus] connecting to:", COLYSEUS_ENDPOINT);
  await debugMatchmake(COLYSEUS_ENDPOINT);

  try {
    const room = await colyseusClient.joinOrCreate("my_room", { name: "Steve" });
    console.log("[Colyseus] connected, session:", room.sessionId);
    room.onLeave(() => console.warn("[Colyseus] left"));
  } catch (e) {
    console.warn("[Colyseus] connect failed (ok for now):", e);
  }
})();
console.log("=== HELLO-WORLD INDEX.JS LOADED :: TEST-A v1 ===");
