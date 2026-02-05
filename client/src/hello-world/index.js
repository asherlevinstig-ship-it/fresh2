// @ts-nocheck
/*
 * Fresh2 - hello-world (NOA main entry) - FULL REWRITE (NO OMITS)
 *
 * CORE FIXES:
 * 1) Use NOA's Engine constructor: import { Engine } from "noa-engine"
 * 2) Use the SAME Babylon package as NOA: import * as BABYLON from "babylonjs"
 *    (Do NOT mix @babylonjs/core with NOA unless you really know both are unified.)
 * 3) Custom meshes MUST be registered with noa.rendering.addMeshToScene
 * 4) Do NOT use F5 for toggles (browser-reserved). Use V for view toggle, C for crosshair toggle.
 *
 * Keys:
 * - V = toggle first/third
 * - C = toggle forceCrosshair
 * - E = alt-fire (place)
 * - Mouse1 = fire (break)
 */

import { Engine } from "noa-engine";
import { Client } from "@colyseus/sdk";
import * as BABYLON from "babylonjs";

/* ============================================================
 * NOA bootstrap
 * ============================================================
 */

const opts = {
  debug: true,
  showFPS: true,
  chunkSize: 32,
  chunkAddDistance: 2.5,
  chunkRemoveDistance: 3.5,

  stickyPointerLock: true,
  dragCameraOutsidePointerLock: true,
};

console.log("========================================");
console.log("[NOA_BOOT] typeof Engine:", typeof Engine);
console.log("[NOA_BOOT] typeof BABYLON:", typeof BABYLON, "BABYLON.Engine:", typeof BABYLON.Engine);
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

const DIAG = {
  scene: null,
  engine: null,

  proofA: null,
  proofB: null,
  frontCube: null,

  avatar: null,
  armsRoot: null,
  armL: null,
  armR: null,

  initedTruth: false,
  initedAvatar: false,
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
  const c = noaAny.container;
  if (c && typeof c === "object") return c;
  return document.getElementById("noa-container") || document.querySelector("canvas");
}

function isPointerLockedToNoa() {
  const target = getPointerLockTarget();
  return !!(target && document.pointerLockElement === target);
}

function resolveScene() {
  const r = noaAny.rendering;
  try {
    if (r && typeof r.getScene === "function") return r.getScene();
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
    const show = forceCrosshair || viewMode === 0 || locked;
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
    const target = getPointerLockTarget();
    if (!target) return;

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
 * Key handlers (NO F5 - use V / C)
 * ============================================================
 */

document.addEventListener("keydown", (e) => {
  if (e.code === "KeyV") {
    e.preventDefault();
    viewMode = (viewMode + 1) % 2;

    // optional unlock when leaving first person
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

  if (e.code === "KeyC") {
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
 * Materials / Meshes (BABYLONJS package - SAME FAMILY AS NOA)
 * ============================================================
 */

function createSolidMat(scene, name, color3) {
  const mat = new BABYLON.StandardMaterial(name, scene);
  mat.diffuseColor = color3;
  mat.emissiveColor = color3.scale(0.6);
  mat.specularColor = new BABYLON.Color3(0, 0, 0);
  mat.backFaceCulling = false;
  return mat;
}

/* ============================================================
 * TEST A: Proof cubes + frontCube (registered with NOA)
 * ============================================================
 */

function initTruthOnce() {
  if (DIAG.initedTruth) return true;

  const scene = resolveScene();
  const engine = resolveBabylonEngine(scene);
  if (!scene || !engine) return false;

  DIAG.scene = scene;
  DIAG.engine = engine;

  console.log(
    "[NOA] scene exists?",
    !!scene,
    "activeCamera exists?",
    !!scene.activeCamera,
    "cameraType:",
    scene.activeCamera ? scene.activeCamera.getClassName?.() || scene.activeCamera.constructor?.name : "(none)"
  );

  // Try unfreezing (some pipelines freeze active meshes)
  try {
    console.log("[Diag] _activeMeshesFrozen:", scene._activeMeshesFrozen);
    if (typeof scene.unfreezeActiveMeshes === "function") scene.unfreezeActiveMeshes();
  } catch {}

  // Make camera clipping forgiving
  try {
    if (scene.activeCamera) {
      scene.activeCamera.minZ = 0.05;
      scene.activeCamera.maxZ = 10000;
    }
  } catch {}

  // Color the background (if accepted)
  try {
    scene.clearColor = new BABYLON.Color4(1, 0, 1, 1);
    console.log("[TestA] magenta clearColor set (Color4)");
  } catch {}

  // Proof cubes
  const proofA = BABYLON.MeshBuilder.CreateBox("proofA", { size: 3 }, scene);
  proofA.material = createSolidMat(scene, "mat_proofA", new BABYLON.Color3(0, 1, 0));
  proofA.position.set(0, 14, 0);
  proofA.isPickable = false;
  proofA.alwaysSelectAsActiveMesh = true;
  proofA.isVisible = true;

  const proofB = BABYLON.MeshBuilder.CreateBox("proofB", { size: 3 }, scene);
  proofB.material = createSolidMat(scene, "mat_proofB", new BABYLON.Color3(1, 1, 0));
  proofB.position.set(6, 14, 0);
  proofB.isPickable = false;
  proofB.alwaysSelectAsActiveMesh = true;
  proofB.isVisible = true;

  // Front cube glued to camera direction
  const frontCube = BABYLON.MeshBuilder.CreateBox("frontCube", { size: 1.5 }, scene);
  frontCube.material = createSolidMat(scene, "mat_frontCube", new BABYLON.Color3(0, 0.6, 1));
  frontCube.isPickable = false;
  frontCube.alwaysSelectAsActiveMesh = true;
  frontCube.isVisible = true;

  // CRITICAL: register with NOA
  noaAddMesh(proofA, true);
  noaAddMesh(proofB, true);
  noaAddMesh(frontCube, false);

  DIAG.proofA = proofA;
  DIAG.proofB = proofB;
  DIAG.frontCube = frontCube;

  DIAG.initedTruth = true;

  console.log("[TestA] initialized: proofA/proofB/frontCube created with BABYLONJS + registered with NOA");
  return true;
}

(function bootTruth() {
  let tries = 0;
  const t = setInterval(() => {
    tries++;
    if (initTruthOnce()) clearInterval(t);
    else if (tries > 120) {
      clearInterval(t);
      console.warn("[TestA] Gave up resolving Babylon scene/engine.");
    }
  }, 100);
})();

/* ============================================================
 * Avatar + Arms (registered + camera-parented arms)
 * ============================================================
 */

function initAvatarOnce() {
  if (DIAG.initedAvatar) return true;

  const scene = resolveScene();
  if (!scene) return false;

  // Avatar cube (3rd person)
  const avatar = BABYLON.MeshBuilder.CreateBox("avatarCube", { size: 1.5 }, scene);
  avatar.material = createSolidMat(scene, "mat_avatar", new BABYLON.Color3(1, 0, 0));
  avatar.position.set(0, 12, 0);
  avatar.isPickable = false;
  avatar.alwaysSelectAsActiveMesh = true;
  avatar.isVisible = true;

  // Arms root (1st person)
  const armsRoot = new BABYLON.TransformNode("armsRoot", scene);

  const armL = BABYLON.MeshBuilder.CreateBox("armL", { size: 0.6 }, scene);
  armL.parent = armsRoot;
  armL.material = createSolidMat(scene, "mat_armL", new BABYLON.Color3(0.2, 0.8, 0.2));
  armL.position.set(-0.6, -0.4, 1.1);
  armL.isPickable = false;
  armL.alwaysSelectAsActiveMesh = true;
  armL.isVisible = true;

  const armR = BABYLON.MeshBuilder.CreateBox("armR", { size: 0.6 }, scene);
  armR.parent = armsRoot;
  armR.material = createSolidMat(scene, "mat_armR", new BABYLON.Color3(0.2, 0.8, 0.2));
  armR.position.set(0.6, -0.4, 1.1);
  armR.isPickable = false;
  armR.alwaysSelectAsActiveMesh = true;
  armR.isVisible = true;

  // CRITICAL: register with NOA
  noaAddMesh(avatar, false);
  noaAddMesh(armL, false);
  noaAddMesh(armR, false);

  // Attempt to attach avatar to player entity (best effort)
  try {
    const ents = noa.entities;
    const playerEntity = noa.playerEntity;
    const meshCompName = ents.names?.mesh ?? "mesh";
    if (typeof ents.addComponent === "function") {
      if (!ents.hasComponent || !ents.hasComponent(playerEntity, meshCompName)) {
        ents.addComponent(playerEntity, meshCompName, { mesh: avatar, offset: [0, 0, 0] });
      }
      console.log("[Avatar] attached to player entity via NOA mesh component");
    }
  } catch (e) {
    console.warn("[Avatar] attach failed (non-fatal):", e);
  }

  DIAG.avatar = avatar;
  DIAG.armsRoot = armsRoot;
  DIAG.armL = armL;
  DIAG.armR = armR;

  function applyViewMode() {
    const isFirst = viewMode === 0;

    // snap camera zoom
    try {
      const z = isFirst ? 0 : 6;
      noa.camera.zoomDistance = z;
      noa.camera.currentZoom = z;
      noa.camera.zoomSpeed = 1; // move immediately
    } catch {}

    // show avatar only in third person
    if (DIAG.avatar) DIAG.avatar.setEnabled(!isFirst);

    // show arms only in first person (do NOT require pointerlock)
    if (DIAG.armL) DIAG.armL.setEnabled(isFirst);
    if (DIAG.armR) DIAG.armR.setEnabled(isFirst);

    crosshairUI.refresh();

    console.log("[applyViewMode] viewMode:", isFirst ? "first" : "third", "avatar:", !isFirst, "arms:", isFirst);
  }

  applyViewModeGlobal = applyViewMode;
  applyViewMode();
  document.addEventListener("pointerlockchange", applyViewMode);

  DIAG.initedAvatar = true;
  return true;
}

(function bootAvatar() {
  let tries = 0;
  const t = setInterval(() => {
    tries++;
    if (initAvatarOnce()) clearInterval(t);
    else if (tries > 120) {
      clearInterval(t);
      console.warn("[Avatar] Gave up initializing avatar/arms.");
    }
  }, 100);
})();

/* ============================================================
 * beforeRender: glue frontCube + arms to camera
 * ============================================================
 */

let frameCounter = 0;

noa.on("beforeRender", function () {
  frameCounter++;

  const scene = resolveScene();
  const cam = scene?.activeCamera;

  if (cam) {
    try {
      cam.minZ = 0.05;
      if (cam.maxZ < 5000) cam.maxZ = 10000;
    } catch {}
  }

  // frontCube in front of camera
  if (cam && DIAG.frontCube) {
    let fwd = null;
    try {
      if (typeof cam.getForwardRay === "function") fwd = cam.getForwardRay(1).direction;
      else if (typeof cam.getDirection === "function") fwd = cam.getDirection(new BABYLON.Vector3(0, 0, 1));
    } catch {}

    if (!fwd) {
      DIAG.frontCube.position.copyFrom(cam.position);
      DIAG.frontCube.position.z += 2;
    } else {
      const pos = cam.position.add(fwd.scale(3));
      DIAG.frontCube.position.copyFrom(pos);
    }

    DIAG.frontCube.setEnabled(true);
    DIAG.frontCube.isVisible = true;
  }

  // Arms: parent the transform node to the camera every frame (cannot drift)
  if (cam && DIAG.armsRoot && DIAG.armL?.isEnabled?.() && DIAG.armR?.isEnabled?.()) {
    try {
      // In Babylon, a TransformNode can parent to the camera
      DIAG.armsRoot.parent = cam;

      // local offsets relative to camera
      DIAG.armsRoot.position.set(0, 0, 0);

      // Ensure arms are slightly forward and down from camera
      // (arms themselves already have local offsets)
    } catch {}
  }

  // periodic diag
  if (frameCounter % 180 === 0) {
    console.log(
      "[Diag] sceneMeshes=",
      scene ? scene.meshes.length : "(no scene)",
      "activeCamera=",
      cam ? cam.name : "(none)",
      "zoomDistance=",
      safeNum(noa.camera.zoomDistance, -1),
      "currentZoom=",
      safeNum(noa.camera.currentZoom, -1),
      "viewMode=",
      viewMode,
      "frontCubeEnabled=",
      DIAG.frontCube ? DIAG.frontCube.isEnabled?.() : "(none)",
      "armLEnabled=",
      DIAG.armL ? DIAG.armL.isEnabled?.() : "(none)"
    );
  }
});

/* ============================================================
 * tick: scroll zoom in third person
 * ============================================================
 */

noa.on("tick", function () {
  const scroll = noa.inputs.pointerState.scrolly;
  if (scroll !== 0 && viewMode !== 0) {
    const delta = scroll > 0 ? 1 : -1;
    noa.camera.zoomDistance = clamp(noa.camera.zoomDistance + delta, 2, 12);
    noa.camera.currentZoom = noa.camera.zoomDistance;
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
 * Colyseus (minimal)
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

    room.onMessage("welcome", (msg) => console.log("[Colyseus] welcome:", msg));
    room.onMessage("*", (type, message) => console.log("[Colyseus] msg:", type, message));

    room.onLeave(() => {
      console.warn("[Colyseus] left");
      colyRoom = null;
    });

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
