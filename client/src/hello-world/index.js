/*
 * Fresh2 - noa hello-world (main game entry) - VISIBILITY FIX v6
 *
 * Fixes:
 * - Place proofPlane / arms using activeCamera forward vector (works in RH or LH)
 * - Also place a "frontCube" directly in front of camera in WORLD space (cannot miss)
 * - Third-person avatar follows player (simple emissive cube)
 * - Crosshair + pointer lock
 */

import { Engine } from "noa-engine";
import { Client } from "@colyseus/sdk";
import * as BABYLON from "@babylonjs/core";

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

let viewMode = 0; // 0 first, 1 third
let forceCrosshair = false;

let inited = false;

let proofPlane = null;  // camera-facing proof plane (should appear dead center)
let fpArmsMesh = null;  // first person arms (simple box)
let frontCube = null;   // world-space cube placed in front of camera each frame
let avatarCube = null;  // third-person avatar cube

let frameCounter = 0;

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

function getNoaScene() {
  try { return noa.rendering.getScene(); } catch { return null; }
}

function getActiveCamera(scene) {
  if (!scene) return null;
  return scene.activeCamera || null;
}

function makeEmissiveMat(scene, name, color3) {
  const mat = new BABYLON.StandardMaterial(name, scene);
  mat.emissiveColor = color3;
  mat.diffuseColor = color3;
  mat.specularColor = new BABYLON.Color3(0, 0, 0);
  mat.disableLighting = true;
  return mat;
}

function forceMeshVisible(mesh) {
  mesh.isVisible = true;
  mesh.setEnabled(true);
  mesh.isPickable = false;
  mesh.alwaysSelectAsActiveMesh = true;
  mesh.visibility = 1;
  mesh.layerMask = 0xFFFFFFFF;
  mesh.renderingGroupId = 0;
}

/**
 * Return a normalized WORLD forward vector for the camera.
 * This works for RH and LH scenes because it uses Babylon's direction transform.
 */
function getCameraForwardWorld(cam) {
  // Axis.Z is "forward" in Babylon's convention for direction transforms.
  const fwd = cam.getDirection(BABYLON.Axis.Z);
  // normalize defensively
  const len = Math.sqrt(fwd.x * fwd.x + fwd.y * fwd.y + fwd.z * fwd.z) || 1;
  return new BABYLON.Vector3(fwd.x / len, fwd.y / len, fwd.z / len);
}

/* ============================================================
 * Pointer lock target
 * ============================================================
 */

function getPointerLockElement() {
  const c = /** @type {any} */ (noa && noa.container);

  if (c && typeof c === "object" && typeof c.addEventListener === "function") {
    return /** @type {HTMLElement} */ (c);
  }

  const div = document.getElementById("noa-container");
  if (div) return div;

  const canvas = document.querySelector("canvas");
  if (canvas) return /** @type {HTMLCanvasElement} */ (canvas);

  return null;
}

function isPointerLockedToNoa() {
  const el = getPointerLockElement();
  return !!(el && document.pointerLockElement === el);
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
    const show = forceCrosshair || (locked && viewMode === 0);
    crosshair.style.display = show ? "flex" : "none";
  }

  document.addEventListener("pointerlockchange", refresh);
  setInterval(refresh, 250);

  return { refresh };
}

const crosshairUI = createCrosshairOverlay();

/* ============================================================
 * Click-to-lock pointer
 * ============================================================
 */

(function enableClickToPointerLock() {
  const interval = setInterval(() => {
    const el0 = getPointerLockElement();
    if (!el0) return;
    clearInterval(interval);

    const el = /** @type {any} */ (el0);

    try {
      if (typeof el.hasAttribute === "function" && typeof el.setAttribute === "function") {
        if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "1");
      }
      if (el.style) el.style.outline = "none";
    } catch {}

    el.addEventListener("click", () => {
      try {
        if (viewMode !== 0) return;
        if (document.pointerLockElement !== el) el.requestPointerLock?.();
      } catch (e) {
        console.warn("[PointerLock] failed:", e);
      }
    });

    console.log("[PointerLock] handler attached");
  }, 100);
})();

/* ============================================================
 * Key handlers
 * ============================================================
 */

function applyViewMode() {
  const locked = isPointerLockedToNoa();
  const isFirst = viewMode === 0;

  noa.camera.zoomDistance = isFirst ? 0 : 6;

  if (avatarCube) avatarCube.setEnabled(!isFirst);
  if (fpArmsMesh) fpArmsMesh.setEnabled(isFirst && locked);

  console.log(
    "[applyViewMode] viewMode:",
    isFirst ? "first" : "third",
    "locked:",
    locked,
    "avatar:",
    !isFirst,
    "arms:",
    !!(isFirst && locked)
  );
}

document.addEventListener("keydown", (e) => {
  if (e.code === "F5") {
    e.preventDefault();
    viewMode = viewMode === 0 ? 1 : 0;
    if (viewMode !== 0) {
      try { document.exitPointerLock?.(); } catch {}
    }
    applyViewMode();
    crosshairUI.refresh();
    console.log("[View] mode:", viewMode === 0 ? "first" : "third");
  }

  if (e.code === "F6") {
    e.preventDefault();
    forceCrosshair = !forceCrosshair;
    crosshairUI.refresh();
    console.log("[Crosshair] force:", forceCrosshair);
  }
});

document.addEventListener("pointerlockchange", () => {
  applyViewMode();
  crosshairUI.refresh();
});

/* ============================================================
 * Blocks + world gen
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
 * Player position
 * ============================================================
 */

function getLocalPlayerPosition() {
  try {
    const p = noa.entities.getPosition(noa.playerEntity);
    if (p && p.length >= 3) return [p[0], p[1], p[2]];
  } catch {}
  return [0, 10, 0];
}

function getNoaHeadingPitch() {
  const heading = safeNum(noa.camera.heading, 0);
  const pitch = safeNum(noa.camera.pitch, 0);
  return { heading, pitch };
}

/* ============================================================
 * Init visuals (PROOF + arms + avatar)
 * ============================================================
 */

function initVisualsOnce() {
  if (inited) return;
  inited = true;

  const scene = getNoaScene();
  console.log("[Babylon] imported Engine.Version:", BABYLON.Engine?.Version);

  const cam0 = scene ? getActiveCamera(scene) : null;
  console.log("[NOA] scene exists?", !!scene, "activeCamera exists?", !!cam0, "cameraType:", cam0?.getClassName?.());

  if (!scene) return;

  // Make sky magenta so we know this code is live
  scene.autoClear = true;
  scene.clearColor = new BABYLON.Color4(1, 0, 1, 1);
  console.log("[TestA] magenta clearColor set");

  // Unfreeze if needed
  try {
    const sAny = /** @type {any} */ (scene);
    console.log("[Diag] scene _activeMeshesFrozen:", !!sAny._activeMeshesFrozen);
    if (typeof scene.unfreezeActiveMeshes === "function") {
      scene.unfreezeActiveMeshes();
      console.log("[Diag] scene.unfreezeActiveMeshes() called");
    }
  } catch (e) {
    console.warn("[Diag] unfreeze probe failed:", e);
  }

  // Proof plane (bright yellow)
  proofPlane = BABYLON.MeshBuilder.CreatePlane("proofPlane", { size: 0.8 }, scene);
  const ppMat = makeEmissiveMat(scene, "ppMat", new BABYLON.Color3(1, 1, 0));
  ppMat.disableDepthWrite = true;
  proofPlane.material = ppMat;
  forceMeshVisible(proofPlane);

  // Arms mesh (skin tone)
  fpArmsMesh = BABYLON.MeshBuilder.CreateBox("fpArms", { height: 0.25, width: 0.8, depth: 0.25 }, scene);
  const armsMat = makeEmissiveMat(scene, "armsMat", new BABYLON.Color3(1.0, 0.85, 0.65));
  armsMat.disableDepthWrite = true;
  fpArmsMesh.material = armsMat;
  forceMeshVisible(fpArmsMesh);

  // World-space cube that we move in front of camera each frame (bright green)
  frontCube = BABYLON.MeshBuilder.CreateBox("frontCube", { size: 0.6 }, scene);
  frontCube.material = makeEmissiveMat(scene, "frontCubeMat", new BABYLON.Color3(0, 1, 0));
  forceMeshVisible(frontCube);
  console.log("[PROOF] frontCube created (will be moved in front of camera each frame)");

  // Third-person avatar cube (blue)
  avatarCube = BABYLON.MeshBuilder.CreateBox("avatarCube", { height: 1.8, width: 0.8, depth: 0.4 }, scene);
  avatarCube.material = makeEmissiveMat(scene, "avatarMat", new BABYLON.Color3(0.2, 0.6, 1.0));
  forceMeshVisible(avatarCube);
  console.log("[Avatar] created (manual follow)");

  applyViewMode();
}

/* ============================================================
 * Colyseus connect
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
    console.log("[Colyseus] connected, session:", room.sessionId);

    room.onMessage("welcome", (msg) => {
      console.log("[Colyseus] welcome:", msg);
    });

    initVisualsOnce();

    setInterval(() => {
      const [x, y, z] = getLocalPlayerPosition();
      const { heading, pitch } = getNoaHeadingPitch();
      room.send("move", { x, y, z, yaw: heading, pitch });
    }, 50);

  } catch (err) {
    console.error("[Colyseus] failed:", err);
    initVisualsOnce();
  }
}

connectColyseus();

/* ============================================================
 * Main hooks
 * ============================================================
 */

noa.on("beforeRender", function () {
  initVisualsOnce();

  const scene = getNoaScene();
  if (!scene) return;

  // keep magenta background as a live indicator
  scene.autoClear = true;
  scene.clearColor = new BABYLON.Color4(1, 0, 1, 1);

  const cam = getActiveCamera(scene);

  frameCounter++;
  if (frameCounter % 120 === 0) {
    console.log(
      "[Diag] activeCamera:",
      cam ? `${cam.name} (${cam.getClassName?.()})` : "(none)",
      "| useRightHandedSystem:",
      !!scene.useRightHandedSystem,
      "| meshes:",
      scene.meshes?.length
    );
  }

  if (!cam) return;

  // Ensure minZ isn't clipping camera children
  if (typeof cam.minZ === "number" && cam.minZ > 0.05) cam.minZ = 0.05;

  // Get camera world forward direction (works RH/LH)
  const fwd = getCameraForwardWorld(cam);

  // Place a WORLD cube directly in front of camera (cannot be behind)
  if (frontCube) {
    const worldPos = cam.position.add(fwd.scale(4));
    frontCube.position.copyFrom(worldPos);
    frontCube.rotation.y += 0.03;
  }

  // Parent proofPlane + arms to camera, but position them using FORWARD vector
  // (we don't trust local +Z/-Z, we compute real forward and convert into parent space)
  if (proofPlane) {
    if (proofPlane.parent !== cam) proofPlane.parent = cam;

    // Put it forward, centered
    // Since it's parented, we can just use "local" offsets,
    // but we still need the correct sign. We derive it from fwd.z in camera space.
    // Simple robust approach: use scene RH flag.
    const forwardSign = scene.useRightHandedSystem ? -1 : 1;
    proofPlane.position.set(0, 0, forwardSign * 2.0);
  }

  if (fpArmsMesh) {
    if (fpArmsMesh.parent !== cam) fpArmsMesh.parent = cam;
    const forwardSign = scene.useRightHandedSystem ? -1 : 1;
    fpArmsMesh.position.set(0.35, -0.35, forwardSign * 1.2);
  }

  // Third-person avatar follow (world space)
  if (avatarCube) {
    const [x, y, z] = getLocalPlayerPosition();
    avatarCube.position.set(x, y + 0.9, z);
    const { heading } = getNoaHeadingPitch();
    avatarCube.rotation.y = heading;
  }
});

noa.on("tick", function () {
  const scroll = noa.inputs.pointerState.scrolly;
  if (scroll !== 0 && viewMode !== 0) {
    noa.camera.zoomDistance += scroll > 0 ? 1 : -1;
    noa.camera.zoomDistance = clamp(noa.camera.zoomDistance, 2, 12);
  }
});

/* ============================================================
 * Block interactions
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
