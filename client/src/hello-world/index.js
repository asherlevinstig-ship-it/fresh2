/*
 * Fresh2 - noa hello-world (single Babylon runtime + blocks + visible avatar/arms)
 *
 * Requirements:
 * - Use Babylon 6 ONLY via @babylonjs/core
 * - Ensure `babylonjs` (UMD) is NOT installed
 *
 * Features:
 * - Break blocks (LMB / "fire")
 * - Place blocks (E / "alt-fire")
 * - Pointer lock click-to-lock
 * - F5 cycles view: first-person -> third-back -> third-front
 * - First-person arms visible when pointer locked in first-person
 * - Third-person avatar visible in third-person modes
 */

import { Engine } from "noa-engine";
import { Client } from "@colyseus/sdk";

import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";

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
    const r = /** @type {any} */ (noa).rendering;
    return r && typeof r.getScene === "function" ? r.getScene() : null;
  } catch {
    return null;
  }
}

function getNoaCamera() {
  try {
    const r = /** @type {any} */ (noa).rendering;
    return r && r.camera ? r.camera : null;
  } catch {
    return null;
  }
}

function getPointerLockTarget() {
  // noa.container is usually a div; canvas is inside it
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

(function enableClickToPointerLock() {
  const interval = setInterval(() => {
    const el = getPointerLockTarget();
    if (!el) return;

    clearInterval(interval);

    // Make focusable
    try {
      if (typeof el.setAttribute === "function") el.setAttribute("tabindex", "1");
      if (el.style) el.style.outline = "none";
    } catch {}

    el.addEventListener("click", () => {
      try {
        if (viewMode !== 0) return; // only lock in first-person
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
 * Input bindings: break/place blocks
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
 * View modes + camera zoom
 * ============================================================
 */

let viewMode = 0; // 0 = first, 1 = third-back, 2 = third-front

document.addEventListener("keydown", (e) => {
  if (e.code === "F5") {
    e.preventDefault();
    viewMode = (viewMode + 1) % 3;

    // leave pointer lock when leaving first person
    if (viewMode !== 0) {
      try {
        document.exitPointerLock?.();
      } catch {}
    }

    applyViewMode();
    console.log("[View] mode:", viewMode);
  }
});

function applyViewMode() {
  const locked = isPointerLockedToNoa();
  const isFirst = viewMode === 0;

  // NOA camera zoom controls third-person distance
  noa.camera.zoomDistance = isFirst ? 0 : 6;

  // Avatar visible only in third person
  if (avatarRoot) avatarRoot.setEnabled(!isFirst);

  // Arms visible only in first person AND pointer locked
  const armsOn = isFirst && locked;
  if (fpArmsRoot) fpArmsRoot.setEnabled(armsOn);
}

/* ============================================================
 * Simple avatar (third-person) + arms (first-person)
 * ============================================================
 * We intentionally use simple colored boxes first:
 * - proves visibility & transform are correct
 * - avoids texture/UV/alpha issues
 */

let avatarRoot = null;
let fpArmsRoot = null;

function createMat(scene, name, color) {
  const mat = new StandardMaterial(name, scene);
  mat.diffuseColor = color;
  mat.emissiveColor = color.scale(0.25);
  mat.specularColor = new Color3(0, 0, 0);
  mat.backFaceCulling = false;
  mat.alpha = 1;
  return mat;
}

function createThirdPersonAvatar(scene) {
  const root = new Mesh("avatarRoot", scene);
  root.isPickable = false;
  root.alwaysSelectAsActiveMesh = true;
  root.setEnabled(false); // starts hidden (first person)

  const matBody = createMat(scene, "matBody", new Color3(0.2, 0.8, 0.3)); // green-ish
  const matHead = createMat(scene, "matHead", new Color3(0.9, 0.8, 0.2)); // yellow-ish
  const matLimb = createMat(scene, "matLimb", new Color3(0.2, 0.4, 1.0)); // blue-ish

  const head = MeshBuilder.CreateBox("head", { size: 1 }, scene);
  head.material = matHead;
  head.parent = root;

  const body = MeshBuilder.CreateBox("body", { width: 1, height: 1.5, depth: 0.5 }, scene);
  body.material = matBody;
  body.parent = root;

  const armR = MeshBuilder.CreateBox("armR", { width: 0.35, height: 1.2, depth: 0.35 }, scene);
  armR.material = matLimb;
  armR.parent = root;

  const armL = MeshBuilder.CreateBox("armL", { width: 0.35, height: 1.2, depth: 0.35 }, scene);
  armL.material = matLimb;
  armL.parent = root;

  const legR = MeshBuilder.CreateBox("legR", { width: 0.4, height: 1.2, depth: 0.4 }, scene);
  legR.material = matLimb;
  legR.parent = root;

  const legL = MeshBuilder.CreateBox("legL", { width: 0.4, height: 1.2, depth: 0.4 }, scene);
  legL.material = matLimb;
  legL.parent = root;

  // Position parts relative to root
  const legY = 0.6;
  legR.position.set(-0.25, legY, 0);
  legL.position.set(0.25, legY, 0);

  const bodyY = 1.2 + 0.75;
  body.position.set(0, bodyY, 0);

  const headY = bodyY + 0.75 + 0.5;
  head.position.set(0, headY, 0);

  const armY = bodyY + 0.35;
  armR.position.set(-0.8, armY, 0);
  armL.position.set(0.8, armY, 0);

  console.log("[Avatar] created (solid color)");
  return root;
}

function createFirstPersonArms(scene) {
  const root = new Mesh("fpArmsRoot", scene);
  root.isPickable = false;
  root.alwaysSelectAsActiveMesh = true;
  root.setEnabled(false);

  const matArm = createMat(scene, "matFPArm", new Color3(1, 0.1, 0.1)); // red

  const armR = MeshBuilder.CreateBox("fpArmR", { width: 0.25, height: 0.8, depth: 0.25 }, scene);
  armR.material = matArm;
  armR.parent = root;

  const armL = MeshBuilder.CreateBox("fpArmL", { width: 0.25, height: 0.8, depth: 0.25 }, scene);
  armL.material = matArm;
  armL.parent = root;

  // Local offsets relative to root
  armR.position.set(0.35, -0.25, 0.8);
  armL.position.set(-0.35, -0.30, 0.75);

  armR.rotation.set(0.15, 0.2, 0.15);
  armL.rotation.set(0.05, -0.2, -0.05);

  console.log("[FPArms] created (solid color)");
  return root;
}

/* ============================================================
 * Attach avatar to NOA player entity + update arms transform
 * ============================================================
 */

let attached = false;

function attachOnce() {
  if (attached) return;
  const scene = getNoaScene();
  if (!scene) return;

  // Build meshes
  avatarRoot = createThirdPersonAvatar(scene);
  fpArmsRoot = createFirstPersonArms(scene);

  // Attach avatar root to player entity via NOA mesh component
  try {
    const entities = /** @type {any} */ (noa).entities;
    const player = noa.playerEntity;

    const meshCompName = (entities && entities.names && entities.names.mesh) ? entities.names.mesh : "mesh";

    const hasComp = entities && entities.hasComponent ? entities.hasComponent.bind(entities) : null;
    const addComp = entities && entities.addComponent ? entities.addComponent.bind(entities) : null;

    if (addComp) {
      if (!hasComp || !hasComp(player, meshCompName)) {
        addComp(player, meshCompName, {
          mesh: avatarRoot,
          offset: [0, 0, 0],
        });
        console.log("[Avatar] attached to player entity");
      } else {
        console.log("[Avatar] already attached (mesh component exists)");
      }
    } else {
      console.warn("[Avatar] entities.addComponent not found");
    }
  } catch (e) {
    console.warn("[Avatar] attach failed:", e);
  }

  // Apply initial view mode
  applyViewMode();

  // Re-apply when pointer lock changes
  document.addEventListener("pointerlockchange", applyViewMode);

  attached = true;
}

/* ============================================================
 * Arms positioning update (camera-relative, NO parenting)
 * ============================================================
 */

function updateArmsPosition() {
  if (!fpArmsRoot || !fpArmsRoot.isEnabled()) return;

  const scene = getNoaScene();
  const cam = getNoaCamera();
  if (!scene || !cam) return;

  // Use camera forward ray to get a point in front of camera (runtime-native vectors)
  try {
    const dist = 0.6;
    const ray = cam.getForwardRay(dist);
    const fwdPoint = ray.origin.add(ray.direction.scale(dist));

    // Approx right + down offsets using camera directions
    const right = cam.getDirection(new Vector3(1, 0, 0)).scale(0.15);
    const down = cam.getDirection(new Vector3(0, -1, 0)).scale(0.18);

    fpArmsRoot.position.copyFrom(fwdPoint.add(right).add(down));

    // Match camera rotation
    fpArmsRoot.rotationQuaternion = cam.rotationQuaternion ? cam.rotationQuaternion.clone() : null;
    if (!fpArmsRoot.rotationQuaternion) {
      // fallback: copy Euler if no quaternion
      fpArmsRoot.rotation.copyFrom(cam.rotation);
    }
  } catch (e) {
    console.warn("[FPArms] update failed:", e);
  }
}

/* ============================================================
 * Main loop hooks
 * ============================================================
 */

noa.on("tick", function () {
  // Scroll zoom for third person
  const scroll = noa.inputs.pointerState.scrolly;
  if (scroll !== 0 && viewMode !== 0) {
    noa.camera.zoomDistance += scroll > 0 ? 1 : -1;
    noa.camera.zoomDistance = clamp(noa.camera.zoomDistance, 2, 12);
  }
});

noa.on("beforeRender", function () {
  // Attach once we have a valid scene
  attachOnce();

  // Update arms (if enabled)
  updateArmsPosition();
});

/* ============================================================
 * Colyseus (optional - minimal)
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
