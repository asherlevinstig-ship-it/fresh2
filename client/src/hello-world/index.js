// @ts-nocheck
/*
 * Fresh2 - hello-world (NOA main entry) - FULL REWRITE (NO OMITS)
 *
 * Fixes:
 * - Vite build: noa-engine has NO default export -> use named export { Engine }
 * - Custom meshes not visible: MUST register with NOA via noa.rendering.addMeshToScene(mesh,...)
 * (NOA uses its own selection/octree render list)
 *
 * Features:
 * - Crosshair overlay + click-to-pointerlock
 * - F5 toggles first/third person
 * - TEST A: "Truth cubes" in the actual rendering scene + a "frontCube" forced in front of camera
 * - Minimal avatar + minimal arms (cubes)
 * - Colyseus connect (unchanged conceptually)
 * * UPDATES (Fixes applied):
 * - Arms now parented to camera (Fixes 1st person visibility/rotation)
 * - Avatar manual sync improved (Fixes 3rd person visibility)
 */

import { Engine } from "noa-engine";
import { Client } from "@colyseus/sdk";

import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3 } from "@babylonjs/core/Maths/math.color";

/* ============================================================
 * NOA boot (named export)
 * ============================================================
 */

const opts = {
  debug: true,
  showFPS: true,
  chunkSize: 32,
  chunkAddDistance: 2.5,
  chunkRemoveDistance: 3.5,
};

console.log("========================================");
console.log("[NOA_BOOT] Using named export Engine. typeof Engine:", typeof Engine);
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
  inited: false,
  scene: null,
  engine: null,
  proofA: null,
  proofB: null,
  frontCube: null,
  avatar: null,
  armsRoot: null,
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
  // Prefer NOA container if present; else fall back
  const c = noaAny.container;
  if (c && typeof c === "object") return c;
  return document.getElementById("noa-container") || document.querySelector("canvas");
}

function isPointerLockedToNoa() {
  const target = getPointerLockTarget();
  return !!(target && document.pointerLockElement === target);
}

function getScene() {
  // per NOA docs: rendering.getScene() or rendering.scene
  try {
    if (noaAny.rendering && typeof noaAny.rendering.getScene === "function") return noaAny.rendering.getScene();
  } catch {}
  try {
    if (noaAny.rendering && noaAny.rendering.scene) return noaAny.rendering.scene;
  } catch {}
  return null;
}

function getBabylonEngine(scene) {
  try {
    if (scene && typeof scene.getEngine === "function") return scene.getEngine();
  } catch {}
  try {
    if (noaAny.rendering && noaAny.rendering.engine) return noaAny.rendering.engine;
  } catch {}
  return null;
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
    // Show in first person; optionally force
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
          // allow pointerlock in either mode (you can still unlock if you want)
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

    // If you want to auto-unlock when leaving first person, keep this:
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
 * Babylon helpers (materials/meshes)
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

/**
 * CRITICAL: register with NOA renderer so it actually draws.
 */
function noaRegisterMesh(mesh, isStatic = false) {
  try {
    // addMeshToScene(mesh, isStatic?, pos?, containingChunk?)
    noa.rendering.addMeshToScene(mesh, !!isStatic);
  } catch (e) {
    console.warn("[NOA_RENDER] addMeshToScene failed:", e);
  }
}

/* ============================================================
 * TEST A: Truth cubes (single real rendering scene)
 * ============================================================
 */

function initTruthTestsOnce() {
  if (DIAG.inited) return true;

  const scene = getScene();
  const engine = getBabylonEngine(scene);

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

  // Make it VERY obvious we touched the correct scene
  try {
    // clearColor in NOA defaults as array; Babylon scene.clearColor is Color4,
    // but assigning a Color3 usually works; if it doesn't, ignore.
    scene.clearColor = new Color3(1, 0, 1);
    console.log("[TestA] magenta clearColor set");
  } catch {}

  // Proof cubes
  const proofA = MeshBuilder.CreateBox("proof_A", { size: 3 }, scene);
  proofA.material = createSolidMat(scene, "mat_proof_A", new Color3(0, 1, 0));
  proofA.position.set(0, 14, 0);
  proofA.isPickable = false;
  proofA.alwaysSelectAsActiveMesh = true;
  proofA.isVisible = true;

  const proofB = MeshBuilder.CreateBox("proof_B", { size: 3 }, scene);
  proofB.material = createSolidMat(scene, "mat_proof_B", new Color3(1, 1, 0));
  proofB.position.set(6, 14, 0);
  proofB.isPickable = false;
  proofB.alwaysSelectAsActiveMesh = true;
  proofB.isVisible = true;

  // A cube we force in front of camera every frame
  const frontCube = MeshBuilder.CreateBox("frontCube", { size: 1.5 }, scene);
  frontCube.material = createSolidMat(scene, "mat_frontCube", new Color3(0, 0.6, 1));
  frontCube.isPickable = false;
  frontCube.alwaysSelectAsActiveMesh = true;
  frontCube.isVisible = true;

  // IMPORTANT: register with NOA, or they may never render
  noaRegisterMesh(proofA, true);
  noaRegisterMesh(proofB, true);
  noaRegisterMesh(frontCube, false);

  DIAG.proofA = proofA;
  DIAG.proofB = proofB;
  DIAG.frontCube = frontCube;

  DIAG.inited = true;

  console.log("[TestA] initialized: proof cubes + frontCube registered with noa.rendering.addMeshToScene");
  return true;
}

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
 * Minimal avatar + arms (cubes) - also registered with NOA
 * ============================================================
 */

function initMinimalAvatarOnce() {
  if (DIAG.avatar || DIAG.armsRoot) return;

  const scene = getScene();
  if (!scene) return;

  // 1. Avatar cube (visible in third person)
  const avatar = MeshBuilder.CreateBox("avatarCube", { size: 1.5 }, scene);
  avatar.material = createSolidMat(scene, "mat_avatar", new Color3(1, 0, 0));
  avatar.position.set(0, 12, 0);
  avatar.isPickable = false;
  avatar.alwaysSelectAsActiveMesh = true;
  avatar.isVisible = true;

  // 2. Arms root (visible in first person)
  const armsRoot = new Mesh("fpArmsRoot", scene);
  
  // FIX: Parent the arms to the active camera. 
  // This is the correct way to make UI/arms follow the view (rotation included).
  if (scene.activeCamera) {
    armsRoot.parent = scene.activeCamera;
  }
  
  // FIX: Render on top of geometry so they don't clip into walls
  armsRoot.renderingGroupId = 1;

  armsRoot.isPickable = false;
  armsRoot.alwaysSelectAsActiveMesh = true;
  armsRoot.isVisible = true;

  // Position children relative to the camera parent
  // (0,0,0) is the camera lens. +Z is forward. -Y is down.
  const armL = MeshBuilder.CreateBox("armL", { size: 0.6 }, scene);
  armL.parent = armsRoot;
  armL.material = createSolidMat(scene, "mat_armL", new Color3(0.2, 0.8, 0.2));
  armL.position.set(-0.6, -0.6, 1.5); // Left, Down, Forward
  armL.isPickable = false;
  armL.alwaysSelectAsActiveMesh = true;
  armL.renderingGroupId = 1; // Ensure child inherits sort order

  const armR = MeshBuilder.CreateBox("armR", { size: 0.6 }, scene);
  armR.parent = armsRoot;
  armR.material = createSolidMat(scene, "mat_armR", new Color3(0.2, 0.8, 0.2));
  armR.position.set(0.6, -0.6, 1.5); // Right, Down, Forward
  armR.isPickable = false;
  armR.alwaysSelectAsActiveMesh = true;
  armR.renderingGroupId = 1;

  // CRITICAL: register with NOA renderer
  noaRegisterMesh(avatar, false);
  noaRegisterMesh(armsRoot, false);

  // Best-effort attach avatar to player entity mesh component
  try {
    const ents = noa.entities;
    const playerEntity = noa.playerEntity;
    const meshCompName = ents.names?.mesh ?? "mesh";

    if (typeof ents.addComponent === "function") {
      if (!ents.hasComponent || !ents.hasComponent(playerEntity, meshCompName)) {
        ents.addComponent(playerEntity, meshCompName, {
          mesh: avatar,
          offset: [0, 0, 0],
        });
      }
      console.log("[Avatar] attached to player entity via NOA mesh component");
    }
  } catch (e) {
    console.warn("[Avatar] attach failed (non-fatal):", e);
  }

  function applyViewMode() {
    const isFirst = viewMode === 0;

    // NOA camera zoomDistance is the correct third-person distance knob
    try {
      const z = isFirst ? 0 : 6;
      noa.camera.zoomDistance = z;
      noa.camera.currentZoom = z;
    } catch {}

    // Avatar visible only in third person
    avatar.setEnabled(!isFirst);

    // Arms visible only in first person
    const armsOn = isFirst;
    armsRoot.setEnabled(armsOn);

    console.log("[applyViewMode] viewMode:", isFirst ? "first" : "third", "avatar:", !isFirst, "arms:", armsOn);
  }

  applyViewModeGlobal = applyViewMode;
  applyViewMode();

  document.addEventListener("pointerlockchange", () => {
    try {
      applyViewMode();
    } catch {}
  });

  DIAG.avatar = avatar;
  DIAG.armsRoot = armsRoot;
}

(function bootAvatar() {
  let tries = 0;
  const t = setInterval(() => {
    tries++;
    initMinimalAvatarOnce();
    if (DIAG.avatar && DIAG.armsRoot) {
      clearInterval(t);
    } else if (tries > 80) {
      clearInterval(t);
      console.warn("[Avatar] Gave up initializing minimal avatar after retries.");
    }
  }, 150);
})();

/* ============================================================
 * beforeRender loop
 * - force frontCube in front of camera
 * - position avatar at player location (backup logic)
 * ============================================================
 */

let frameCounter = 0;

noa.on("beforeRender", function () {
  frameCounter++;

  const scene = getScene();
  const cam = scene?.activeCamera;

  // Force the "frontCube" in front of the active camera
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

  // --- ARMS LOGIC REMOVED ---
  // The arms are now parented to the camera in initMinimalAvatarOnce. 
  // We do NOT manually position them here, or it will conflict with the parent transform.

  // Failsafe: keep avatar at player position (third-person only)
  // Also sync rotation from the player entity mesh data if available
  if (DIAG.avatar && DIAG.avatar.isEnabled()) {
    try {
      const p = noa.entities.getPosition(noa.playerEntity);
      if (p && p.length >= 3) {
        // Position: Add small offset so it stands on ground, not in it
        DIAG.avatar.position.set(p[0], p[1] + 0.75, p[2]);
        
        // Rotation: Attempt to read rotation from entity data to make 3rd person model turn
        const meshDat = noa.entities.getMeshData(noa.playerEntity);
        if (meshDat && meshDat.mesh && meshDat.mesh.rotation) {
             DIAG.avatar.rotation.y = meshDat.mesh.rotation.y;
        }
      }
    } catch (e) {
      // ignore
    }
  }

  // periodic diagnostics
  if (frameCounter % 180 === 0) {
    const s0 = getScene();
    const c0 = s0?.activeCamera;
    console.log(
      "[Diag] sceneMeshes=",
      s0 ? s0.meshes.length : "(no scene)",
      "activeCamera=",
      c0 ? c0.name : "(none)",
      "zoomDistance=",
      safeNum(noa.camera.zoomDistance, -1),
      "currentZoom=",
      safeNum(noa.camera.currentZoom, -1),
      "viewMode=",
      viewMode
    );
  }
});

/* ============================================================
 * NOA tick: zoom with scroll (third person)
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