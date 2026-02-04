/*
 * Fresh2 - noa hello-world (main entry)
 * Rewritten in full (NO OMITS) with:
 * - Crosshair overlay
 * - Pointer lock click handler (TS-safe in .js)
 * - TestA magenta clearColor
 * - Render Pipeline Truth Test (RenderProbe) with TS-safe any-casts
 * - PROOF frontCube that is moved in front of the active camera EACH FRAME
 * - Safe frustum diagnostic (uses cam.getFrustumPlanes() instead of passing camera)
 * - Simple "avatar cube" for 3rd person and "fp arms cube" for 1st person
 * - Block break/place stays intact
 *
 * NOTE: This file is plain JS. No TS type annotations.
 */

import { Engine as NoaEngine } from "noa-engine";
import { Client } from "@colyseus/sdk";

import {
  Engine as BEngine,
  MeshBuilder,
  StandardMaterial,
  Color3,
  Vector3,
} from "@babylonjs/core";

/* ============================================================
 * NOA Engine options + instantiate
 * ============================================================
 */

const opts = {
  debug: true,
  showFPS: true,
  chunkSize: 32,
  chunkAddDistance: 2.5,
  chunkRemoveDistance: 3.5,
};

const noa = new NoaEngine(opts);
/** @type {any} */
const noaAny = noa;

/* ============================================================
 * State
 * ============================================================
 */

let viewMode = 0; // 0 first, 1 third
let forceCrosshair = false;

let visualsInited = false;
let scene = null;

let frontCube = null;   // proof object always in front of camera
let avatarCube = null;  // third-person marker at player
let fpArms = null;      // first-person marker near camera

let frameCounter = 0;

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
 * Crosshair overlay
 * ============================================================
 */

function getPointerLockTarget() {
  const c = noaAny.container;
  if (c) return c;

  const div = document.getElementById("noa-container");
  if (div) return div;

  return document.querySelector("canvas");
}

function isPointerLockedToNoa() {
  const target = getPointerLockTarget();
  return !!(target && document.pointerLockElement === target);
}

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
  setInterval(refresh, 250);

  return { refresh };
}

const crosshairUI = createCrosshairOverlay();

/* ============================================================
 * Click-to-lock pointer (TS-safe in .js)
 * ============================================================
 */

(function enableClickToPointerLock() {
  const interval = setInterval(() => {
    const target = getPointerLockTarget();
    if (!target) return;
    clearInterval(interval);

    /** @type {any} */
    const el = target;

    // make focusable
    if (typeof el.setAttribute === "function" && typeof el.hasAttribute === "function") {
      if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "1");
    }
    if (el.style) el.style.outline = "none";

    // event hook that works for DOM elements, and won't upset TS if target typed weird
    const addEvt = el.addEventListener || el.addListener;
    if (typeof addEvt === "function") {
      addEvt.call(el, "click", () => {
        try {
          if (viewMode !== 0) return;
          if (document.pointerLockElement !== el && typeof el.requestPointerLock === "function") {
            el.requestPointerLock();
          }
        } catch (e) {
          console.warn("[PointerLock] failed:", e);
        }
      });
      console.log("[PointerLock] handler attached");
    } else {
      console.warn("[PointerLock] target has no addEventListener/addListener");
    }
  }, 100);
})();

/* ============================================================
 * Key handlers
 * ============================================================
 */

document.addEventListener("keydown", (e) => {
  if (e.code === "F5") {
    e.preventDefault();
    viewMode = (viewMode + 1) % 2; // first/third toggle
    if (viewMode !== 0) {
      try {
        document.exitPointerLock?.();
      } catch {}
    }
    applyViewMode();
    crosshairUI.refresh();
    console.log("[View] mode:", viewMode === 0 ? "first" : "third");
  }

  if (e.code === "F6") {
    e.preventDefault();
    forceCrosshair = !forceCrosshair;
    crosshairUI.refresh();
  }
});

/* ============================================================
 * Colyseus
 * ============================================================
 */

const DEFAULT_LOCAL_ENDPOINT = "ws://localhost:2567";
const COLYSEUS_ENDPOINT =
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
noaAny.colyseus = { endpoint: COLYSEUS_ENDPOINT, client: colyseusClient, room: null };

/* ============================================================
 * Register voxel types + world gen
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
 * Visuals init
 * ============================================================
 */

function initVisualsOnce() {
  if (visualsInited) return;

  scene = noa.rendering.getScene();
  if (!scene) return;

  const cam = scene.activeCamera;
  if (!cam) return;

  console.log("[Babylon] imported Engine.Version:", BEngine.Version);
  console.log(
    "[NOA] scene exists? true activeCamera exists? true cameraType:",
    cam.getClassName ? cam.getClassName() : cam.constructor?.name
  );

  // TestA: magenta sky
  try {
    // safest possible: set a BABYLON Color4 if present, else fallback won't crash
    /** @type {any} */
    const sAny = scene;
    if (sAny.clearColor && typeof sAny.clearColor === "object") {
      // Many Babylon builds use Color4 here; forcing values directly is ok
      sAny.clearColor.r = 1;
      sAny.clearColor.g = 0;
      sAny.clearColor.b = 1;
      sAny.clearColor.a = 1;
    }
  } catch {}
  console.log("[TestA] magenta clearColor set");

  // Active meshes frozen?
  console.log("[Diag] scene _activeMeshesFrozen:", scene._activeMeshesFrozen);
  try {
    if (typeof scene.unfreezeActiveMeshes === "function") {
      scene.unfreezeActiveMeshes();
      console.log("[Diag] scene.unfreezeActiveMeshes() called");
    }
  } catch (e) {
    console.warn("[Diag] unfreezeActiveMeshes failed:", e);
  }

  // PROOF cube: moved in front of camera each frame
  frontCube = MeshBuilder.CreateBox("frontCube", { size: 1.2 }, scene);
  {
    const m = new StandardMaterial("frontMat", scene);
    m.diffuseColor = new Color3(0, 0.5, 1);
    m.emissiveColor = new Color3(0, 0.5, 1);
    m.specularColor = new Color3(0, 0, 0);
    frontCube.material = m;
    frontCube.isPickable = false;
    frontCube.isVisible = true;
    frontCube.setEnabled(true);
  }
  console.log("[PROOF] frontCube created (will be moved in front of camera each frame)");

  // Third-person cube follows player position
  avatarCube = MeshBuilder.CreateBox("avatarCube", { size: 1.0 }, scene);
  {
    const m = new StandardMaterial("avatarMat", scene);
    m.diffuseColor = new Color3(1, 1, 0);
    m.emissiveColor = new Color3(0.6, 0.6, 0);
    m.specularColor = new Color3(0, 0, 0);
    avatarCube.material = m;
    avatarCube.isPickable = false;
    avatarCube.isVisible = true;
    avatarCube.setEnabled(false); // enabled only in 3rd
  }
  console.log("[Avatar] created (manual follow)");

  // First-person arms marker (red) near camera
  fpArms = MeshBuilder.CreateBox(
    "fpArms",
    { width: 0.35, height: 0.35, depth: 0.8 },
    scene
  );
  {
    const m = new StandardMaterial("armsMat", scene);
    m.diffuseColor = new Color3(1, 0.2, 0.2);
    m.emissiveColor = new Color3(0.6, 0.1, 0.1);
    m.specularColor = new Color3(0, 0, 0);
    fpArms.material = m;
    fpArms.isPickable = false;
    fpArms.isVisible = true;
    fpArms.setEnabled(false); // enabled only in 1st+locked
  }
  console.log("[FPArms] created (manual in-front-of-camera)");

  // ===== RENDER PIPELINE TRUTH TEST =====
  (function probeRenderPipeline() {
    const s = scene;
    const rm = s.renderingManager;

    /** @type {any} */
    const sAny = s;
    /** @type {any} */
    const rmAny = rm;

    console.log("========== [RenderProbe] ==========");
    console.log("[RenderProbe] scene.customRenderFunction =", typeof sAny.customRenderFunction);
    console.log(
      "[RenderProbe] renderingManager.customRenderFunction =",
      typeof rmAny?.customRenderFunction
    );
    console.log("[RenderProbe] scene.meshes.length =", s.meshes.length);
    console.log("[RenderProbe] scene.activeCamera.layerMask =", s.activeCamera?.layerMask);
    console.log("[RenderProbe] =================================");

    // Optional HARD TEST:
    if (typeof sAny.customRenderFunction === "function") {
      console.warn("[RenderProbe] DISABLING scene.customRenderFunction for test");
      sAny.customRenderFunction = null;
    }
    if (rmAny && typeof rmAny.customRenderFunction === "function") {
      console.warn("[RenderProbe] DISABLING renderingManager.customRenderFunction for test");
      rmAny.customRenderFunction = null;
    }
  })();

  visualsInited = true;
  applyViewMode();
}

/* ============================================================
 * View mode
 * ============================================================
 */

function applyViewMode() {
  if (!visualsInited) return;

  const locked = isPointerLockedToNoa();
  const isFirst = viewMode === 0;

  noa.camera.zoomDistance = isFirst ? 0 : 6;

  if (avatarCube) avatarCube.setEnabled(!isFirst);

  const armsOn = isFirst && locked;
  if (fpArms) fpArms.setEnabled(armsOn);

  console.log(
    "[applyViewMode] viewMode:",
    isFirst ? "first" : "third",
    "locked:",
    locked,
    "avatar:",
    !isFirst,
    "arms:",
    armsOn
  );
}

/* ============================================================
 * Main tick / beforeRender
 * ============================================================
 */

noa.on("tick", function () {
  initVisualsOnce();

  const scroll = noa.inputs.pointerState.scrolly;
  if (scroll !== 0 && viewMode !== 0) {
    noa.camera.zoomDistance += scroll > 0 ? 1 : -1;
    noa.camera.zoomDistance = clamp(noa.camera.zoomDistance, 2, 12);
  }
});

noa.on("beforeRender", function () {
  if (!visualsInited || !scene) return;

  frameCounter++;

  const cam = scene.activeCamera;
  if (!cam) return;

  // force far clip huge (some engines clamp maxZ and you won't see objects)
  if (typeof cam.maxZ === "number" && cam.maxZ < 500) cam.maxZ = 5000;

  // Move frontCube in front of camera EACH FRAME (2 units forward)
  if (frontCube) {
    let fwd = null;
    try {
      fwd = typeof cam.getDirection === "function" ? cam.getDirection(new Vector3(0, 0, 1)) : null;
    } catch {}
    if (!fwd) fwd = new Vector3(0, 0, 1);

    const camPos = cam.position ? cam.position.clone() : new Vector3(0, 10, 0);
    frontCube.position.copyFrom(camPos.add(fwd.scale(2.0)));
  }

  // Avatar cube follows NOA player entity
  if (avatarCube) {
    let px = 0, py = 10, pz = 0;
    try {
      const p = noa.entities.getPosition(noa.playerEntity);
      px = p[0];
      py = p[1];
      pz = p[2];
    } catch {}
    avatarCube.position.set(px, py + 0.6, pz);
  }

  // FP arms sits near camera if enabled
  if (fpArms && fpArms.isEnabled()) {
    let fwd = null, right = null, up = null;
    try {
      if (typeof cam.getDirection === "function") {
        fwd = cam.getDirection(new Vector3(0, 0, 1));
        right = cam.getDirection(new Vector3(1, 0, 0));
        up = cam.getDirection(new Vector3(0, 1, 0));
      }
    } catch {}
    if (!fwd) fwd = new Vector3(0, 0, 1);
    if (!right) right = new Vector3(1, 0, 0);
    if (!up) up = new Vector3(0, 1, 0);

    const camPos = cam.position ? cam.position.clone() : new Vector3(0, 10, 0);
    fpArms.position.copyFrom(
      camPos
        .add(fwd.scale(1.1))
        .add(right.scale(0.25))
        .add(up.scale(-0.18))
    );
  }

  // Diagnostic: prove mesh is in scene.meshes and frustum check WITHOUT crashing
  if (frameCounter % 120 === 0 && frontCube) {
    let inFrustum = "(skip)";
    try {
      const planes = typeof cam.getFrustumPlanes === "function" ? cam.getFrustumPlanes() : null;
      inFrustum = planes ? frontCube.isInFrustum(planes) : frontCube.isInFrustum();
    } catch (e) {
      inFrustum = "ERR:" + (e?.message || String(e));
    }

    console.log(
      "[Diag2] frontCube in scene.meshes?",
      scene.meshes.includes(frontCube),
      "enabled?",
      frontCube?.isEnabled?.(),
      "visible?",
      frontCube?.isVisible,
      "inFrustum?",
      inFrustum
    );
  }
});

/* ============================================================
 * Pointer lock change triggers view mode update
 * ============================================================
 */

document.addEventListener("pointerlockchange", () => {
  applyViewMode();
  crosshairUI.refresh();
});

/* ============================================================
 * Interactivity - break/place blocks
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
 * Connect Colyseus (optional)
 * ============================================================
 */

(async function connectColyseus() {
  console.log("[Colyseus] connecting to:", COLYSEUS_ENDPOINT);
  await debugMatchmake(COLYSEUS_ENDPOINT);

  try {
    const room = await colyseusClient.joinOrCreate("my_room", { name: "Steve" });
    noaAny.colyseus.room = room;

    console.log("[Colyseus] connected, session:", room.sessionId);

    room.onMessage("welcome", (msg) => console.log("[Colyseus] welcome:", msg));
    room.onLeave(() => {
      console.warn("[Colyseus] left");
      noaAny.colyseus.room = null;
    });

    setInterval(() => {
      const activeRoom = noaAny.colyseus.room;
      if (!activeRoom) return;

      let x = 0,
        y = 10,
        z = 0;
      try {
        const p = noa.entities.getPosition(noa.playerEntity);
        x = p[0];
        y = p[1];
        z = p[2];
      } catch {}

      const yaw = safeNum(noa.camera.heading, 0);
      const pitch = safeNum(noa.camera.pitch, 0);

      activeRoom.send("move", { x, y, z, yaw, pitch });
    }, 100);
  } catch (err) {
    console.error("[Colyseus] failed:", err);
  }
})();
