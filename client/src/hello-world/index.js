/*
 * Fresh2 - noa hello-world (main game entry) - CLEAN PIPELINE v3 (JS-safe typings)
 *
 * Goals:
 * - Confirm correct deployed entry is executing (Test A = magenta sky)
 * - Prove Babylon meshes render (green proof cube)
 * - Make 3rd-person avatar visible via NOA mesh component (simple solid body)
 * - Make 1st-person arms visible (parented to NOA/Babylon camera)
 * - Keep crosshair overlay (shows in first-person when pointer locked)
 *
 * Controls:
 * - Click canvas to pointer-lock (only in first-person)
 * - F5 toggle view: first-person <-> third-person
 * - F6 toggle crosshair forced
 */

import { Engine } from "noa-engine";
import { Client } from "@colyseus/sdk";

// Babylon runtime used by your bundle
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

let localAvatarMesh = null; // Babylon mesh attached via NOA mesh component
let fpArmsMesh = null;      // Babylon mesh parented to camera

/* ============================================================
 * Small helpers
 * ============================================================
 */

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

function safeNum(v, fallback = 0) {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/* ============================================================
 * Pointer lock helpers (TS-safe in .js)
 * ============================================================
 */

/**
 * IMPORTANT:
 * noa.container is typed as noa "Container" (not a DOM element).
 * We must only ever return a real DOM element here.
 *
 * @returns {HTMLElement|HTMLCanvasElement|null}
 */
function getPointerLockElement() {
  // Try NOA container but only accept it if it has DOM APIs.
  const c = /** @type {any} */ (noa && noa.container);

  if (c && typeof c === "object") {
    // DOM nodes have addEventListener; noa Container won't.
    if (typeof c.addEventListener === "function") {
      return /** @type {HTMLElement} */ (c);
    }
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
  Object.assign(h.style, lineStyle, {
    width: "100%",
    height: "3px",
    top: "9px",
    left: "0px",
  });

  const v = document.createElement("div");
  Object.assign(v.style, lineStyle, {
    width: "3px",
    height: "100%",
    left: "9px",
    top: "0px",
  });

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
 * Click-to-lock pointer (TS-safe in .js)
 * ============================================================
 */

(function enableClickToPointerLock() {
  const interval = setInterval(() => {
    const el0 = getPointerLockElement();
    if (!el0) return;
    clearInterval(interval);

    // Cast ONCE to any so TS stops treating it like noa "Container"
    const el = /** @type {any} */ (el0);

    // Ensure focusable
    try {
      if (typeof el.hasAttribute === "function" && typeof el.setAttribute === "function") {
        if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "1");
      }
      if (el.style) el.style.outline = "none";
    } catch {}

    el.addEventListener("click", () => {
      try {
        // only lock in first-person
        if (viewMode !== 0) return;

        if (document.pointerLockElement !== el) {
          el.requestPointerLock?.();
        }
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

    // leaving first-person? release pointer
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
 * Babylon helpers
 * ============================================================
 */

function getNoaScene() {
  try {
    return noa.rendering.getScene();
  } catch {
    return null;
  }
}

function getNoaCamera() {
  // NOA keeps a Babylon camera on noa.rendering.camera
  const cam = noa && noa.rendering && noa.rendering.camera;
  return cam || null;
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
  mesh.layerMask = 0xFFFFFFFF;
}

/* ============================================================
 * Test A + proof mesh + avatar + arms
 * ============================================================
 */

let inited = false;

function initVisualsOnce() {
  if (inited) return;
  inited = true;

  const scene = getNoaScene();
  const cam = getNoaCamera();

  console.log("[NOA] scene exists?", !!scene, "camera exists?", !!cam, "cameraType:", cam?.getClassName?.());

  if (!scene) return;

  // TEST A: magenta sky (force for certainty)
  scene.autoClear = true;
  scene.clearColor = new BABYLON.Color4(1, 0, 1, 1);
  console.log("[TestA] magenta clearColor set");

  // PROOF: green cube in world space at spawn area
  const proof = BABYLON.MeshBuilder.CreateBox("proofBox", { size: 1.5 }, scene);
  proof.position.set(0, 12, 0);
  proof.material = makeEmissiveMat(scene, "proofMat", new BABYLON.Color3(0, 1, 0));
  forceMeshVisible(proof);
  console.log("[PROOF] world cube created at (0,12,0)");

  // AVATAR: simple body mesh (blue) attached via NOA mesh component
  const avatar = BABYLON.MeshBuilder.CreateBox(
    "localAvatar",
    { height: 1.8, width: 0.8, depth: 0.4 },
    scene
  );
  avatar.material = makeEmissiveMat(scene, "avatarMat", new BABYLON.Color3(0.2, 0.6, 1.0));
  forceMeshVisible(avatar);

  localAvatarMesh = avatar;

  // Attach to player entity using NOA mesh component (runtime-safe, typing-safe)
  try {
    const entities = noa.entities;
    const meshName = entities.names?.mesh || "mesh";

    const addComp = entities["addComponent"];
    if (typeof addComp === "function") {
      addComp.call(entities, noa.playerEntity, meshName, {
        mesh: localAvatarMesh,
        offset: [0, 0.9, 0], // center at body mid
      });
      console.log("[Avatar] attached to player entity via NOA mesh component");
    } else {
      console.warn("[Avatar] entities.addComponent not available on this noa build");
    }
  } catch (e) {
    console.warn("[Avatar] attach failed:", e);
  }

  // ARMS: a beige emissive box parented to camera (first-person)
  if (cam) {
    const arms = BABYLON.MeshBuilder.CreateBox("fpArms", { height: 0.4, width: 0.8, depth: 0.4 }, scene);
    arms.material = makeEmissiveMat(scene, "armsMat", new BABYLON.Color3(1.0, 0.85, 0.65));
    forceMeshVisible(arms);

    // Parent to camera so it's always in view in 1st person
    arms.parent = cam;
    arms.position.set(0.35, -0.35, 1.0);
    arms.scaling.set(1.2, 1.0, 1.0);

    fpArmsMesh = arms;
    console.log("[FPArms] created + parented to camera");
  } else {
    console.warn("[FPArms] camera missing - cannot parent arms");
  }

  applyViewMode();
}

/* ============================================================
 * View mode application
 * ============================================================
 */

function applyViewMode() {
  const scene = getNoaScene();
  if (!scene) return;

  const locked = isPointerLockedToNoa();
  const isFirst = viewMode === 0;

  // Camera: third-person uses zoomDistance > 0
  if (isFirst) {
    noa.camera.zoomDistance = 0;
  } else {
    noa.camera.zoomDistance = 6;
    noa.camera.zoomDistance = clamp(noa.camera.zoomDistance, 2, 12);
  }

  // Toggle avatar + arms
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

document.addEventListener("pointerlockchange", () => {
  applyViewMode();
  crosshairUI.refresh();
});

/* ============================================================
 * Connect Colyseus
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

async function connectColyseus() {
  console.log("[Colyseus] connecting to:", COLYSEUS_ENDPOINT);
  await debugMatchmake(COLYSEUS_ENDPOINT);

  try {
    const room = await colyseusClient.joinOrCreate("my_room", { name: "Steve" });
    console.log("[Colyseus] connected, session:", room.sessionId);

    // Register server message to remove warning
    room.onMessage("welcome", (msg) => {
      console.log("[Colyseus] welcome:", msg);
    });

    // init visuals after scene exists
    initVisualsOnce();

    // send movement updates
    setInterval(() => {
      const [x, y, z] = getLocalPlayerPosition();
      const { heading, pitch } = getNoaHeadingPitch();
      room.send("move", { x, y, z, yaw: heading, pitch });
    }, 50);

  } catch (err) {
    console.error("[Colyseus] failed:", err);
    // still init visuals so you can see test meshes offline
    initVisualsOnce();
  }
}

connectColyseus();

/* ============================================================
 * Main tick hooks
 * ============================================================
 */

noa.on("beforeRender", function () {
  // Ensure visuals exist once rendering is ready
  initVisualsOnce();

  // Keep Test A magenta in case something resets it
  const scene = getNoaScene();
  if (scene) {
    scene.autoClear = true;
    scene.clearColor = new BABYLON.Color4(1, 0, 1, 1);
  }
});

noa.on("tick", function () {
  // camera zoom scroll in third-person
  const scroll = noa.inputs.pointerState.scrolly;
  if (scroll !== 0 && viewMode !== 0) {
    noa.camera.zoomDistance += scroll > 0 ? 1 : -1;
    noa.camera.zoomDistance = clamp(noa.camera.zoomDistance, 2, 12);
  }
});

/* ============================================================
 * Interactivity (blocks)
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
