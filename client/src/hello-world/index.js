// @ts-nocheck
/*
 * Fresh2 - hello-world (NOA main entry) - FULL REWRITE (NO OMITS)
 *
 * Hard facts from your logs + docs:
 * - Your build exposes: NOA_MOD.Engine is a function (constructor) and there is NO default export.
 * - NOA Rendering docs: you MUST call `noa.rendering.addMeshToScene(mesh, ...)`
 *   or custom Babylon meshes can exist (enabled/visible/in scene.meshes) yet still NOT render.
 *
 * Goals:
 * 1) Fix boot reliably for your export shape: `import { Engine } from "noa-engine"` + `new Engine(opts)`
 * 2) Add Crosshair + PointerLock (click-to-lock).
 * 3) TEST A: Scene/Render truth tests that MUST be visible:
 *    - Create big proof cubes
 *    - Create a frontCube that is forced in front of camera each frame
 *    - CRITICAL: register ALL proof meshes with `noa.rendering.addMeshToScene`
 * 4) Player arms (first person) + avatar (third person), both MUST be visible:
 *    - register all meshes with `addMeshToScene`
 *    - set zoomDistance + currentZoom when toggling view mode
 * 5) Keep your Colyseus logic minimal and intact
 *
 * Keys:
 * - F5 = toggle first/third
 * - F6 = toggle forceCrosshair
 */

import { Engine } from "noa-engine";
import { Client } from "@colyseus/sdk";

import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3 } from "@babylonjs/core/Maths/math.color";

/* ============================================================
 * NOA bootstrap (Engine constructor - matches your build)
 * ============================================================
 */

const opts = {
  debug: true,
  showFPS: true,
  chunkSize: 32,
  chunkAddDistance: 2.5,
  chunkRemoveDistance: 3.5,

  // these are valid engine options per docs you pasted (safe to include)
  stickyPointerLock: true,
  dragCameraOutsidePointerLock: true,
};

console.log("========================================");
console.log("[NOA_BOOT] typeof Engine:", typeof Engine);
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

let applyViewModeGlobal = null;

let colyRoom = null;

/** Babylon diagnostics storage */
const DIAG = {
  scene: null,
  engine: null,

  proof1: null,
  proof2: null,
  frontCube: null,

  avatarRoot: null,
  fpArmsRoot: null,
  armL: null,
  armR: null,

  initTruthDone: false,
  initAvatarDone: false,
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

/**
 * Resolve the actual Babylon scene/engine used by NOA.
 */
function resolveBabylonScene() {
  const r = noaAny.rendering;

  try {
    if (r && typeof r.getScene === "function") {
      const s = r.getScene();
      if (s) return s;
    }
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
 * CRITICAL: register a Babylon mesh with NOA so it is included
 * in NOA's selection/octree render logic and actually draws.
 */
function noaAddMesh(mesh, isStatic = false, pos = null, containingChunk = null) {
  try {
    noa.rendering.addMeshToScene(mesh, !!isStatic, pos || null, containingChunk || null);
  } catch (e) {
    console.warn("[NOA_RENDER] addMeshToScene failed:", e);
  }
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
    // show always if forced; otherwise show in first person
    const show = forceCrosshair || viewMode === 0 || locked;
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
          // allow pointer lock in any mode (you can still unlock via ESC)
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

    // optionally unlock when leaving first person
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
    console.log("[Crosshair] forced:", forceCrosshair);
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
 * TEST A: Scene/Render truth tests
 * ============================================================
 */

function createSolidMat(scene, name, color) {
  const mat = new StandardMaterial(name, scene);
  mat.diffuseColor = color;
  mat.emissiveColor = color.scale(0.45);
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
  box.alwaysSelectAsActiveMesh = true;
  return box;
}

function createFrontCube(scene) {
  const box = MeshBuilder.CreateBox("frontCube", { size: 1.5 }, scene);
  box.material = createSolidMat(scene, "mat_frontCube", new Color3(0, 0.6, 1));
  box.isPickable = false;
  box.isVisible = true;
  box.alwaysSelectAsActiveMesh = true;
  return box;
}

function initTruthTestsOnce() {
  if (DIAG.initTruthDone) return true;

  const scene = resolveBabylonScene();
  const engine = resolveBabylonEngine(scene);

  if (!scene || !engine) return false;

  DIAG.scene = scene;
  DIAG.engine = engine;

  console.log(
    "[NOA] scene exists?",
    !!scene,
    "activeCamera exists?",
    !!(scene && scene.activeCamera),
    "cameraType:",
    scene && scene.activeCamera ? scene.activeCamera.getClassName?.() || scene.activeCamera.constructor?.name : "(none)"
  );

  // magenta-ish sky
  try {
    // clearColor is normally Color4; some builds accept Color3.
    // If it throws, ignore.
    scene.clearColor = new Color3(1, 0, 1);
    console.log("[TestA] magenta clearColor set");
  } catch {}

  // create proof meshes
  const proof1 = createProofCube(scene, "A", new Color3(0, 1, 0), new Vector3(0, 14, 0));
  const proof2 = createProofCube(scene, "B", new Color3(1, 1, 0), new Vector3(6, 14, 0));
  const frontCube = createFrontCube(scene);

  // CRITICAL: register with NOA rendering selection/octree
  noaAddMesh(proof1, true);
  noaAddMesh(proof2, true);
  noaAddMesh(frontCube, false);

  DIAG.proof1 = proof1;
  DIAG.proof2 = proof2;
  DIAG.frontCube = frontCube;

  console.log("[TestA] proof meshes created + registered with noa.rendering.addMeshToScene");

  DIAG.initTruthDone = true;
  return true;
}

// Retry init until we can resolve scene/engine
(function bootTruthTests() {
  let tries = 0;
  const t = setInterval(() => {
    tries++;
    if (initTruthTestsOnce()) {
      clearInterval(t);
    } else if (tries > 80) {
      clearInterval(t);
      console.warn("[TestA] Gave up resolving Babylon scene/engine after retries.");
    }
  }, 150);
})();

/* ============================================================
 * Arms + 3rd-person avatar (minimal cubes, registered with NOA)
 * ============================================================
 */

function initAvatarOnce() {
  if (DIAG.initAvatarDone) return true;

  const scene = resolveBabylonScene();
  if (!scene) return false;

  // 3rd-person avatar cube
  const avatarRoot = MeshBuilder.CreateBox("avatarCube", { size: 1.5 }, scene);
  avatarRoot.material = createSolidMat(scene, "avatarMat", new Color3(1, 0, 0));
  avatarRoot.position.set(0, 12, 0);
  avatarRoot.isPickable = false;
  avatarRoot.alwaysSelectAsActiveMesh = true;
  avatarRoot.isVisible = true;

  // first-person arms
  const fpArmsRoot = new Mesh("fpArmsRoot", scene);
  fpArmsRoot.isPickable = false;
  fpArmsRoot.alwaysSelectAsActiveMesh = true;
  fpArmsRoot.isVisible = true;

  const armL = MeshBuilder.CreateBox("armL", { size: 0.6 }, scene);
  armL.parent = fpArmsRoot;
  armL.material = createSolidMat(scene, "armMatL", new Color3(0.2, 0.8, 0.2));
  armL.position.set(-0.6, -0.4, 1.4);
  armL.isPickable = false;
  armL.alwaysSelectAsActiveMesh = true;
  armL.isVisible = true;

  const armR = MeshBuilder.CreateBox("armR", { size: 0.6 }, scene);
  armR.parent = fpArmsRoot;
  armR.material = createSolidMat(scene, "armMatR", new Color3(0.2, 0.8, 0.2));
  armR.position.set(0.6, -0.4, 1.4);
  armR.isPickable = false;
  armR.alwaysSelectAsActiveMesh = true;
  armR.isVisible = true;

  // CRITICAL: register with NOA rendering selection/octree
  // Register root + children to be absolutely sure
  noaAddMesh(avatarRoot, false);
  noaAddMesh(fpArmsRoot, false);
  noaAddMesh(armL, false);
  noaAddMesh(armR, false);

  // try to attach avatar to NOA player entity mesh component (best effort)
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

  DIAG.avatarRoot = avatarRoot;
  DIAG.fpArmsRoot = fpArmsRoot;
  DIAG.armL = armL;
  DIAG.armR = armR;

  function applyViewMode() {
    const locked = isPointerLockedToNoa();
    const isFirst = viewMode === 0;

    // Snap camera between 1st/3rd.
    // Writing currentZoom helps force immediate application.
    try {
      const z = isFirst ? 0 : 6;
      noa.camera.zoomDistance = z;
      noa.camera.currentZoom = z;
    } catch {}

    // avatar visible only in third person
    if (DIAG.avatarRoot) DIAG.avatarRoot.setEnabled(!isFirst);

    // arms visible only in first person
    // We DO NOT require pointerlock to show arms (otherwise it feels "broken").
    // If you want locked-only, change to: const armsOn = isFirst && locked;
    const armsOn = isFirst;
    if (DIAG.fpArmsRoot) DIAG.fpArmsRoot.setEnabled(armsOn);

    // keep crosshair in sync
    try {
      crosshairUI.refresh();
    } catch {}

    console.log(
      "[applyViewMode] viewMode:",
      isFirst ? "first" : "third",
      "locked:",
      locked,
      "avatar:",
      !isFirst,
      "arms:",
      armsOn,
      "zoomDistance:",
      safeNum(noa.camera.zoomDistance, -1),
      "currentZoom:",
      safeNum(noa.camera.currentZoom, -1)
    );
  }

  applyViewModeGlobal = applyViewMode;
  applyViewMode();
  document.addEventListener("pointerlockchange", applyViewMode);

  DIAG.initAvatarDone = true;
  return true;
}

(function bootAvatar() {
  let tries = 0;
  const t = setInterval(() => {
    tries++;
    if (initAvatarOnce()) {
      clearInterval(t);
    } else if (tries > 80) {
      clearInterval(t);
      console.warn("[Avatar] Gave up initializing after retries.");
    }
  }, 150);
})();

/* ============================================================
 * beforeRender loop: move frontCube in front of camera
 * + position arms + (failsafe) keep avatar near player
 * ============================================================
 */

let frameCounter = 0;

noa.on("beforeRender", function () {
  frameCounter++;

  const scene = resolveBabylonScene();
  const cam = scene && scene.activeCamera ? scene.activeCamera : null;

  // Move frontCube in front of camera (guaranteed visible if rendering works)
  if (cam && DIAG.frontCube) {
    try {
      if (typeof cam.maxZ === "number" && cam.maxZ < 500) cam.maxZ = 10000;
    } catch {}

    let fwd = null;
    try {
      if (typeof cam.getForwardRay === "function") fwd = cam.getForwardRay(1).direction;
      else if (typeof cam.getDirection === "function") fwd = cam.getDirection(new Vector3(0, 0, 1));
    } catch {}

    if (!fwd) {
      DIAG.frontCube.position.copyFrom(cam.position);
      DIAG.frontCube.position.z += 2;
    } else {
      DIAG.frontCube.position.copyFrom(cam.position.add(fwd.scale(3)));
    }

    DIAG.frontCube.setEnabled(true);
    DIAG.frontCube.isVisible = true;
  }

  // Position arms in front of camera (first-person only)
  if (cam && DIAG.fpArmsRoot && DIAG.fpArmsRoot.isEnabled()) {
    let fwd = null;
    try {
      if (typeof cam.getForwardRay === "function") fwd = cam.getForwardRay(1).direction;
      else if (typeof cam.getDirection === "function") fwd = cam.getDirection(new Vector3(0, 0, 1));
    } catch {}

    DIAG.fpArmsRoot.position.copyFrom(cam.position);
    if (fwd) DIAG.fpArmsRoot.position.addInPlace(fwd.scale(1.2));
  }

  // Failsafe: keep avatar at player position when enabled (third-person)
  if (DIAG.avatarRoot && DIAG.avatarRoot.isEnabled()) {
    try {
      const p = noa.entities.getPosition(noa.playerEntity);
      if (p && p.length >= 3) {
        DIAG.avatarRoot.position.set(p[0], p[1] + 0.9, p[2]);
      }
    } catch {}
  }

  // periodic diagnostics
  if (frameCounter % 180 === 0) {
    const s0 = resolveBabylonScene();
    const c0 = s0 && s0.activeCamera ? s0.activeCamera : null;

    console.log(
      "[Diag] meshes=",
      s0 ? s0.meshes.length : "(no scene)",
      "camera=",
      c0 ? c0.name : "(none)",
      "viewMode=",
      viewMode,
      "zoomDistance=",
      safeNum(noa.camera.zoomDistance, -1),
      "currentZoom=",
      safeNum(noa.camera.currentZoom, -1),
      "frontCubeEnabled=",
      DIAG.frontCube ? DIAG.frontCube.isEnabled?.() : "(none)",
      "frontCubeVisible=",
      DIAG.frontCube ? DIAG.frontCube.isVisible : "(none)"
    );
  }
});

/* ============================================================
 * NOA tick (zoom with scroll for third person)
 * ============================================================
 */

noa.on("tick", function () {
  const scroll = noa.inputs.pointerState.scrolly;
  if (scroll !== 0 && viewMode !== 0) {
    const delta = scroll > 0 ? 1 : -1;
    noa.camera.zoomDistance = clamp(noa.camera.zoomDistance + delta, 2, 12);

    // snap currentZoom as well
    try {
      noa.camera.currentZoom = noa.camera.zoomDistance;
    } catch {}
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

    // server sends "welcome"
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
