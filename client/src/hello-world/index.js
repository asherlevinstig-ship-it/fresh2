/*
 * Fresh2 - NOA + Babylon DIAGNOSTIC (use NOA's Babylon runtime via globalThis.BABYLON)
 *
 * Why:
 * - If you import Babylon yourself, you can still end up with a different runtime instance.
 * - This file uses globalThis.BABYLON so meshes are created inside the same Babylon runtime NOA is rendering with.
 *
 * Includes:
 * - Break blocks (LMB) + Place blocks (E)
 * - Pointer lock click-to-lock in first person
 * - F5 view toggle (first/third)
 * - HARD diagnostics:
 *     1) Huge glowing world box at (0,10,0)
 *     2) Glowing ball pinned in front of camera every frame
 *     3) Visibility/frustum/scene-mesh-list logging
 */

import { Engine } from "noa-engine";
import { Client } from "@colyseus/sdk";

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

/* ============================================================
 * World
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
    const r = /** @type {any} */ (noa).rendering;
    if (r && typeof r.getScene === "function") return r.getScene();
  } catch {}
  return null;
}

function getNoaCamera() {
  try {
    const r = /** @type {any} */ (noa).rendering;
    return r && r.camera ? r.camera : null;
  } catch {}
  return null;
}

function getPointerLockTarget() {
  const n = /** @type {any} */ (noa);
  if (n && n.container && typeof n.container.querySelector === "function") {
    const canvas = n.container.querySelector("canvas");
    if (canvas) return canvas;
    return n.container;
  }
  return document.querySelector("canvas");
}

function isPointerLockedToNoa() {
  const el = getPointerLockTarget();
  return !!(el && document.pointerLockElement === el);
}

/* ============================================================
 * Pointer lock click-to-lock
 * ============================================================
 */

let viewMode = 0; // 0=first, 1=third-back, 2=third-front

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
 * Inputs: break/place blocks
 * ============================================================
 */

noa.inputs.bind("alt-fire", "KeyE");

// Break
noa.inputs.down.on("fire", function () {
  if (noa.targetedBlock) {
    const pos = noa.targetedBlock.position;
    noa.setBlock(0, pos[0], pos[1], pos[2]);
  }
});

// Place
noa.inputs.down.on("alt-fire", function () {
  if (noa.targetedBlock) {
    const pos = noa.targetedBlock.adjacent;
    noa.setBlock(grassID, pos[0], pos[1], pos[2]);
  }
});

/* ============================================================
 * View toggle
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

  if (avatarRoot) avatarRoot.setEnabled(!isFirst);

  const armsOn = isFirst && locked;
  if (armsRoot) armsRoot.setEnabled(armsOn);
}

/* ============================================================
 * Babylon runtime selection (MOST IMPORTANT PART)
 * ============================================================
 */

function getBabylonRuntime() {
  const B = /** @type {any} */ (globalThis).BABYLON;
  return B || null;
}

/* ============================================================
 * HARD DIAGNOSTIC MESHES
 * ============================================================
 */

let diagWorldBox = null;
let diagPinnedBall = null;

function makeEmissiveMat(B, scene, name, r, g, b) {
  const mat = new B.StandardMaterial(name, scene);
  mat.diffuseColor = new B.Color3(r, g, b);
  mat.emissiveColor = new B.Color3(r * 0.7, g * 0.7, b * 0.7);
  mat.specularColor = new B.Color3(0, 0, 0);
  mat.backFaceCulling = false;
  mat.disableLighting = true;
  mat.alpha = 1;
  return mat;
}

function ensureDiagnostics(scene, cam) {
  const B = getBabylonRuntime();
  if (!B) {
    console.error("[Diag] globalThis.BABYLON is missing. That means NOA's Babylon isn't exposed globally.");
    console.error("[Diag] In that case we must obtain Babylon constructors from NOA internals (different approach).");
    return;
  }

  // unfreeze if anything froze active meshes
  try {
    if (typeof scene.unfreezeActiveMeshes === "function") scene.unfreezeActiveMeshes();
    scene.freezeActiveMeshes = false;
  } catch {}

  // make camera clip planes generous
  try {
    if (scene.activeCamera) {
      scene.activeCamera.minZ = 0.01;
      scene.activeCamera.maxZ = 5000;
    }
  } catch {}

  // 1) Big world box at a known point
  if (!diagWorldBox) {
    diagWorldBox = B.MeshBuilder.CreateBox("diagWorldBox", { size: 6 }, scene);
    diagWorldBox.material = makeEmissiveMat(B, scene, "diagWorldBoxMat", 1, 0, 1); // magenta
    diagWorldBox.position.set(0, 10, 0);
    diagWorldBox.isPickable = false;
    diagWorldBox.isVisible = true;
    diagWorldBox.visibility = 1;
    diagWorldBox.setEnabled(true);
    diagWorldBox.alwaysSelectAsActiveMesh = true;
    diagWorldBox.layerMask = 0x0fffffff;
    diagWorldBox.renderingGroupId = 0;

    console.log("[Diag] World box created at (0,10,0). If you can't see THIS, custom meshes are not rendering.");
  }

  // 2) Pinned ball in front of camera
  if (!diagPinnedBall) {
    diagPinnedBall = B.MeshBuilder.CreateSphere("diagPinnedBall", { diameter: 2.5 }, scene);
    diagPinnedBall.material = makeEmissiveMat(B, scene, "diagPinnedBallMat", 0, 1, 1); // cyan
    diagPinnedBall.isPickable = false;
    diagPinnedBall.isVisible = true;
    diagPinnedBall.visibility = 1;
    diagPinnedBall.setEnabled(true);
    diagPinnedBall.alwaysSelectAsActiveMesh = true;
    diagPinnedBall.layerMask = 0x0fffffff;
    diagPinnedBall.renderingGroupId = 0;

    console.log("[Diag] Pinned ball created (should sit in front of camera).");
  }

  // pin the ball using camera forward ray (runtime-native)
  try {
    const ray = cam.getForwardRay(6);
    const p = ray.origin.add(ray.direction.scale(6));
    diagPinnedBall.position.copyFrom(p);
  } catch (e) {
    console.warn("[Diag] pinning ball failed:", e);
  }

  // periodic status log
  if (Math.random() < 0.02) {
    try {
      const meshes = scene.meshes || [];
      const hasBox = meshes.indexOf(diagWorldBox) >= 0;
      const hasBall = meshes.indexOf(diagPinnedBall) >= 0;
      const inFrustum = scene.activeCamera ? scene.activeCamera.isInFrustum(diagPinnedBall) : "(no activeCamera)";
      console.log("[Diag] scene.meshes contains box?", hasBox, "ball?", hasBall, "ball in frustum?", inFrustum);
    } catch {}
  }
}

/* ============================================================
 * SIMPLE ARMS + AVATAR (only after diag meshes exist)
 * ============================================================
 */

let avatarRoot = null;
let armsRoot = null;

function ensureAvatarAndArms(scene) {
  const B = getBabylonRuntime();
  if (!B) return;

  if (!avatarRoot) {
    avatarRoot = new B.Mesh("avatarRoot", scene);
    avatarRoot.isPickable = false;
    avatarRoot.alwaysSelectAsActiveMesh = true;
    avatarRoot.setEnabled(false);

    const matBody = makeEmissiveMat(B, scene, "avBody", 0.2, 0.9, 0.2);
    const matHead = makeEmissiveMat(B, scene, "avHead", 0.9, 0.9, 0.2);
    const matLimb = makeEmissiveMat(B, scene, "avLimb", 0.2, 0.4, 1.0);

    const head = B.MeshBuilder.CreateBox("avHeadMesh", { size: 1 }, scene);
    head.material = matHead;
    head.parent = avatarRoot;
    head.position.set(0, 2.6, 0);

    const body = B.MeshBuilder.CreateBox("avBodyMesh", { width: 1, height: 1.5, depth: 0.5 }, scene);
    body.material = matBody;
    body.parent = avatarRoot;
    body.position.set(0, 1.6, 0);

    const armR = B.MeshBuilder.CreateBox("avArmR", { width: 0.35, height: 1.2, depth: 0.35 }, scene);
    armR.material = matLimb;
    armR.parent = avatarRoot;
    armR.position.set(-0.8, 1.7, 0);

    const armL = B.MeshBuilder.CreateBox("avArmL", { width: 0.35, height: 1.2, depth: 0.35 }, scene);
    armL.material = matLimb;
    armL.parent = avatarRoot;
    armL.position.set(0.8, 1.7, 0);

    const legR = B.MeshBuilder.CreateBox("avLegR", { width: 0.4, height: 1.2, depth: 0.4 }, scene);
    legR.material = matLimb;
    legR.parent = avatarRoot;
    legR.position.set(-0.25, 0.6, 0);

    const legL = B.MeshBuilder.CreateBox("avLegL", { width: 0.4, height: 1.2, depth: 0.4 }, scene);
    legL.material = matLimb;
    legL.parent = avatarRoot;
    legL.position.set(0.25, 0.6, 0);

    console.log("[Avatar] created (global BABYLON runtime).");
  }

  if (!armsRoot) {
    armsRoot = new B.Mesh("armsRoot", scene);
    armsRoot.isPickable = false;
    armsRoot.alwaysSelectAsActiveMesh = true;
    armsRoot.setEnabled(false);

    const matArms = makeEmissiveMat(B, scene, "fpArmsMat", 1, 0.1, 0.1);

    const armR = B.MeshBuilder.CreateBox("fpArmR", { width: 0.25, height: 0.8, depth: 0.25 }, scene);
    armR.material = matArms;
    armR.parent = armsRoot;
    armR.position.set(0.35, -0.25, 0.8);

    const armL = B.MeshBuilder.CreateBox("fpArmL", { width: 0.25, height: 0.8, depth: 0.25 }, scene);
    armL.material = matArms;
    armL.parent = armsRoot;
    armL.position.set(-0.35, -0.3, 0.75);

    armR.rotation.set(0.15, 0.2, 0.15);
    armL.rotation.set(0.05, -0.2, -0.05);

    console.log("[FPArms] created (global BABYLON runtime).");
  }
}

function updateArms(scene, cam) {
  const B = getBabylonRuntime();
  if (!B) return;
  if (!armsRoot || !armsRoot.isEnabled()) return;

  try {
    const ray = cam.getForwardRay(0.7);
    const p = ray.origin.add(ray.direction.scale(0.7));

    // add slight right+down offsets in camera space
    const right = cam.getDirection(new B.Vector3(1, 0, 0)).scale(0.15);
    const down = cam.getDirection(new B.Vector3(0, -1, 0)).scale(0.18);

    armsRoot.position.copyFrom(p.add(right).add(down));

    if (cam.rotationQuaternion) {
      armsRoot.rotationQuaternion = cam.rotationQuaternion.clone();
    } else {
      armsRoot.rotationQuaternion = null;
      armsRoot.rotation.copyFrom(cam.rotation);
    }
  } catch (e) {
    console.warn("[FPArms] update failed:", e);
  }
}

/* ============================================================
 * Attach avatar to player entity (NOA mesh component)
 * ============================================================
 */

let attached = false;

function attachAvatarToPlayerOnce() {
  if (attached) return;
  if (!avatarRoot) return;

  try {
    const entities = /** @type {any} */ (noa).entities;
    const player = noa.playerEntity;

    const meshCompName = (entities && entities.names && entities.names.mesh) ? entities.names.mesh : "mesh";

    if (entities && typeof entities.addComponent === "function") {
      if (!entities.hasComponent || !entities.hasComponent(player, meshCompName)) {
        entities.addComponent(player, meshCompName, {
          mesh: avatarRoot,
          offset: [0, 0, 0],
        });
        console.log("[Avatar] attached to player entity via NOA mesh component");
      } else {
        console.log("[Avatar] mesh component already exists on player");
      }
    } else {
      console.warn("[Avatar] entities.addComponent not found (NOA API mismatch)");
    }
  } catch (e) {
    console.warn("[Avatar] attach failed:", e);
  }

  attached = true;
}

/* ============================================================
 * Main hooks
 * ============================================================
 */

noa.on("tick", function () {
  // third-person zoom scroll
  const scroll = noa.inputs.pointerState.scrolly;
  if (scroll !== 0 && viewMode !== 0) {
    noa.camera.zoomDistance += scroll > 0 ? 1 : -1;
    noa.camera.zoomDistance = clamp(noa.camera.zoomDistance, 2, 12);
  }
});

noa.on("beforeRender", function () {
  const scene = getNoaScene();
  const cam = getNoaCamera();
  if (!scene || !cam) return;

  // Ensure diagnostics exist and are updated
  ensureDiagnostics(scene, cam);

  // Create avatar/arms and attach
  ensureAvatarAndArms(scene);
  attachAvatarToPlayerOnce();

  // Apply view mode logic continuously (handles pointerlock change)
  applyViewMode();

  // Update first-person arms transform
  updateArms(scene, cam);
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
