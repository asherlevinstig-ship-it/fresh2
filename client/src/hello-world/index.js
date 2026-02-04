// @ts-nocheck
/**
 * Fresh2 - noa hello-world (main game entry)
 * Diagnostics-first build:
 * - Fixes TS "no construct signatures" by importing noa-engine as namespace + any
 * - Adds Crosshair overlay
 * - Adds Test A (magenta clearColor) + PROOF frontCube that is forced in front of camera each frame
 * - Adds "Render Pipeline Truth Test" (customRenderFunction probes + optional disable via bracket access)
 * - Avoids .isInFrustum(cam) crash (NOA camera/frustum planes can be undefined mid-frame)
 * - Uses bracket-notation for noa.entities methods to avoid typing mismatches
 * - Adds basic 3rd-person avatar cube + basic FP arms cube (both forced in front / following)
 */

import * as NOA_MOD from "noa-engine";
import { Client } from "@colyseus/sdk";

import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";

/* ============================================================
 * NOA bootstrap (robust against typings/export-shape differences)
 * ============================================================
 */

const NoaAny = NOA_MOD && NOA_MOD.default ? NOA_MOD.default : NOA_MOD;

const opts = {
  debug: true,
  showFPS: true,
  chunkSize: 32,
  chunkAddDistance: 2.5,
  chunkRemoveDistance: 3.5,
};

// noa-engine can be factory-style or constructor-style depending on build
let noa;
try {
  noa = typeof NoaAny === "function" ? NoaAny(opts) : new NoaAny(opts);
} catch (e) {
  noa = new NoaAny(opts);
}

const noaAny = noa;

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

/* ============================================================
 * Crosshair overlay
 * ============================================================
 */

let viewMode = 0; // 0 first, 1 third
let forceCrosshair = true;

function getPointerLockTarget() {
  // noa.container is the #noa-container div, but its typing may not be HTMLElement
  const c = noaAny.container;
  if (c && typeof c === "object") return c;
  return document.querySelector("canvas") || document.body;
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
 * Click-to-lock pointer (TS-safe: treat element as any)
 * ============================================================
 */

(function enableClickToPointerLock() {
  const interval = setInterval(() => {
    const target = getPointerLockTarget();
    if (!target) return;
    clearInterval(interval);

    /** @type {any} */
    const el = target;

    // only if it's a real DOM element
    if (typeof el?.setAttribute === "function" && typeof el?.hasAttribute === "function") {
      if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "1");
      if (el.style) el.style.outline = "none";
    }

    if (typeof el?.addEventListener === "function") {
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
    }

    console.log("[PointerLock] handler attached");
  }, 100);
})();

/* ============================================================
 * Keybinds
 * ============================================================
 */

document.addEventListener("keydown", (e) => {
  if (e.code === "F5") {
    e.preventDefault();
    viewMode = (viewMode + 1) % 2;
    if (viewMode !== 0) {
      try { document.exitPointerLock?.(); } catch {}
    }
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
 * Blocks / world gen
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
 * Colyseus (optional)
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
    console.warn("[Colyseus][debug] GET /hi failed:", e);
  }
}

const colyseusClient = new Client(COLYSEUS_ENDPOINT);
noaAny.colyseus = { endpoint: COLYSEUS_ENDPOINT, client: colyseusClient, room: null };

/* ============================================================
 * Babylon visuals init
 * ============================================================
 */

let visualsInited = false;

// diagnostics/test meshes
let frontCube = null;     // PROOF cube: forced in front of camera every frame
let avatarCube = null;    // "3rd person" cube: follows player position
let fpArms = null;        // "arms" cube: forced in front of camera when in first person
let proofPlane = null;    // extra marker

let frameCounter = 0;

function getSceneAndCamera() {
  const scene = noa.rendering.getScene?.() || noa.rendering.scene;
  // NOA v0.33 uses a Babylon FreeCamera internally; it should be scene.activeCamera
  const cam = scene?.activeCamera || noa.rendering.camera || noa.camera;
  return { scene, cam };
}

function makeSolidMat(scene, name, color) {
  const mat = new StandardMaterial(name, scene);
  mat.diffuseColor = color;
  mat.emissiveColor = color;     // force visible even if lighting is weird
  mat.specularColor = new Color3(0, 0, 0);
  mat.backFaceCulling = false;
  mat.disableLighting = true;
  mat.alpha = 1;
  return mat;
}

function initVisualsOnce() {
  if (visualsInited) return;

  const { scene, cam } = getSceneAndCamera();
  if (!scene || !cam) return;

  console.log("[Babylon] imported Engine.Version:", (NOA_MOD && NOA_MOD.Engine && NOA_MOD.Engine.Version) || "(unknown)");
  console.log(
    "[NOA] scene exists?",
    !!scene,
    "activeCamera exists?",
    !!scene.activeCamera,
    "cameraType:",
    scene.activeCamera?.getClassName?.() || scene.activeCamera?.constructor?.name
  );

  // ===== Test A: loud clearColor =====
  // If you see magenta sky, you're definitely operating on the correct scene.
  scene.clearColor = { r: 1, g: 0, b: 1, a: 1 };
  console.log("[TestA] magenta clearColor set");

  // Active mesh freezing sanity
  try {
    const frozen = scene["_activeMeshesFrozen"];
    console.log("[Diag] scene _activeMeshesFrozen:", frozen);
    if (typeof scene.unfreezeActiveMeshes === "function") {
      scene.unfreezeActiveMeshes();
      console.log("[Diag] scene.unfreezeActiveMeshes() called");
    }
  } catch {}

  // ===== RENDER PIPELINE TRUTH TEST =====
  (function probeRenderPipeline() {
    const s = scene;
    const rm = s.renderingManager;

    // Access with bracket notation so TS doesn't complain
    const sceneCRF = s["customRenderFunction"];
    const rmCRF = rm ? rm["customRenderFunction"] : undefined;

    console.log("========== [RenderProbe] ==========");
    console.log("[RenderProbe] scene.customRenderFunction =", typeof sceneCRF);
    console.log("[RenderProbe] renderingManager.customRenderFunction =", typeof rmCRF);
    console.log("[RenderProbe] scene.meshes.length =", s.meshes.length);
    console.log("[RenderProbe] scene.activeCamera.layerMask =", s.activeCamera?.layerMask);
    console.log("[RenderProbe] =================================");

    // Optional HARD TEST: disable if present
    if (typeof sceneCRF === "function") {
      console.warn("[RenderProbe] DISABLING scene.customRenderFunction for test");
      s["customRenderFunction"] = null;
    }
    if (rm && typeof rmCRF === "function") {
      console.warn("[RenderProbe] DISABLING renderingManager.customRenderFunction for test");
      rm["customRenderFunction"] = null;
    }
  })();

  // PROOF cube: we will teleport this directly in front of camera every frame
  frontCube = MeshBuilder.CreateBox("frontCube", { size: 1.2 }, scene);
  frontCube.material = makeSolidMat(scene, "frontCubeMat", new Color3(0.2, 0.6, 1.0));
  frontCube.isPickable = false;
  frontCube.isVisible = true;
  frontCube.visibility = 1;
  frontCube.alwaysSelectAsActiveMesh = true;
  console.log("[PROOF] frontCube created (will be moved in front of camera each frame)");

  // proof plane (bigger)
  proofPlane = MeshBuilder.CreatePlane("proofPlane", { size: 3 }, scene);
  proofPlane.material = makeSolidMat(scene, "proofPlaneMat", new Color3(1.0, 0.9, 0.2));
  proofPlane.isPickable = false;
  proofPlane.isVisible = true;
  proofPlane.visibility = 1;
  proofPlane.alwaysSelectAsActiveMesh = true;
  console.log("[TestA+] proofPlane created");

  // "avatar" cube (follows player)
  avatarCube = MeshBuilder.CreateBox("avatarCube", { size: 1.0 }, scene);
  avatarCube.material = makeSolidMat(scene, "avatarCubeMat", new Color3(0.2, 1.0, 0.2));
  avatarCube.isPickable = false;
  avatarCube.isVisible = true;
  avatarCube.visibility = 1;
  avatarCube.alwaysSelectAsActiveMesh = true;
  console.log("[Avatar] created (manual follow)");

  // "arms" cube (also forced in front of camera)
  fpArms = MeshBuilder.CreateBox("fpArms", { width: 0.6, height: 0.4, depth: 0.8 }, scene);
  fpArms.material = makeSolidMat(scene, "fpArmsMat", new Color3(1.0, 0.4, 0.4));
  fpArms.isPickable = false;
  fpArms.isVisible = true;
  fpArms.visibility = 1;
  fpArms.alwaysSelectAsActiveMesh = true;
  console.log("[FPArms] created (manual in-front-of-camera)");

  visualsInited = true;

  // attach applyViewMode side effects right away
  applyViewMode();
}

function applyViewMode() {
  const locked = isPointerLockedToNoa();
  const isFirst = viewMode === 0;

  // NOA camera zoom control (works in NOA camera wrapper)
  try {
    noa.camera.zoomDistance = isFirst ? 0 : 6;
  } catch {}

  // Show avatar only in 3rd
  if (avatarCube) avatarCube.setEnabled(!isFirst);

  // Show arms only in 1st and locked
  const armsOn = isFirst && locked;
  if (fpArms) fpArms.setEnabled(armsOn);

  console.log("[applyViewMode] viewMode:", isFirst ? "first" : "third", "locked:", locked, "avatar:", !isFirst, "arms:", armsOn);
}

document.addEventListener("pointerlockchange", applyViewMode);

/* ============================================================
 * Server connect
 * ============================================================
 */

async function connectColyseus() {
  console.log("[Colyseus] connecting to:", COLYSEUS_ENDPOINT);
  await debugMatchmake(COLYSEUS_ENDPOINT);

  try {
    const room = await colyseusClient.joinOrCreate("my_room", { name: "Steve" });
    noaAny.colyseus.room = room;
    console.log("[Colyseus] connected, session:", room.sessionId);

    // register welcome handler so SDK stops warning
    room.onMessage("welcome", (m) => console.log("[Colyseus] welcome:", m));

    // send movement
    setInterval(() => {
      const activeRoom = noaAny.colyseus.room;
      if (!activeRoom) return;

      let x = 0, y = 10, z = 0;
      try {
        const p = noa.entities.getPosition(noa.playerEntity);
        if (p && p.length >= 3) { x = p[0]; y = p[1]; z = p[2]; }
      } catch {}

      const yaw = safeNum(noa.camera.heading, 0);
      const pitch = safeNum(noa.camera.pitch, 0);
      activeRoom.send("move", { x, y, z, yaw, pitch });
    }, 80);

  } catch (err) {
    console.warn("[Colyseus] failed:", err);
  }
}

connectColyseus();

/* ============================================================
 * NOA ticks: ensure visuals init and force-proof positioning
 * ============================================================
 */

noa.on("tick", function () {
  // Make sure scene/camera exist before building Babylon meshes
  initVisualsOnce();

  // 3rd person zoom control (scroll)
  const scroll = noa.inputs.pointerState.scrolly;
  if (scroll !== 0 && viewMode !== 0) {
    noa.camera.zoomDistance += scroll > 0 ? 1 : -1;
    noa.camera.zoomDistance = clamp(noa.camera.zoomDistance, 2, 12);
  }
});

noa.on("beforeRender", function () {
  if (!visualsInited) return;

  frameCounter++;

  const { scene, cam } = getSceneAndCamera();
  if (!scene || !cam) return;

  // camera sanity
  if (typeof cam.maxZ === "number" && cam.maxZ < 500) cam.maxZ = 5000;
  if (typeof cam.minZ === "number" && cam.minZ > 0.2) cam.minZ = 0.05;

  // FORCE the PROOF cube and proof plane into view every frame
  // Works for Babylon FreeCamera: uses position + getForwardRay
  try {
    const origin = cam.position.clone ? cam.position.clone() : new Vector3(cam.position.x, cam.position.y, cam.position.z);

    // getForwardRay is reliable for FreeCamera
    const ray = typeof cam.getForwardRay === "function" ? cam.getForwardRay(5) : null;
    const dir = ray?.direction ? ray.direction : new Vector3(0, 0, 1);

    const inFront = origin.add(dir.scale(4));
    frontCube.position.copyFrom(inFront);
    frontCube.rotation.y += 0.02;

    const planePos = origin.add(dir.scale(6));
    proofPlane.position.copyFrom(planePos);
    proofPlane.rotation.copyFrom(frontCube.rotation);
  } catch {}

  // FP "arms": forced in front of camera when enabled
  if (fpArms && fpArms.isEnabled()) {
    try {
      const origin = cam.position.clone ? cam.position.clone() : new Vector3(cam.position.x, cam.position.y, cam.position.z);
      const ray = typeof cam.getForwardRay === "function" ? cam.getForwardRay(5) : null;
      const dir = ray?.direction ? ray.direction : new Vector3(0, 0, 1);

      // Slightly down/right relative to camera forward (approx)
      const inFront = origin.add(dir.scale(2.2));
      fpArms.position.copyFrom(inFront);
      fpArms.rotation.y += 0.01;
    } catch {}
  }

  // "avatar": follow player entity when enabled
  if (avatarCube && avatarCube.isEnabled()) {
    try {
      const p = noa.entities.getPosition(noa.playerEntity);
      if (p && p.length >= 3) {
        avatarCube.position.set(p[0], p[1] + 0.9, p[2]);
      }
    } catch {}
  }

  // Ensure layer masks / groups match camera (some NOA setups use masks)
  try {
    const lm = cam.layerMask ?? 0x0fffffff;
    // match what NOA camera sees
    frontCube.layerMask = lm;
    proofPlane.layerMask = lm;
    fpArms.layerMask = lm;
    avatarCube.layerMask = lm;

    // keep in normal group (0) so it can't be skipped by custom ordering
    frontCube.renderingGroupId = 0;
    proofPlane.renderingGroupId = 0;
    fpArms.renderingGroupId = 0;
    avatarCube.renderingGroupId = 0;
  } catch {}

  // Diagnostic: prove they are in scene.meshes and enabled/visible
  if (frameCounter % 120 === 0) {
    let frErr = null;
    try {
      // avoid cam frustum helper; it can be undefined and crash
      // We only log presence/visibility
    } catch (e) {
      frErr = e;
    }

    console.log(
      "[Diag2] frontCube in scene.meshes?",
      scene.meshes.includes(frontCube),
      "enabled?",
      typeof frontCube?.isEnabled === "function" ? frontCube.isEnabled() : "(no isEnabled)",
      "visible?",
      frontCube?.isVisible,
      "pos=",
      frontCube?.position?.toString?.() || `${frontCube.position.x},${frontCube.position.y},${frontCube.position.z}`,
      frErr ? `ERR:${String(frErr?.message || frErr)}` : ""
    );

    console.log(
      "[Diag2] cam pos=",
      cam?.position?.toString?.() || `${cam.position.x},${cam.position.y},${cam.position.z}`,
      "maxZ=",
      cam.maxZ,
      "minZ=",
      cam.minZ,
      "layerMask=",
      cam.layerMask
    );
  }
});

/* ============================================================
 * Interactivity (break/place blocks)
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
 * FINAL "are we even running THIS file?" marker
 * ============================================================
 */
console.log("%c[FRESH2] hello-world/index.js LOADED (diagnostics build)", "color:#0f0;font-weight:bold");
