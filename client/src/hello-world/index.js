// @ts-nocheck
/*
 * Fresh2 - hello-world (NOA main entry) - FULL REWRITE (NO OMITS)
 *
 * What this version does (Minecraft-style presentation on top of NOA):
 * - Uses NOA as the Minecraft-style controller (movement/camera/targeting/world)
 * - Adds a presentation layer:
 *   1) FPS arms/tool rig (camera-attached) with sway + bob + swing animation
 *   2) 3rd-person blocky avatar (player-attached) with walk + swing animations
 *   3) Simple animation state machine: idle/walk/run/jump/fall/swing
 *
 * Critical compatibility:
 * - Use the SAME Babylon runtime as NOA: `babylonjs`
 * - Custom meshes must be registered with `noa.rendering.addMeshToScene(mesh, ...)`
 *
 * Controls:
 * - V : toggle first/third person
 * - C : toggle forced crosshair
 * - P : toggle debug proof meshes
 * - Mouse1 (fire): break block + swing
 * - E (alt-fire): place block + swing
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

  // camera module options
  initialZoom: 0,
  zoomSpeed: 0.25,
};

console.log("========================================");
console.log("[NOA_BOOT] typeof Engine:", typeof Engine);
console.log("[NOA_BOOT] BABYLON.Engine:", typeof BABYLON.Engine);
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
let showDebugProof = false;

let colyRoom = null;

const STATE = {
  scene: null,
  engine: null,
  camFollowState: null,
  baseFollowOffset: [0, 0, 0],

  lastTime: performance.now(),

  // camera deltas for sway
  lastHeading: 0,
  lastPitch: 0,

  // bob
  bobPhase: 0,

  // player pos fallback
  lastPlayerPos: null,

  // animation
  swingT: 999, // seconds since last swing
  swingDuration: 0.22,

  animState: "idle", // idle/walk/run/jump/fall/swing
};

const MESH = {
  // debug proof
  proofA: null,
  proofB: null,
  frontCube: null,

  // FPS rig
  weaponRoot: null, // TransformNode parented to camera
  armsRoot: null, // TransformNode under weaponRoot
  armL: null,
  armR: null,
  tool: null,

  // 3rd person avatar rig
  avatarRoot: null, // TransformNode at player pos
  avHead: null,
  avBody: null,
  avArmL: null,
  avArmR: null,
  avLegL: null,
  avLegR: null,
  avTool: null,
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

function lerp(a, b, t) {
  return a + (b - a) * t;
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

/**
 * CRITICAL: register meshes with NOA so they actually render.
 */
function noaAddMesh(mesh, isStatic = false, pos = null, containingChunk = null) {
  try {
    noa.rendering.addMeshToScene(mesh, !!isStatic, pos || null, containingChunk || null);
  } catch (e) {
    console.warn("[NOA_RENDER] addMeshToScene failed:", e);
  }
}

function setEnabled(meshOrNode, on) {
  if (!meshOrNode) return;
  try {
    if (typeof meshOrNode.setEnabled === "function") meshOrNode.setEnabled(!!on);
  } catch {}
}

function createSolidMat(scene, name, color3) {
  const mat = new BABYLON.StandardMaterial(name, scene);
  mat.diffuseColor = color3;
  mat.emissiveColor = color3.scale(0.35);
  mat.specularColor = new BABYLON.Color3(0, 0, 0);
  mat.backFaceCulling = false;
  return mat;
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
  setInterval(refresh, 200);

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
 * Key handlers
 * ============================================================
 */

document.addEventListener("keydown", (e) => {
  if (e.code === "KeyV") {
    e.preventDefault();
    viewMode = (viewMode + 1) % 2;

    // optional unlock when leaving first-person
    if (viewMode !== 0) {
      try {
        document.exitPointerLock?.();
      } catch {}
    }

    applyViewMode();
    crosshairUI.refresh();
    console.log("[View] mode:", viewMode === 0 ? "first" : "third");
  }

  if (e.code === "KeyC") {
    e.preventDefault();
    forceCrosshair = !forceCrosshair;
    crosshairUI.refresh();
    console.log("[Crosshair] forced:", forceCrosshair);
  }

  if (e.code === "KeyP") {
    e.preventDefault();
    showDebugProof = !showDebugProof;
    refreshDebugProofMeshes();
    console.log("[DebugProof] show:", showDebugProof);
  }
});

/* ============================================================
 * Worldgen
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
 * Scene init (NOA scene + cameraTarget follow state)
 * ============================================================
 */

function ensureSceneReadyOnce() {
  if (STATE.scene && STATE.engine) return true;

  const scene = resolveScene();
  const engine = resolveBabylonEngine(scene);
  if (!scene || !engine) return false;

  STATE.scene = scene;
  STATE.engine = engine;

  // generous clipping
  try {
    if (scene.activeCamera) {
      scene.activeCamera.minZ = 0.05;
      scene.activeCamera.maxZ = 10000;
    }
  } catch {}

  // follow entity offset baseline (cameraTarget follows player by default)
  try {
    const st = noa.ents.getState(noa.camera.cameraTarget, "followsEntity");
    STATE.camFollowState = st || null;
    STATE.baseFollowOffset = st?.offset ? [st.offset[0], st.offset[1], st.offset[2]] : [0, 0, 0];
  } catch {
    STATE.camFollowState = null;
    STATE.baseFollowOffset = [0, 0, 0];
  }

  console.log("[Scene] ready. camera:", scene.activeCamera?.name, "baseFollowOffset:", STATE.baseFollowOffset);
  return true;
}

/* ============================================================
 * Debug proof meshes (toggle with P)
 * ============================================================
 */

function initDebugProofMeshesOnce() {
  if (!ensureSceneReadyOnce()) return false;
  if (MESH.proofA || MESH.frontCube) return true;

  const scene = STATE.scene;

  const proofA = BABYLON.MeshBuilder.CreateBox("proofA", { size: 3 }, scene);
  proofA.material = createSolidMat(scene, "mat_proofA", new BABYLON.Color3(0, 1, 0));
  proofA.position.set(0, 14, 0);
  proofA.isPickable = false;
  proofA.alwaysSelectAsActiveMesh = true;

  const proofB = BABYLON.MeshBuilder.CreateBox("proofB", { size: 3 }, scene);
  proofB.material = createSolidMat(scene, "mat_proofB", new BABYLON.Color3(1, 1, 0));
  proofB.position.set(6, 14, 0);
  proofB.isPickable = false;
  proofB.alwaysSelectAsActiveMesh = true;

  const frontCube = BABYLON.MeshBuilder.CreateBox("frontCube", { size: 1.5 }, scene);
  frontCube.material = createSolidMat(scene, "mat_frontCube", new BABYLON.Color3(0, 0.6, 1));
  frontCube.isPickable = false;
  frontCube.alwaysSelectAsActiveMesh = true;

  noaAddMesh(proofA, true);
  noaAddMesh(proofB, true);
  noaAddMesh(frontCube, false);

  MESH.proofA = proofA;
  MESH.proofB = proofB;
  MESH.frontCube = frontCube;

  refreshDebugProofMeshes();
  console.log("[DebugProof] created");
  return true;
}

function refreshDebugProofMeshes() {
  setEnabled(MESH.proofA, showDebugProof);
  setEnabled(MESH.proofB, showDebugProof);
  setEnabled(MESH.frontCube, showDebugProof);
}

function updateFrontCube() {
  if (!showDebugProof) return;
  if (!MESH.frontCube) return;

  const scene = STATE.scene;
  const cam = scene?.activeCamera;
  if (!cam) return;

  let fwd = null;
  try {
    if (typeof cam.getForwardRay === "function") fwd = cam.getForwardRay(1).direction;
    else if (typeof cam.getDirection === "function") fwd = cam.getDirection(new BABYLON.Vector3(0, 0, 1));
  } catch {}

  if (!fwd) {
    MESH.frontCube.position.copyFrom(cam.position);
    MESH.frontCube.position.z += 2;
  } else {
    MESH.frontCube.position.copyFrom(cam.position.add(fwd.scale(3)));
  }
}

/* ============================================================
 * FPS rig: arms + tool socket (camera attached)
 * ============================================================
 */

function initFpsRigOnce() {
  if (!ensureSceneReadyOnce()) return false;
  if (MESH.weaponRoot) return true;

  const scene = STATE.scene;
  const cam = scene.activeCamera;
  if (!cam) return false;

  const weaponRoot = new BABYLON.TransformNode("weaponRoot", scene);
  weaponRoot.parent = cam;
  weaponRoot.position.set(0, 0, 0);

  const armsRoot = new BABYLON.TransformNode("armsRoot", scene);
  armsRoot.parent = weaponRoot;

  const armMat = createSolidMat(scene, "mat_arm", new BABYLON.Color3(0.2, 0.8, 0.2));
  const toolMat = createSolidMat(scene, "mat_tool", new BABYLON.Color3(0.9, 0.9, 0.95));

  const armL = BABYLON.MeshBuilder.CreateBox("fp_armL", { width: 0.45, height: 0.9, depth: 0.45 }, scene);
  armL.material = armMat;
  armL.parent = armsRoot;
  armL.position.set(-0.55, -0.35, 1.05);
  armL.rotation.set(0.1, 0.25, 0);
  armL.isPickable = false;
  armL.alwaysSelectAsActiveMesh = true;

  const armR = BABYLON.MeshBuilder.CreateBox("fp_armR", { width: 0.45, height: 0.9, depth: 0.45 }, scene);
  armR.material = armMat;
  armR.parent = armsRoot;
  armR.position.set(0.55, -0.35, 1.05);
  armR.rotation.set(0.1, -0.25, 0);
  armR.isPickable = false;
  armR.alwaysSelectAsActiveMesh = true;

  const tool = BABYLON.MeshBuilder.CreateBox("fp_tool", { size: 0.35 }, scene);
  tool.material = toolMat;
  tool.parent = weaponRoot;
  tool.position.set(0.28, -0.55, 1.1);
  tool.rotation.set(0.25, 0.1, 0);
  tool.isPickable = false;
  tool.alwaysSelectAsActiveMesh = true;

  // register meshes
  noaAddMesh(armL, false);
  noaAddMesh(armR, false);
  noaAddMesh(tool, false);

  MESH.weaponRoot = weaponRoot;
  MESH.armsRoot = armsRoot;
  MESH.armL = armL;
  MESH.armR = armR;
  MESH.tool = tool;

  console.log("[FPS] rig initialized");
  return true;
}

/* ============================================================
 * 3rd person avatar: simple Minecraft-ish blocky rig
 * ============================================================
 */

function initAvatarOnce() {
  if (!ensureSceneReadyOnce()) return false;
  if (MESH.avatarRoot) return true;

  const scene = STATE.scene;

  const avatarRoot = new BABYLON.TransformNode("avatarRoot", scene);

  const skinMat = createSolidMat(scene, "mat_skin", new BABYLON.Color3(1.0, 0.82, 0.68));
  const shirtMat = createSolidMat(scene, "mat_shirt", new BABYLON.Color3(0.2, 0.4, 0.95));
  const pantsMat = createSolidMat(scene, "mat_pants", new BABYLON.Color3(0.1, 0.1, 0.2));
  const toolMat = createSolidMat(scene, "mat_av_tool", new BABYLON.Color3(0.9, 0.9, 0.95));

  // dimensions approx Minecraft: head 0.5, body 0.5x0.75, arms 0.25x0.75, legs 0.25x0.75
  const head = BABYLON.MeshBuilder.CreateBox("av_head", { width: 0.6, height: 0.6, depth: 0.6 }, scene);
  head.material = skinMat;
  head.parent = avatarRoot;
  head.position.set(0, 1.55, 0);
  head.isPickable = false;
  head.alwaysSelectAsActiveMesh = true;

  const body = BABYLON.MeshBuilder.CreateBox("av_body", { width: 0.7, height: 0.9, depth: 0.35 }, scene);
  body.material = shirtMat;
  body.parent = avatarRoot;
  body.position.set(0, 0.95, 0);
  body.isPickable = false;
  body.alwaysSelectAsActiveMesh = true;

  const armL = BABYLON.MeshBuilder.CreateBox("av_armL", { width: 0.25, height: 0.8, depth: 0.25 }, scene);
  armL.material = shirtMat;
  armL.parent = avatarRoot;
  armL.position.set(-0.55, 1.05, 0);
  armL.isPickable = false;
  armL.alwaysSelectAsActiveMesh = true;

  const armR = BABYLON.MeshBuilder.CreateBox("av_armR", { width: 0.25, height: 0.8, depth: 0.25 }, scene);
  armR.material = shirtMat;
  armR.parent = avatarRoot;
  armR.position.set(0.55, 1.05, 0);
  armR.isPickable = false;
  armR.alwaysSelectAsActiveMesh = true;

  const legL = BABYLON.MeshBuilder.CreateBox("av_legL", { width: 0.28, height: 0.85, depth: 0.28 }, scene);
  legL.material = pantsMat;
  legL.parent = avatarRoot;
  legL.position.set(-0.18, 0.35, 0);
  legL.isPickable = false;
  legL.alwaysSelectAsActiveMesh = true;

  const legR = BABYLON.MeshBuilder.CreateBox("av_legR", { width: 0.28, height: 0.85, depth: 0.28 }, scene);
  legR.material = pantsMat;
  legR.parent = avatarRoot;
  legR.position.set(0.18, 0.35, 0);
  legR.isPickable = false;
  legR.alwaysSelectAsActiveMesh = true;

  const avTool = BABYLON.MeshBuilder.CreateBox("av_tool", { size: 0.28 }, scene);
  avTool.material = toolMat;
  avTool.parent = avatarRoot;
  avTool.position.set(0.72, 0.85, 0.18);
  avTool.rotation.set(0.2, 0.2, 0.2);
  avTool.isPickable = false;
  avTool.alwaysSelectAsActiveMesh = true;

  // register meshes
  noaAddMesh(head, false);
  noaAddMesh(body, false);
  noaAddMesh(armL, false);
  noaAddMesh(armR, false);
  noaAddMesh(legL, false);
  noaAddMesh(legR, false);
  noaAddMesh(avTool, false);

  MESH.avatarRoot = avatarRoot;
  MESH.avHead = head;
  MESH.avBody = body;
  MESH.avArmL = armL;
  MESH.avArmR = armR;
  MESH.avLegL = legL;
  MESH.avLegR = legR;
  MESH.avTool = avTool;

  console.log("[Avatar] initialized");
  return true;
}

/* ============================================================
 * View mode behavior (Minecraft-ish)
 * ============================================================
 */

function applyViewMode() {
  initFpsRigOnce();
  initAvatarOnce();
  initDebugProofMeshesOnce();

  const isFirst = viewMode === 0;

  // camera zoom
  try {
    const z = isFirst ? 0 : 6;
    noa.camera.zoomDistance = z;
    noa.camera.currentZoom = z;
    noa.camera.zoomSpeed = 0.35;
  } catch {}

  // shoulder offset using cameraTarget follow offset
  try {
    const st = STATE.camFollowState || noa.ents.getState(noa.camera.cameraTarget, "followsEntity");
    if (st && st.offset && st.offset.length >= 3) {
      if (isFirst) {
        st.offset[0] = STATE.baseFollowOffset[0];
        st.offset[1] = STATE.baseFollowOffset[1];
        st.offset[2] = STATE.baseFollowOffset[2];
      } else {
        st.offset[0] = STATE.baseFollowOffset[0] + 0.35; // shoulder right
        st.offset[1] = STATE.baseFollowOffset[1];
        st.offset[2] = STATE.baseFollowOffset[2];
      }
      STATE.camFollowState = st;
    }
  } catch {}

  // show/hide layers
  setEnabled(MESH.armL, isFirst);
  setEnabled(MESH.armR, isFirst);
  setEnabled(MESH.tool, isFirst);

  // avatar root is TransformNode; children are meshes, but toggling root is easiest
  setEnabled(MESH.avatarRoot, !isFirst);

  refreshDebugProofMeshes();
  crosshairUI.refresh();

  console.log("[applyViewMode] mode:", isFirst ? "first" : "third");
}

/* ============================================================
 * Animation state + swing triggers
 * ============================================================
 */

function triggerSwing() {
  STATE.swingT = 0;
}

function getPlayerSpeedAndGrounded(dt) {
  // prefer physics body if accessible
  let speed = 0;
  let grounded = false;
  let vy = 0;

  try {
    const body = noa.entities.getPhysicsBody(noa.playerEntity);
    if (body) {
      const v = body.velocity || body._velocity || null;
      if (v && v.length >= 3) {
        speed = Math.sqrt(v[0] * v[0] + v[2] * v[2]);
        vy = v[1];
      }
      // grounded heuristics:
      // - some versions expose atRestY()
      // - otherwise body.resting can indicate contact on Y axis
      if (typeof body.atRestY === "function") grounded = body.atRestY() !== 0;
      else if (body.resting && body.resting.length >= 3) grounded = body.resting[1] !== 0;
    }
  } catch {}

  // fallback speed from position delta
  if (!speed) {
    try {
      const p = noa.entities.getPosition(noa.playerEntity);
      if (p) {
        if (STATE.lastPlayerPos) {
          const dx = p[0] - STATE.lastPlayerPos[0];
          const dz = p[2] - STATE.lastPlayerPos[2];
          const dist = Math.sqrt(dx * dx + dz * dz);
          speed = dist / Math.max(dt, 0.0001);
        }
        STATE.lastPlayerPos = [p[0], p[1], p[2]];
      }
    } catch {}
  }

  // if we couldn't detect grounded, approximate: if vy small and speed exists, assume grounded
  if (grounded === false && Math.abs(vy) < 0.02) {
    // do nothing; leave false unless body told us otherwise
  }

  return { speed, grounded, vy };
}

function computeAnimState(speed, grounded, vy) {
  const swingActive = STATE.swingT < STATE.swingDuration;

  if (swingActive) return "swing";

  if (!grounded) {
    if (vy > 0.15) return "jump";
    return "fall";
  }

  if (speed > 4.5) return "run";
  if (speed > 0.25) return "walk";
  return "idle";
}

/* ============================================================
 * FPS arms animation (sway + bob + swing)
 * ============================================================
 */

function updateFpsRig(dt, speed) {
  if (viewMode !== 0) return;
  if (!MESH.weaponRoot) return;

  // update sway from camera delta
  const heading = safeNum(noa.camera.heading, 0);
  const pitch = safeNum(noa.camera.pitch, 0);

  let dHeading = heading - STATE.lastHeading;
  let dPitch = pitch - STATE.lastPitch;

  // wrap yaw delta
  if (dHeading > Math.PI) dHeading -= Math.PI * 2;
  if (dHeading < -Math.PI) dHeading += Math.PI * 2;

  STATE.lastHeading = heading;
  STATE.lastPitch = pitch;

  // bob phase
  const bobRate = clamp(speed * 7, 0, 12);
  STATE.bobPhase += bobRate * dt;

  const bobY = Math.sin(STATE.bobPhase) * 0.03;
  const bobX = Math.sin(STATE.bobPhase * 0.5) * 0.015;

  // sway
  const swayX = clamp(-dHeading * 1.6, -0.08, 0.08);
  const swayY = clamp(dPitch * 1.2, -0.06, 0.06);

  // swing
  let swingAmt = 0;
  if (STATE.swingT < STATE.swingDuration) {
    const t = clamp(STATE.swingT / STATE.swingDuration, 0, 1);
    // ease-out sine
    swingAmt = Math.sin(t * Math.PI) * 1.0;
  }

  // weaponRoot target transforms
  const wr = MESH.weaponRoot;

  const targetPos = new BABYLON.Vector3(
    bobX + swayX * 0.8,
    -0.02 + bobY - swingAmt * 0.04,
    0.0
  );

  const targetRot = new BABYLON.Vector3(
    swayY + swingAmt * 0.9,
    swayX * 0.8 + swingAmt * 0.15,
    swayX * 0.6 + swingAmt * 0.25
  );

  const s = clamp(dt * 12, 0, 1);
  wr.position.x = lerp(wr.position.x, targetPos.x, s);
  wr.position.y = lerp(wr.position.y, targetPos.y, s);
  wr.position.z = lerp(wr.position.z, targetPos.z, s);

  wr.rotation.x = lerp(wr.rotation.x, targetRot.x, s);
  wr.rotation.y = lerp(wr.rotation.y, targetRot.y, s);
  wr.rotation.z = lerp(wr.rotation.z, targetRot.z, s);

  // make the tool swing more obviously
  if (MESH.tool) {
    MESH.tool.rotation.x = 0.25 + swingAmt * 1.2;
    MESH.tool.rotation.y = 0.1 + swingAmt * 0.15;
    MESH.tool.rotation.z = 0 + swingAmt * 0.35;
  }
}

/* ============================================================
 * Avatar animation (walk + swing) in third person
 * ============================================================
 */

function updateAvatarRig(dt, speed, grounded) {
  if (viewMode !== 1) return;
  if (!MESH.avatarRoot) return;

  // position avatar at player
  try {
    const p = noa.entities.getPosition(noa.playerEntity);
    if (p && p.length >= 3) {
      MESH.avatarRoot.position.set(p[0], p[1] + 0.9, p[2]);
    }
  } catch {}

  // rotate avatar with heading
  try {
    const yaw = safeNum(noa.camera.heading, 0);
    MESH.avatarRoot.rotation.y = yaw;
  } catch {}

  // walk cycle (legs/arms swing)
  const walkAmp = grounded ? clamp(speed / 4.5, 0, 1) : 0;
  const walkPhase = STATE.bobPhase * 0.6;

  const legSwing = Math.sin(walkPhase) * 0.7 * walkAmp;
  const armSwing = Math.sin(walkPhase + Math.PI) * 0.55 * walkAmp;

  if (MESH.avLegL) MESH.avLegL.rotation.x = legSwing;
  if (MESH.avLegR) MESH.avLegR.rotation.x = -legSwing;

  if (MESH.avArmL) MESH.avArmL.rotation.x = armSwing;
  // right arm will be overridden by swing when mining

  // swing animation on right arm + tool
  let swingAmt = 0;
  if (STATE.swingT < STATE.swingDuration) {
    const t = clamp(STATE.swingT / STATE.swingDuration, 0, 1);
    swingAmt = Math.sin(t * Math.PI) * 1.0;
  }

  if (MESH.avArmR) {
    MESH.avArmR.rotation.x = -armSwing + swingAmt * 1.4;
    MESH.avArmR.rotation.z = swingAmt * 0.25;
  }
  if (MESH.avTool) {
    MESH.avTool.rotation.x = 0.2 + swingAmt * 1.2;
    MESH.avTool.rotation.z = 0.2 + swingAmt * 0.35;
  }
}

/* ============================================================
 * Boot loop
 * ============================================================
 */

(function bootCore() {
  let tries = 0;
  const t = setInterval(() => {
    tries++;

    if (ensureSceneReadyOnce()) {
      initFpsRigOnce();
      initAvatarOnce();
      initDebugProofMeshesOnce();
      applyViewMode();
      clearInterval(t);
      console.log("[Boot] core initialized");
    } else if (tries > 200) {
      clearInterval(t);
      console.warn("[Boot] failed to resolve scene after retries.");
    }
  }, 100);
})();

/* ============================================================
 * Main render update
 * ============================================================
 */

noa.on("beforeRender", function () {
  const now = performance.now();
  const dt = clamp((now - STATE.lastTime) / 1000, 0, 0.05);
  STATE.lastTime = now;

  // keep camera clipping friendly
  try {
    const cam = STATE.scene?.activeCamera;
    if (cam) {
      cam.minZ = 0.05;
      if (cam.maxZ < 5000) cam.maxZ = 10000;
    }
  } catch {}

  // advance swing timer
  STATE.swingT += dt;

  // compute motion + grounded
  const { speed, grounded, vy } = getPlayerSpeedAndGrounded(dt);

  // update state machine
  const nextState = computeAnimState(speed, grounded, vy);
  STATE.animState = nextState;

  // update debug + rigs
  updateFrontCube();
  updateFpsRig(dt, speed);
  updateAvatarRig(dt, speed, grounded);
});

/* ============================================================
 * tick: third-person zoom with scroll
 * ============================================================
 */

noa.on("tick", function () {
  const scroll = noa.inputs.pointerState.scrolly;
  if (scroll !== 0 && viewMode === 1) {
    const delta = scroll > 0 ? 1 : -1;
    noa.camera.zoomDistance = clamp(noa.camera.zoomDistance + delta, 2, 12);
    noa.camera.currentZoom = noa.camera.zoomDistance;
  }
});

/* ============================================================
 * Interactivity: break/place + swing trigger
 * ============================================================
 */

noa.inputs.down.on("fire", function () {
  triggerSwing();
  if (noa.targetedBlock) {
    const pos = noa.targetedBlock.position;
    noa.setBlock(0, pos[0], pos[1], pos[2]);
  }
});

noa.inputs.down.on("alt-fire", function () {
  triggerSwing();
  if (noa.targetedBlock) {
    const pos = noa.targetedBlock.adjacent;
    noa.setBlock(grassID, pos[0], pos[1], pos[2]);
  }
});

noa.inputs.bind("alt-fire", "KeyE");

/* ============================================================
 * Colyseus (kept minimal)
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
