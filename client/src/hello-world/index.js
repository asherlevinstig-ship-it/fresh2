/*
 * Fresh2 - noa hello-world (main game entry) - VISIBILITY FIX v5 (Test A+)
 *
 * What this version does differently:
 * - Uses scene.activeCamera as the source-of-truth (NOA may swap cameras)
 * - Creates an "impossible-to-miss" camera-parented emissive plane (TEST A+)
 * - Forces layerMask = 0xFFFFFFFF and renderingGroupId = 0 (most compatible)
 * - Keeps unfreezing active meshes if needed
 * - Keeps crosshair + pointer lock
 * - Adds a simple third-person avatar box (world space)
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

let proofPlane = null;      // TEST A+ (camera-parented plane)
let proofCube = null;       // World proof cube
let localAvatarMesh = null; // third-person avatar box
let fpArmsMesh = null;      // first-person arms box

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

/* ============================================================
 * Pointer lock target (TS-safe in JS)
 * ============================================================
 */

function getPointerLockElement() {
  const c = /** @type {any} */ (noa && noa.container);

  // If it's a real DOM element, it will have addEventListener
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
  setInterval(refresh, 300);

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
  console.log("[Colyseus][debug] http endpoint:", http);
  try {
    const r1 = await fetch(`${http}/hi`, { method: "GET" });
    console.log("[Colyseus][debug] GET /hi status:", r1.status);
  } catch (e) {
    console.error("[Colyseus][debug] GET /hi failed:", e);
  }
}

const colyseusClient = new Client(COLYSEUS_ENDPOINT);

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
 * Babylon accessors
 * ============================================================
 */

function getNoaScene() {
  try {
    return noa.rendering.getScene();
  } catch {
    return null;
  }
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

  // Most compatible: do not rely on mask matching, just allow everything
  mesh.layerMask = 0xFFFFFFFF;

  // Most compatible: default render group
  mesh.renderingGroupId = 0;
}

/* ============================================================
 * INIT visuals: Test A+ plane + cube + avatar + arms
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

  // TEST A: set magenta clearColor (you already see this working)
  scene.autoClear = true;
  scene.clearColor = new BABYLON.Color4(1, 0, 1, 1);
  console.log("[TestA] magenta clearColor set");

  // If NOA ever freezes, unfreeze anyway
  try {
    const frozen = !!/** @type {any} */ (scene)._activeMeshesFrozen;
    console.log("[Diag] scene _activeMeshesFrozen:", frozen);
    if (typeof scene.unfreezeActiveMeshes === "function") {
      scene.unfreezeActiveMeshes();
      console.log("[Diag] scene.unfreezeActiveMeshes() called");
    }
  } catch (e) {
    console.warn("[Diag] unfreezeActiveMeshes probe failed:", e);
  }

  // TEST A+ : Camera-parented plane that MUST appear if we're in the rendered scene/camera
  proofPlane = BABYLON.MeshBuilder.CreatePlane("proofPlane", { size: 0.6 }, scene);
  const proofPlaneMat = makeEmissiveMat(scene, "proofPlaneMat", new BABYLON.Color3(1, 1, 0)); // bright yellow
  proofPlaneMat.disableDepthWrite = true; // draw on top
  proofPlane.material = proofPlaneMat;
  forceMeshVisible(proofPlane);

  // Put it in front of camera once parented
  proofPlane.position.set(0.0, 0.0, 2.0);

  console.log("[TestA+] proofPlane created (yellow, camera-parented once activeCamera is known)");

  // World proof cube
  proofCube = BABYLON.MeshBuilder.CreateBox("proofCube", { size: 2 }, scene);
  proofCube.material = makeEmissiveMat(scene, "proofCubeMat", new BABYLON.Color3(0, 1, 0));
  proofCube.position.set(0, 14, 0);
  forceMeshVisible(proofCube);
  console.log("[PROOF] green cube created at (0,14,0)");

  // Third-person avatar
  localAvatarMesh = BABYLON.MeshBuilder.CreateBox("localAvatar", { height: 1.8, width: 0.8, depth: 0.4 }, scene);
  localAvatarMesh.material = makeEmissiveMat(scene, "avatarMat", new BABYLON.Color3(0.2, 0.6, 1.0));
  forceMeshVisible(localAvatarMesh);
  console.log("[Avatar] created (manual follow)");

  // First-person arms (camera-parented)
  fpArmsMesh = BABYLON.MeshBuilder.CreateBox("fpArms", { height: 0.25, width: 0.8, depth: 0.25 }, scene);
  const armsMat = makeEmissiveMat(scene, "armsMat", new BABYLON.Color3(1.0, 0.85, 0.65));
  armsMat.disableDepthWrite = true;
  fpArmsMesh.material = armsMat;
  forceMeshVisible(fpArmsMesh);
  fpArmsMesh.position.set(0.35, -0.35, 1.2);
  console.log("[FPArms] created (will be parented to scene.activeCamera)");

  applyViewMode();
}

/* ============================================================
 * View mode
 * ============================================================
 */

function applyViewMode() {
  const locked = isPointerLockedToNoa();
  const isFirst = viewMode === 0;

  noa.camera.zoomDistance = isFirst ? 0 : 6;

  if (localAvatarMesh) localAvatarMesh.setEnabled(!isFirst);
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
 * Connect Colyseus
 * ============================================================
 */

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

  // keep magenta background
  scene.autoClear = true;
  scene.clearColor = new BABYLON.Color4(1, 0, 1, 1);

  // keep unfreezing if NOA re-freezes
  try {
    const sAny = /** @type {any} */ (scene);
    if (sAny._activeMeshesFrozen && typeof scene.unfreezeActiveMeshes === "function") {
      scene.unfreezeActiveMeshes();
    }
  } catch {}

  const activeCam = getActiveCamera(scene);

  frameCounter++;
  if (frameCounter % 120 === 0) {
    console.log(
      "[Diag] activeCamera:",
      activeCam ? `${activeCam.name} (${activeCam.getClassName?.()})` : "(none)",
      "| meshes:",
      scene.meshes?.length
    );
  }

  // This is the key:
  // Parent proofPlane and fpArms to the *actual* active camera (even if it changes)
  if (activeCam) {
    // reduce chance of near-plane clipping for camera children
    if (typeof activeCam.minZ === "number" && activeCam.minZ > 0.05) activeCam.minZ = 0.05;

    if (proofPlane && proofPlane.parent !== activeCam) {
      proofPlane.parent = activeCam;
      proofPlane.position.set(0.0, 0.0, 2.0);
      console.log("[TestA+] proofPlane re-parented to activeCamera");
    }

    if (fpArmsMesh && fpArmsMesh.parent !== activeCam) {
      fpArmsMesh.parent = activeCam;
      fpArmsMesh.position.set(0.35, -0.35, 1.2);
      console.log("[FPArms] re-parented to activeCamera");
    }
  }

  // Third-person avatar follow
  if (localAvatarMesh) {
    const [x, y, z] = getLocalPlayerPosition();
    localAvatarMesh.position.set(x, y + 0.9, z);
    const { heading } = getNoaHeadingPitch();
    localAvatarMesh.rotation.y = heading;
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
