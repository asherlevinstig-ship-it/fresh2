// @ts-nocheck
/*
 * Fresh2 - hello-world (NOA main entry) - FULL REWRITE (NO OMITS)
 *
 * Goals:
 * 1) Fix "jr is not a constructor" by NEVER using `new Engine(...)` and instead
 *    calling noa-engine as a FACTORY, regardless of export shape.
 * 2) Add Crosshair + PointerLock (click-to-lock).
 * 3) Add TEST A (Render/Scene Truth Tests) that PROVES which Babylon Scene is actually rendering:
 *    - Enumerate ALL Babylon scenes on the engine
 *    - Create a BIG "PROOF cube" in EACH scene
 *    - Also move a "frontCube" in front of the *active camera* each frame (per-scene)
 *    If you STILL can't see proof cubes, then your viewport isn’t rendering those scenes/cameras.
 *
 * NOTE:
 * - This file is JavaScript (index.js). We disable TS checking at the top.
 * - We use bracket access for noa.entities etc.
 * - We avoid Scene.isInFrustum() because it can throw if cam frustum planes aren’t ready.
 */

import * as NOA_MOD from "noa-engine";
import { Client } from "@colyseus/sdk";

import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3 } from "@babylonjs/core/Maths/math.color";

/* ============================================================
 * NOA bootstrap (FACTORY ONLY - fixes "not a constructor")
 * ============================================================
 */

const opts = {
  debug: true,
  showFPS: true,
  chunkSize: 32,
  chunkAddDistance: 2.5,
  chunkRemoveDistance: 3.5,
};

const createNoa =
  (NOA_MOD && typeof NOA_MOD.default === "function" && NOA_MOD.default) ||
  (NOA_MOD && typeof NOA_MOD.createEngine === "function" && NOA_MOD.createEngine) ||
  (typeof NOA_MOD === "function" && NOA_MOD) ||
  null;

console.log("========================================");
console.log("[NOA_BOOT] module keys:", Object.keys(NOA_MOD || {}));
console.log("[NOA_BOOT] typeof NOA_MOD.default:", typeof (NOA_MOD && NOA_MOD.default));
console.log("[NOA_BOOT] typeof NOA_MOD.createEngine:", typeof (NOA_MOD && NOA_MOD.createEngine));
console.log("[NOA_BOOT] typeof NOA_MOD:", typeof NOA_MOD);
console.log("========================================");

if (!createNoa) {
  throw new Error("[NOA_BOOT] Could not find NOA factory function export. Check noa-engine import.");
}

const noa = createNoa(opts);
const noaAny = noa;

console.log("noa-engine v0.33.0 (debug)");

/* ============================================================
 * State
 * ============================================================
 */

let viewMode = 0; // 0 = first, 1 = third
let forceCrosshair = true;

let applyViewModeGlobal = null;

let colyRoom = null;

/** Babylon diagnostics storage */
const DIAG = {
  scenes: [],
  lastSceneDump: 0,
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

function getPointerLockTarget() {
  // noa.container is often a div
  const c = noaAny.container;
  if (c && typeof c === "object") return c;
  return document.getElementById("noa-container") || document.querySelector("canvas");
}

function isPointerLockedToNoa() {
  const target = getPointerLockTarget();
  return !!(target && document.pointerLockElement === target);
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

    // Only attach once
    clearInterval(interval);

    const el = /** @type {any} */ (target);

    // Avoid TS complaining by not assuming DOM type
    try {
      if (typeof el.setAttribute === "function" && typeof el.hasAttribute === "function") {
        if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "1");
      }
      if (el.style) el.style.outline = "none";
    } catch {}

    // Avoid TS complaining about addEventListener if it's not DOM
    const addEvt = el && (el.addEventListener || el.addListener);
    if (typeof addEvt === "function") {
      addEvt.call(el, "click", () => {
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
 * Key handlers
 * ============================================================
 */

document.addEventListener("keydown", (e) => {
  if (e.code === "F5") {
    e.preventDefault();
    viewMode = (viewMode + 1) % 2;
    if (viewMode !== 0) {
      try {
        document.exitPointerLock?.();
      } catch {}
    }
    try {
      if (typeof applyViewModeGlobal === "function") applyViewModeGlobal();
    } catch {}
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
 * Register voxel types + worldgen
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
 * Babylon scene access (TRUTH TEST needs correct scene!)
 * ============================================================
 */

function resolveBabylonScene() {
  // Try common NOA internals
  const r = noaAny.rendering;

  // Some builds expose getScene
  try {
    if (r && typeof r.getScene === "function") {
      const s = r.getScene();
      if (s) return s;
    }
  } catch {}

  // Typings suggest rendering.scene exists
  try {
    if (r && r.scene) return r.scene;
  } catch {}

  // Some noa versions keep _scene
  try {
    if (r && r._scene) return r._scene;
  } catch {}

  // As a last resort, try to find any Babylon engine via scene.getEngine()
  return null;
}

function resolveBabylonEngine(scene) {
  try {
    if (scene && typeof scene.getEngine === "function") return scene.getEngine();
  } catch {}
  try {
    const r = noaAny.rendering;
    if (r && r.engine) return r.engine;
    if (r && r._engine) return r._engine;
  } catch {}
  return null;
}

/* ============================================================
 * TEST A: Scene/Render truth tests (no omits)
 * ============================================================
 *
 * We create proof objects in EVERY scene on the engine.
 * If you see none, you are not looking at those scenes/cameras.
 */

function createSolidMat(scene, name, color) {
  const mat = new StandardMaterial(name, scene);
  mat.diffuseColor = color;
  mat.emissiveColor = color.scale(0.35);
  mat.specularColor = new Color3(0, 0, 0);
  mat.backFaceCulling = false;
  return mat;
}

function createProofCube(scene, label, color, pos) {
  const box = MeshBuilder.CreateBox(`proof_${label}`, { size: 3 }, scene);
  box.material = createSolidMat(scene, `mat_${label}`, color);
  box.position.copyFrom(pos);
  box.isPickable = false;
  box.isVisible = true;
  // Keep it eligible to draw
  box.alwaysSelectAsActiveMesh = true;
  return box;
}

/**
 * “Front cube” that is forced in front of a scene’s activeCamera every frame.
 * This bypasses all “position is wrong” issues.
 */
function createFrontCube(scene, label) {
  const box = MeshBuilder.CreateBox(`front_${label}`, { size: 1.5 }, scene);
  box.material = createSolidMat(scene, `mat_front_${label}`, new Color3(0, 0.6, 1));
  box.isPickable = false;
  box.isVisible = true;
  box.alwaysSelectAsActiveMesh = true;
  console.log(`[PROOF] frontCube created for scene ${label} (will be moved in front of camera each frame)`);
  return box;
}

function initTruthTestsOnce() {
  const scene = resolveBabylonScene();
  const engine = resolveBabylonEngine(scene);

  console.log("[Babylon] imported Engine.Version:", (/** @type {any} */ (NOA_MOD))?.Engine?.Version || "(unknown)");
  console.log(
    "[NOA] scene exists?",
    !!scene,
    "activeCamera exists?",
    !!(scene && scene.activeCamera),
    "cameraType:",
    scene && scene.activeCamera ? scene.activeCamera.getClassName?.() || scene.activeCamera.constructor?.name : "(none)"
  );

  if (!scene || !engine) {
    console.warn("[TestA] Could not resolve Babylon scene/engine yet. Will retry...");
    return false;
  }

  // Visual “magenta sky” to prove we touched the correct scene
  try {
    scene.clearColor = new Color3(1, 0, 1);
    console.log("[TestA] magenta clearColor set");
  } catch {}

  // Attempt to unfreeze active meshes if NOA freezes them
  try {
    console.log("[Diag] scene _activeMeshesFrozen:", scene._activeMeshesFrozen);
    if (typeof scene.unfreezeActiveMeshes === "function") {
      scene.unfreezeActiveMeshes();
      console.log("[Diag] scene.unfreezeActiveMeshes() called");
    }
  } catch {}

  // ===== RENDER PIPELINE TRUTH TEST =====
  (function probeRenderPipeline() {
    const s = scene;
    const rm = s.renderingManager;

    console.log("========== [RenderProbe] ==========");
    console.log("[RenderProbe] scene.customRenderFunction =", typeof (/** @type {any} */ (s)).customRenderFunction);
    console.log("[RenderProbe] renderingManager.customRenderFunction =", typeof (rm && (/** @type {any} */ (rm)).customRenderFunction));
    console.log("[RenderProbe] scene.meshes.length =", s.meshes.length);
    console.log("[RenderProbe] scene.activeCamera.layerMask =", s.activeCamera?.layerMask);
    console.log("[RenderProbe] =================================");

    // Optional HARD TEST:
    // Disable custom render function if present (just to prove the hypothesis)
    const sAny = /** @type {any} */ (s);
    const rmAny = /** @type {any} */ (rm);
    if (typeof sAny.customRenderFunction === "function") {
      console.warn("[RenderProbe] DISABLING scene.customRenderFunction for test");
      sAny.customRenderFunction = null;
    }
    if (rmAny && typeof rmAny.customRenderFunction === "function") {
      console.warn("[RenderProbe] DISABLING renderingManager.customRenderFunction for test");
      rmAny.customRenderFunction = null;
    }
  })();

  // Enumerate ALL scenes on the engine and plant proof meshes in each
  const scenes = engine.scenes || [];
  DIAG.scenes = [];

  console.log("========================================");
  console.log("[TestA] Babylon engine.scenes.length =", scenes.length);
  console.log("========================================");

  scenes.forEach((s, idx) => {
    const label = `S${idx}`;
    const cam = s.activeCamera;
    const camName = cam ? cam.name : "(none)";
    const camType = cam ? (cam.getClassName?.() || cam.constructor?.name) : "(none)";
    console.log(`[TestA] Scene ${label}: meshes=${s.meshes.length} activeCamera=${camName} (${camType})`);

    // Put a big cube at world origin-ish and another somewhere else
    const proof1 = createProofCube(s, `${label}_A`, new Color3(0, 1, 0), new Vector3(0, 14, 0));
    const proof2 = createProofCube(s, `${label}_B`, new Color3(1, 1, 0), new Vector3(6, 14, 0));
    const front = createFrontCube(s, label);

    DIAG.scenes.push({
      scene: s,
      label,
      proof1,
      proof2,
      frontCube: front,
    });
  });

  return true;
}

// Retry init until we can resolve scene/engine
(function bootTruthTests() {
  let tries = 0;
  const t = setInterval(() => {
    tries++;
    if (initTruthTestsOnce()) {
      clearInterval(t);
    } else if (tries > 50) {
      clearInterval(t);
      console.warn("[TestA] Gave up resolving Babylon scene/engine after retries.");
    }
  }, 200);
})();

/* ============================================================
 * “Arms” + “3rd person avatar” (minimal version)
 * ============================================================
 *
 * IMPORTANT:
 * We keep this minimal until TEST A proves we can render ANY custom mesh.
 * These are just colored cubes.
 */

let avatarRoot = null;
let fpArmsRoot = null;

function initMinimalAvatarOnce() {
  if (avatarRoot || fpArmsRoot) return;

  const scene = resolveBabylonScene();
  const engine = resolveBabylonEngine(scene);
  if (!scene || !engine) return;

  // 3rd person avatar: a visible cube
  avatarRoot = MeshBuilder.CreateBox("avatarCube", { size: 1.5 }, scene);
  avatarRoot.material = createSolidMat(scene, "avatarMat", new Color3(1, 0, 0));
  avatarRoot.position.set(0, 12, 0);
  avatarRoot.isPickable = false;
  avatarRoot.alwaysSelectAsActiveMesh = true;
  avatarRoot.isVisible = true;

  // first person arms: two small cubes
  fpArmsRoot = new Mesh("fpArms", scene);
  fpArmsRoot.isVisible = true;
  fpArmsRoot.alwaysSelectAsActiveMesh = true;

  const a1 = MeshBuilder.CreateBox("armL", { size: 0.6 }, scene);
  a1.parent = fpArmsRoot;
  a1.material = createSolidMat(scene, "armMatL", new Color3(0.2, 0.8, 0.2));
  a1.position.set(-0.6, -0.4, 1.4);
  a1.alwaysSelectAsActiveMesh = true;

  const a2 = MeshBuilder.CreateBox("armR", { size: 0.6 }, scene);
  a2.parent = fpArmsRoot;
  a2.material = createSolidMat(scene, "armMatR", new Color3(0.2, 0.8, 0.2));
  a2.position.set(0.6, -0.4, 1.4);
  a2.alwaysSelectAsActiveMesh = true;

  // Try attaching avatar to NOA player entity mesh component (best-effort)
  try {
    const entities = noa.entities;
    const playerEntity = noa.playerEntity;
    const meshCompName = entities.names?.mesh ?? "mesh";
    const addComp = entities["addComponent"];
    const hasComp = entities["hasComponent"];
    if (typeof addComp === "function") {
      if (!hasComp || !hasComp.call(entities, playerEntity, meshCompName)) {
        addComp.call(entities, playerEntity, meshCompName, {
          mesh: avatarRoot,
          offset: [0, 0, 0],
        });
      }
      console.log("[Avatar] attached to player entity via NOA mesh component");
    }
  } catch (e) {
    console.warn("[Avatar] attach failed (non-fatal):", e);
  }

  function applyViewMode() {
    const locked = isPointerLockedToNoa();
    const isFirst = viewMode === 0;

    // NOA camera zoom controls third person distance
    try {
      noa.camera.zoomDistance = isFirst ? 0 : 6;
    } catch {}

    // show avatar only in third
    if (avatarRoot) avatarRoot.setEnabled(!isFirst);

    // show arms only in first + locked
    const armsOn = isFirst && locked;
    if (fpArmsRoot) fpArmsRoot.setEnabled(armsOn);

    console.log("[applyViewMode] viewMode:", isFirst ? "first" : "third", "locked:", locked, "avatar:", !isFirst, "arms:", armsOn);
  }

  applyViewModeGlobal = applyViewMode;
  applyViewMode();
  document.addEventListener("pointerlockchange", applyViewMode);
}

(function bootAvatar() {
  let tries = 0;
  const t = setInterval(() => {
    tries++;
    initMinimalAvatarOnce();
    if (avatarRoot && fpArmsRoot) {
      clearInterval(t);
    } else if (tries > 50) {
      clearInterval(t);
      console.warn("[Avatar] Gave up initializing minimal avatar after retries.");
    }
  }, 200);
})();

/* ============================================================
 * beforeRender loop: move proof cubes in front of the active camera
 * + camera sanity checks
 * ============================================================
 */

let frameCounter = 0;

noa.on("beforeRender", function () {
  frameCounter++;

  // For each scene we discovered, force its frontCube in front of its activeCamera
  for (const entry of DIAG.scenes) {
    const scene = entry.scene;
    const cam = scene.activeCamera;
    const frontCube = entry.frontCube;
    if (!cam || !frontCube) continue;

    // force far clip huge (some engines clamp maxZ and you won't see objects)
    if (typeof cam.maxZ === "number" && cam.maxZ < 500) cam.maxZ = 5000;

    // Put cube in front of camera: position + forward vector
    // Babylon cameras expose getForwardRay or getDirection; both can exist
    let fwd = null;
    try {
      if (typeof cam.getForwardRay === "function") {
        fwd = cam.getForwardRay(1).direction;
      } else if (typeof cam.getDirection === "function") {
        fwd = cam.getDirection(new Vector3(0, 0, 1));
      }
    } catch {}

    if (!fwd) {
      // fallback: just park it near the camera
      frontCube.position.copyFrom(cam.position);
      frontCube.position.z += 2;
    } else {
      const pos = cam.position.add(fwd.scale(3));
      frontCube.position.copyFrom(pos);
    }

    frontCube.setEnabled(true);
    frontCube.isVisible = true;
  }

  // Also move arms root in front of NOA’s primary scene camera (best effort)
  const scene = resolveBabylonScene();
  if (scene && scene.activeCamera && fpArmsRoot && fpArmsRoot.isEnabled()) {
    const cam = scene.activeCamera;

    // Put arms root at camera position and slightly forward
    let fwd = null;
    try {
      if (typeof cam.getForwardRay === "function") fwd = cam.getForwardRay(1).direction;
      else if (typeof cam.getDirection === "function") fwd = cam.getDirection(new Vector3(0, 0, 1));
    } catch {}

    fpArmsRoot.position.copyFrom(cam.position);
    if (fwd) fpArmsRoot.position.addInPlace(fwd.scale(1.2));
  }

  // make sure our meshes are actually in the scene mesh array
  // (do NOT call isInFrustum; it can throw if frustum planes aren’t ready)
  if (frameCounter % 120 === 0) {
    const s0 = resolveBabylonScene();
    if (s0) {
      const cam = s0.activeCamera;
      console.log(
        "[Diag2] resolvedScene meshes=",
        s0.meshes.length,
        "activeCamera=",
        cam ? cam.name : "(none)",
        "cam.maxZ=",
        cam ? cam.maxZ : "(n/a)"
      );
      if (DIAG.scenes && DIAG.scenes[0] && DIAG.scenes[0].frontCube) {
        const fc = DIAG.scenes[0].frontCube;
        console.log(
          "[Diag2] frontCube in scene.meshes?",
          s0.meshes.includes(fc),
          "enabled?",
          fc?.isEnabled?.(),
          "visible?",
          fc?.isVisible
        );
      }
    }
  }
});

/* ============================================================
 * NOA tick (zoom with scroll for third person)
 * ============================================================
 */

noa.on("tick", function () {
  const scroll = noa.inputs.pointerState.scrolly;
  if (scroll !== 0 && viewMode !== 0) {
    noa.camera.zoomDistance += scroll > 0 ? 1 : -1;
    noa.camera.zoomDistance = clamp(noa.camera.zoomDistance, 2, 12);
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
 * Colyseus (kept minimal; does not affect rendering)
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

    // Your server sends "welcome" manually; register it so SDK stops warning
    room.onMessage("welcome", (msg) => console.log("[Colyseus] welcome:", msg));

    // broadcast debug
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
