// @ts-nocheck
/*
 * Fresh2 - hello-world (NOA main entry) - FULL REWRITE (NO OMITS)
 * -------------------------------------------------------------
 * Fixes:
 * - Prevents "1st person on ground, 3rd in the air" by enforcing view mode EVERY FRAME
 * - 3rd-person camera: optional hard-follow behind avatar (ONLY when viewMode === 1)
 * - Prevent camera roll/slant in 3rd person (forces upright camera)
 * - Multiplayer: Colyseus SDK (state-diff sync; no MapSchema hooks required)
 * - Debug: Avatar/camera snapshots in 3rd person
 */

import { Engine } from "noa-engine";
import { Client } from "@colyseus/sdk";
import * as BABYLON from "babylonjs";

/* ============================================================
 * NOA BOOTSTRAP
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
  initialZoom: 0,
  zoomSpeed: 0.25,
};

const noa = new Engine(opts);
const noaAny = /** @type {any} */ (noa);

console.log("noa-engine booted:", noa.version);

/* ============================================================
 * GLOBAL STATE
 * ============================================================
 */

let viewMode = 0; // 0 = first, 1 = third
let forceCrosshair = true;
let showDebugProof = false;

// Multiplayer
let colyRoom = null;
const remotePlayers = {}; // { [sessionId]: { mesh, parts, targetPos, targetRot, lastPos } }
let lastPlayersKeys = new Set();

const STATE = {
  scene: null,

  // NOA follow state (if available)
  camFollowState: null,
  baseFollowOffset: [0, 0, 0],

  // time
  lastTime: performance.now(),

  // animation
  lastHeading: 0,
  lastPitch: 0,
  bobPhase: 0,
  lastPlayerPos: null,

  swingT: 999,
  swingDuration: 0.22,

  // safe pos cache
  lastValidPlayerPos: [0, 2, 0],

  // debug throttle
  avDbgLastLog: 0,
  avDbgIntervalMs: 200,
};

const MESH = {
  // Debug
  proofA: null,
  frontCube: null,

  // FPS Rig
  weaponRoot: null,
  armsRoot: null,
  armL: null,
  armR: null,
  tool: null,

  // Third-person avatar (local)
  avatarRoot: null,
  avParts: {}, // { root, head, body, armL, armR, legL, legR, tool }
};

/* ============================================================
 * HELPERS
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

function resolveScene() {
  const r = noaAny.rendering;
  if (r?.getScene) return r.getScene();
  if (r?.scene) return r.scene;
  return null;
}

function noaAddMesh(mesh, isStatic = false, pos = null) {
  try {
    noa.rendering.addMeshToScene(mesh, !!isStatic, pos || null);
    // reduce aggressive culling issues
    mesh.alwaysSelectAsActiveMesh = true;
  } catch (e) {
    console.warn("[NOA_RENDER] addMeshToScene failed:", e);
  }
}

function createSolidMat(scene, name, color3) {
  const existing = scene.getMaterialByName(name);
  if (existing) return existing;

  const mat = new BABYLON.StandardMaterial(name, scene);
  mat.diffuseColor = color3;
  mat.emissiveColor = color3.scale(0.35);
  mat.specularColor = new BABYLON.Color3(0, 0, 0);
  mat.backFaceCulling = false;
  return mat;
}

function setEnabled(meshOrNode, on) {
  if (!meshOrNode) return;
  if (meshOrNode.setEnabled) meshOrNode.setEnabled(!!on);
}

function isFinite3(p) {
  return (
    p &&
    p.length >= 3 &&
    Number.isFinite(p[0]) &&
    Number.isFinite(p[1]) &&
    Number.isFinite(p[2])
  );
}

function getSafePlayerPos() {
  let p = null;
  try {
    p = noa.entities.getPosition(noa.playerEntity);
  } catch (e) {}

  if (isFinite3(p)) {
    const x = p[0];
    const y = clamp(p[1], -100000, 100000);
    const z = p[2];
    STATE.lastValidPlayerPos = [x, y, z];
    return STATE.lastValidPlayerPos;
  }

  return STATE.lastValidPlayerPos;
}

function forceRigBounds(parts) {
  if (!parts) return;

  if (parts.root?.computeWorldMatrix) {
    parts.root.computeWorldMatrix(true);
  }

  const meshes = [
    parts.head,
    parts.body,
    parts.armL,
    parts.armR,
    parts.legL,
    parts.legR,
    parts.tool,
  ].filter(Boolean);

  for (const m of meshes) {
    try {
      m.computeWorldMatrix(true);
      m.refreshBoundingInfo(true);
      if (m._updateSubMeshesBoundingInfo) m._updateSubMeshesBoundingInfo();
    } catch (e) {}
  }
}

/* ============================================================
 * UI: CROSSHAIR OVERLAY (DECLARE ONCE!)
 * ============================================================
 */

function createCrosshairOverlay() {
  const div = document.createElement("div");
  div.id = "noa-crosshair";
  Object.assign(div.style, {
    position: "fixed",
    top: "50%",
    left: "50%",
    width: "22px",
    height: "22px",
    transform: "translate(-50%, -50%)",
    pointerEvents: "none",
    zIndex: "9999",
    display: "none",
  });

  const lineStyle = {
    position: "absolute",
    backgroundColor: "rgba(255,255,255,0.9)",
    boxShadow: "0 0 2px black",
  };

  const h = document.createElement("div");
  Object.assign(h.style, lineStyle, { width: "100%", height: "2px", top: "10px", left: "0" });

  const v = document.createElement("div");
  Object.assign(v.style, lineStyle, { width: "2px", height: "100%", left: "10px", top: "0" });

  div.appendChild(h);
  div.appendChild(v);
  document.body.appendChild(div);

  function refresh() {
    const locked = document.pointerLockElement === noa.container.canvas;
    const show = forceCrosshair || viewMode === 0 || locked;
    div.style.display = show ? "block" : "none";
  }

  document.addEventListener("pointerlockchange", refresh);
  setInterval(refresh, 500);

  return { refresh };
}

const crosshairUI = createCrosshairOverlay();

/* ============================================================
 * WORLD GENERATION
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
 * SCENE INIT
 * ============================================================
 */

function ensureSceneReady() {
  if (STATE.scene) return true;

  const scene = resolveScene();
  if (!scene) return false;

  STATE.scene = scene;

  // camera clip planes
  if (scene.activeCamera) {
    scene.activeCamera.minZ = 0.01;
    scene.activeCamera.maxZ = 5000;
  }

  // attempt to cache NOA follow offset state if present
  try {
    const st = noa.ents.getState(noa.camera.cameraTarget, "followsEntity");
    if (st?.offset) {
      STATE.camFollowState = st;
      STATE.baseFollowOffset = [...st.offset];
    }
  } catch (e) {}

  return true;
}

/* ============================================================
 * RIGS
 * ============================================================
 */

function createAvatarRig(scene, namePrefix) {
  const root = new BABYLON.TransformNode(namePrefix + "_root", scene);

  const skinMat = createSolidMat(scene, "mat_skin", new BABYLON.Color3(1.0, 0.82, 0.68));
  const shirtMat = createSolidMat(scene, "mat_shirt", new BABYLON.Color3(0.2, 0.4, 0.95));
  const pantsMat = createSolidMat(scene, "mat_pants", new BABYLON.Color3(0.1, 0.1, 0.2));
  const toolMat = createSolidMat(scene, "mat_av_tool", new BABYLON.Color3(0.9, 0.9, 0.95));

  const head = BABYLON.MeshBuilder.CreateBox(namePrefix + "_head", { size: 0.6 }, scene);
  head.material = skinMat;
  head.parent = root;
  head.position.set(0, 1.55, 0);

  const body = BABYLON.MeshBuilder.CreateBox(
    namePrefix + "_body",
    { width: 0.7, height: 0.9, depth: 0.35 },
    scene
  );
  body.material = shirtMat;
  body.parent = root;
  body.position.set(0, 0.95, 0);

  const armL = BABYLON.MeshBuilder.CreateBox(
    namePrefix + "_armL",
    { width: 0.25, height: 0.8, depth: 0.25 },
    scene
  );
  armL.material = shirtMat;
  armL.parent = root;
  armL.position.set(-0.55, 1.05, 0);

  const armR = BABYLON.MeshBuilder.CreateBox(
    namePrefix + "_armR",
    { width: 0.25, height: 0.8, depth: 0.25 },
    scene
  );
  armR.material = shirtMat;
  armR.parent = root;
  armR.position.set(0.55, 1.05, 0);

  const legL = BABYLON.MeshBuilder.CreateBox(
    namePrefix + "_legL",
    { width: 0.28, height: 0.85, depth: 0.28 },
    scene
  );
  legL.material = pantsMat;
  legL.parent = root;
  legL.position.set(-0.18, 0.35, 0);

  const legR = BABYLON.MeshBuilder.CreateBox(
    namePrefix + "_legR",
    { width: 0.28, height: 0.85, depth: 0.28 },
    scene
  );
  legR.material = pantsMat;
  legR.parent = root;
  legR.position.set(0.18, 0.35, 0);

  const tool = BABYLON.MeshBuilder.CreateBox(namePrefix + "_tool", { size: 0.28 }, scene);
  tool.material = toolMat;
  tool.parent = root;
  tool.position.set(0.72, 0.85, 0.18);
  tool.rotation.set(0.2, 0.2, 0.2);

  [head, body, armL, armR, legL, legR, tool].forEach((m) => {
    m.isPickable = false;
    noaAddMesh(m, false);
    m.alwaysSelectAsActiveMesh = true;
    m.isVisible = true;
    m.visibility = 1;
    m.cullingStrategy = BABYLON.AbstractMesh.CULLINGSTRATEGY_BOUNDINGSPHERE_ONLY;
  });

  return { root, head, body, armL, armR, legL, legR, tool };
}

function initFpsRig() {
  if (MESH.weaponRoot) return;
  const scene = STATE.scene;
  const cam = scene.activeCamera;

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

  const armR = BABYLON.MeshBuilder.CreateBox("fp_armR", { width: 0.45, height: 0.9, depth: 0.45 }, scene);
  armR.material = armMat;
  armR.parent = armsRoot;
  armR.position.set(0.55, -0.35, 1.05);
  armR.rotation.set(0.1, -0.25, 0);

  const tool = BABYLON.MeshBuilder.CreateBox("fp_tool", { size: 0.35 }, scene);
  tool.material = toolMat;
  tool.parent = weaponRoot;
  tool.position.set(0.28, -0.55, 1.1);
  tool.rotation.set(0.25, 0.1, 0);

  [armL, armR, tool].forEach((m) => {
    m.isPickable = false;
    noaAddMesh(m, false);
  });

  MESH.weaponRoot = weaponRoot;
  MESH.armsRoot = armsRoot;
  MESH.armL = armL;
  MESH.armR = armR;
  MESH.tool = tool;
}

function initLocalAvatar() {
  if (MESH.avatarRoot) return;
  const rig = createAvatarRig(STATE.scene, "local_av");
  MESH.avatarRoot = rig.root;
  MESH.avParts = rig;
}

function initDebugMeshes() {
  if (MESH.proofA) return;
  const scene = STATE.scene;

  const proofA = BABYLON.MeshBuilder.CreateBox("proofA", { size: 3 }, scene);
  proofA.material = createSolidMat(scene, "mat_proofA", new BABYLON.Color3(0, 1, 0));
  proofA.position.set(0, 14, 0);
  noaAddMesh(proofA, true);

  const frontCube = BABYLON.MeshBuilder.CreateBox("frontCube", { size: 1.5 }, scene);
  frontCube.material = createSolidMat(scene, "mat_frontCube", new BABYLON.Color3(0, 0.6, 1));
  noaAddMesh(frontCube, false);

  MESH.proofA = proofA;
  MESH.frontCube = frontCube;

  refreshDebugProofMeshes();
}

function refreshDebugProofMeshes() {
  setEnabled(MESH.proofA, showDebugProof);
  setEnabled(MESH.frontCube, showDebugProof);
}

/* ============================================================
 * VIEW MODE ENFORCEMENT (CRITICAL FIX)
 * ============================================================
 */

function enforceViewModeEveryFrame() {
  const isFirst = viewMode === 0;

  // enforce camera zoom
  if (isFirst) {
    noa.camera.zoomDistance = 0;
    noa.camera.currentZoom = 0;
  } else {
    const z = clamp(noa.camera.zoomDistance || 6, 2, 12);
    noa.camera.zoomDistance = z;
    noa.camera.currentZoom = z;
  }

  // enforce NOA follow offset, if available
  try {
    const st = STATE.camFollowState;
    if (st?.offset) {
      if (isFirst) {
        st.offset[0] = STATE.baseFollowOffset[0];
        st.offset[1] = STATE.baseFollowOffset[1];
        st.offset[2] = STATE.baseFollowOffset[2];
      } else {
        st.offset[0] = STATE.baseFollowOffset[0] + 0.5;
        st.offset[1] = STATE.baseFollowOffset[1];
        st.offset[2] = STATE.baseFollowOffset[2];
      }
    }
  } catch (e) {}

  // enforce mesh visibility
  setEnabled(MESH.armsRoot, isFirst);
  setEnabled(MESH.tool, isFirst);
  setEnabled(MESH.avatarRoot, !isFirst);

  crosshairUI.refresh();
}

function applyViewModeOnce() {
  initFpsRig();
  initLocalAvatar();
  initDebugMeshes();
  enforceViewModeEveryFrame();
}

/* ============================================================
 * 3RD PERSON CAMERA HARD FOLLOW (ONLY WHEN viewMode===1)
 * ============================================================
 */

function hardFollowThirdPersonCamera() {
  if (viewMode !== 1) return;
  if (!STATE.scene || !STATE.scene.activeCamera) return;
  if (!MESH.avatarRoot) return;

  const cam = STATE.scene.activeCamera;

  // keep camera upright (prevents slant/roll)
  cam.upVector = new BABYLON.Vector3(0, 1, 0);
  if (cam.rotation) cam.rotation.z = 0;

  const target = MESH.avatarRoot.position.clone();
  const heading = safeNum(noa.camera.heading, 0);
  const dist = clamp(noa.camera.zoomDistance || 6, 2, 12);

  const backDir = new BABYLON.Vector3(Math.sin(heading), 0, Math.cos(heading));
  const back = backDir.scale(-dist);
  const up = new BABYLON.Vector3(0, 1.7, 0);

  const desired = target.add(back).add(up);

  cam.position = BABYLON.Vector3.Lerp(cam.position, desired, 0.25);
  cam.setTarget(target.add(new BABYLON.Vector3(0, 1.2, 0)));

  if (cam.rotation) cam.rotation.z = 0;
}

/* ============================================================
 * ANIMATION
 * ============================================================
 */

function updateFpsRig(dt, speed) {
  if (viewMode !== 0 || !MESH.weaponRoot) return;

  const heading = safeNum(noa.camera.heading, 0);
  const pitch = safeNum(noa.camera.pitch, 0);

  let dHeading = heading - STATE.lastHeading;
  let dPitch = pitch - STATE.lastPitch;

  if (dHeading > Math.PI) dHeading -= Math.PI * 2;
  if (dHeading < -Math.PI) dHeading += Math.PI * 2;

  STATE.lastHeading = heading;
  STATE.lastPitch = pitch;

  // bob
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
    swingAmt = Math.sin(t * Math.PI) * 1.0;
  }

  const wr = MESH.weaponRoot;
  const s = clamp(dt * 12, 0, 1);

  const targetPos = new BABYLON.Vector3(
    bobX + swayX * 0.8,
    -0.02 + bobY - swingAmt * 0.04,
    0
  );

  const targetRot = new BABYLON.Vector3(
    swayY + swingAmt * 0.9,
    swayX * 0.8 + swingAmt * 0.15,
    swayX * 0.6 + swingAmt * 0.25
  );

  wr.position.copyFrom(BABYLON.Vector3.Lerp(wr.position, targetPos, s));
  wr.rotation.copyFrom(BABYLON.Vector3.Lerp(wr.rotation, targetRot, s));

  if (MESH.tool) {
    MESH.tool.rotation.x = 0.25 + swingAmt * 1.2;
    MESH.tool.rotation.y = 0.1 + swingAmt * 0.15;
    MESH.tool.rotation.z = 0 + swingAmt * 0.35;
  }
}

function updateAvatarAnim(parts, speed, grounded, isSwing) {
  if (!parts || !parts.root || !parts.root.isEnabled()) return;

  const walkAmp = grounded ? clamp(speed / 4.5, 0, 1) : 0;
  const walkPhase = STATE.bobPhase * 0.6;

  const legSwing = Math.sin(walkPhase) * 0.7 * walkAmp;
  const armSwing = Math.sin(walkPhase + Math.PI) * 0.55 * walkAmp;

  if (parts.legL) parts.legL.rotation.x = legSwing;
  if (parts.legR) parts.legR.rotation.x = -legSwing;
  if (parts.armL) parts.armL.rotation.x = armSwing;

  let swingAmt = 0;
  if (isSwing) {
    const t = clamp(STATE.swingT / STATE.swingDuration, 0, 1);
    swingAmt = Math.sin(t * Math.PI) * 1.0;
  }

  if (parts.armR) {
    parts.armR.rotation.x = -armSwing + swingAmt * 1.4;
    parts.armR.rotation.z = swingAmt * 0.25;
  }

  if (parts.tool) {
    parts.tool.rotation.x = 0.2 + swingAmt * 1.2;
    parts.tool.rotation.z = 0.2 + swingAmt * 0.35;
  }
}

/* ============================================================
 * PHYSICS SNAPSHOT
 * ============================================================
 */

function getLocalPhysics(dt) {
  let speed = 0;
  let grounded = false;

  try {
    const body = noa.entities.getPhysicsBody(noa.playerEntity);
    if (body) {
      const v = body.velocity;
      speed = Math.sqrt(v[0] * v[0] + v[2] * v[2]);
      if (body.resting[1] < 0) grounded = true;
    }
  } catch (e) {}

  const p = getSafePlayerPos();
  if (!speed && STATE.lastPlayerPos && p) {
    const dx = p[0] - STATE.lastPlayerPos[0];
    const dz = p[2] - STATE.lastPlayerPos[2];
    speed = Math.sqrt(dx * dx + dz * dz) / dt;
  }

  if (p) STATE.lastPlayerPos = [...p];

  return { speed, grounded };
}

/* ============================================================
 * 3RD PERSON DEBUG SNAPSHOTS
 * ============================================================
 */

function isVecFinite(v) {
  return v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

function meshEnabled(m) {
  try {
    return typeof m.isEnabled === "function" ? m.isEnabled() : !!m._isEnabled;
  } catch (e) {
    return true;
  }
}

function getMeshesFromRig(parts) {
  if (!parts) return [];
  return [
    parts.head,
    parts.body,
    parts.armL,
    parts.armR,
    parts.legL,
    parts.legR,
    parts.tool,
  ].filter(Boolean);
}

function debugThirdPersonAvatar(nowMs) {
  if (viewMode !== 1) return;
  if (!STATE.scene) return;
  if (!MESH.avatarRoot || !MESH.avParts?.root) return;

  const cam = STATE.scene.activeCamera;
  const root = MESH.avParts.root;
  const meshes = getMeshesFromRig(MESH.avParts);

  const rootPos = root.position;
  const rootRot = root.rotation;

  const camPos = cam?.position;
  const distToCam = camPos ? BABYLON.Vector3.Distance(camPos, root.position) : null;

  const due = nowMs - STATE.avDbgLastLog >= STATE.avDbgIntervalMs;
  if (!due) return;
  STATE.avDbgLastLog = nowMs;

  let anyDisabled = !meshEnabled(root);
  let anyInvisible = root.isVisible === false;
  let anyNaN = !isVecFinite(rootPos) || !isVecFinite(rootRot);

  for (const m of meshes) {
    if (!meshEnabled(m)) anyDisabled = true;
    if (m.isVisible === false || (typeof m.visibility === "number" && m.visibility <= 0)) anyInvisible = true;
    if (!isVecFinite(m.position) || !isVecFinite(m.rotation) || !isVecFinite(m.scaling)) anyNaN = true;
  }

  console.log("AVATAR SNAP:", {
    viewMode,
    rootPos: { x: rootPos.x, y: rootPos.y, z: rootPos.z },
    rootRot: { x: rootRot.x, y: rootRot.y, z: rootRot.z },
    y: safeNum(rootPos.y, null),
    rootEnabled: meshEnabled(root),
    rootVisible: root.isVisible !== false,
    camPos: camPos ? { x: camPos.x, y: camPos.y, z: camPos.z } : null,
    distToCam,
    camRollZ: cam?.rotation ? cam.rotation.z : null,
    anyDisabled,
    anyInvisible,
    anyNaN,
  });
}

/* ============================================================
 * MULTIPLAYER STATE DIFF SYNC (NO MapSchema hooks)
 * ============================================================
 */

function getPlayersSnapshot(players) {
  const out = {};
  if (!players) return out;

  // MapSchema in some builds provides forEach
  if (typeof players.forEach === "function") {
    try {
      players.forEach((player, sessionId) => {
        out[sessionId] = player;
      });
      return out;
    } catch (e) {}
  }

  // fallback
  try {
    for (const k of Object.keys(players)) out[k] = players[k];
  } catch (e) {}

  return out;
}

function spawnRemotePlayer(sessionId, player) {
  if (!sessionId || !player) return;
  if (colyRoom && sessionId === colyRoom.sessionId) return;
  if (remotePlayers[sessionId]) return;
  if (!ensureSceneReady()) return;

  console.log("Remote player joined:", sessionId);

  const rig = createAvatarRig(STATE.scene, "remote_" + sessionId);

  const px = safeNum(player.x, 0);
  const py = safeNum(player.y, 0);
  const pz = safeNum(player.z, 0);
  const yaw = safeNum(player.yaw, 0);

  remotePlayers[sessionId] = {
    mesh: rig.root,
    parts: rig,
    targetPos: { x: px, y: py, z: pz },
    targetRot: yaw,
    lastPos: { x: px, y: py, z: pz },
  };

  rig.root.position.set(px, py + 0.075, pz);
  rig.root.rotation.y = yaw;

  forceRigBounds(rig);
}

function removeRemotePlayer(sessionId) {
  const rp = remotePlayers[sessionId];
  if (!rp) return;

  console.log("Remote player left:", sessionId);

  try {
    if (rp.mesh) rp.mesh.dispose();
  } catch (e) {}

  delete remotePlayers[sessionId];
}

function updateRemoteTargetsFromState(playersObj) {
  for (const sessionId of Object.keys(playersObj)) {
    if (colyRoom && sessionId === colyRoom.sessionId) continue;

    const player = playersObj[sessionId];
    if (!player) continue;

    if (!remotePlayers[sessionId]) {
      spawnRemotePlayer(sessionId, player);
      continue;
    }

    const rp = remotePlayers[sessionId];
    rp.targetPos.x = safeNum(player.x, rp.targetPos.x);
    rp.targetPos.y = safeNum(player.y, rp.targetPos.y);
    rp.targetPos.z = safeNum(player.z, rp.targetPos.z);
    rp.targetRot = safeNum(player.yaw, rp.targetRot);
  }
}

function syncPlayersFromState(state) {
  if (!state) return;

  const playersObj = getPlayersSnapshot(state.players);
  const newKeys = new Set(Object.keys(playersObj));

  for (const k of newKeys) {
    if (!lastPlayersKeys.has(k)) spawnRemotePlayer(k, playersObj[k]);
  }

  for (const k of lastPlayersKeys) {
    if (!newKeys.has(k)) removeRemotePlayer(k);
  }

  updateRemoteTargetsFromState(playersObj);
  lastPlayersKeys = newKeys;
}

/* ============================================================
 * INPUTS
 * ============================================================
 */

document.addEventListener("keydown", (e) => {
  if (e.code === "KeyV") {
    viewMode = (viewMode + 1) % 2;
    applyViewModeOnce();
  }
  if (e.code === "KeyC") {
    forceCrosshair = !forceCrosshair;
    crosshairUI.refresh();
  }
  if (e.code === "KeyP") {
    showDebugProof = !showDebugProof;
    refreshDebugProofMeshes();
  }
});

noa.on("tick", function () {
  const scroll = noa.inputs.pointerState.scrolly;
  if (scroll !== 0 && viewMode === 1) {
    noa.camera.zoomDistance = clamp(noa.camera.zoomDistance + (scroll > 0 ? 1 : -1), 2, 12);
    noa.camera.currentZoom = noa.camera.zoomDistance;
  }
});

function triggerSwing() {
  STATE.swingT = 0;
}

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
 * MAIN RENDER LOOP
 * ============================================================
 */

noa.on("beforeRender", function () {
  if (!ensureSceneReady()) return;

  // ensure rigs exist
  initFpsRig();
  initLocalAvatar();
  initDebugMeshes();

  // enforce view mode EVERY frame (prevents mid-air flip)
  enforceViewModeEveryFrame();

  const now = performance.now();
  const dt = clamp((now - STATE.lastTime) / 1000, 0, 0.05);
  STATE.lastTime = now;
  STATE.swingT += dt;

  const { speed, grounded } = getLocalPhysics(dt);

  // FPS rig animation
  updateFpsRig(dt, speed);

  // Local avatar update (always follows physics position)
  if (MESH.avatarRoot) {
    const p = getSafePlayerPos();

    MESH.avatarRoot.position.set(p[0], p[1] + 0.075, p[2]);
    MESH.avatarRoot.rotation.y = safeNum(noa.camera.heading, 0);

    MESH.avatarRoot.computeWorldMatrix(true);
    forceRigBounds(MESH.avParts);

    updateAvatarAnim(MESH.avParts, speed, grounded, STATE.swingT < STATE.swingDuration);
  }

  // 3rd-person hard camera follow (ONLY in 3rd person)
  hardFollowThirdPersonCamera();

  // debug snapshots (only 3rd person)
  debugThirdPersonAvatar(now);

  // Remote interpolation
  for (const sid in remotePlayers) {
    const rp = remotePlayers[sid];
    if (!rp || !rp.mesh) continue;

    const t = 0.2;

    rp.mesh.position.x = lerp(rp.mesh.position.x, rp.targetPos.x, t);
    rp.mesh.position.y = lerp(rp.mesh.position.y, rp.targetPos.y + 0.075, t);
    rp.mesh.position.z = lerp(rp.mesh.position.z, rp.targetPos.z, t);

    rp.mesh.rotation.y = lerp(rp.mesh.rotation.y, rp.targetRot, t);

    forceRigBounds(rp.parts);

    // basic speed estimate for animation
    const dx = rp.mesh.position.x - rp.lastPos.x;
    const dz = rp.mesh.position.z - rp.lastPos.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    const remoteSpeed = dt > 0 ? dist / dt : 0;

    rp.lastPos.x = rp.mesh.position.x;
    rp.lastPos.y = rp.mesh.position.y;
    rp.lastPos.z = rp.mesh.position.z;

    updateAvatarAnim(rp.parts, remoteSpeed, true, false);
  }

  // debug cube in front of camera
  if (showDebugProof && MESH.frontCube && STATE.scene?.activeCamera) {
    const cam = STATE.scene.activeCamera;
    const fwd = cam.getForwardRay(3).direction;
    MESH.frontCube.position.copyFrom(cam.position).addInPlace(fwd.scale(3));
  }
});

/* ============================================================
 * COLYSEUS CLIENT
 * ============================================================
 */

const ENDPOINT =
  import.meta.env && import.meta.env.VITE_COLYSEUS_ENDPOINT
    ? import.meta.env.VITE_COLYSEUS_ENDPOINT
    : "ws://localhost:2567";

const colyseusClient = new Client(ENDPOINT);

async function connectColyseus() {
  console.log("Connecting to Colyseus at:", ENDPOINT);

  try {
    const room = await colyseusClient.joinOrCreate("my_room");
    colyRoom = room;

    console.log("Colyseus Connected. Session ID:", room.sessionId);

    room.onMessage("welcome", (msg) => {
      console.log("[server] welcome:", msg);
    });

    if (room.state) syncPlayersFromState(room.state);

    room.onStateChange((state) => {
      syncPlayersFromState(state);
    });

    // send loop
    setInterval(() => {
      if (!colyRoom) return;

      const p = getSafePlayerPos();
      const yaw = noa.camera.heading;
      const pitch = noa.camera.pitch;

      colyRoom.send("move", { x: p[0], y: p[1], z: p[2], yaw, pitch });
    }, 100);
  } catch (err) {
    console.error("Colyseus Connection Failed:", err);
  }
}

connectColyseus();

/* ============================================================
 * BOOT
 * ============================================================
 */

const bootInterval = setInterval(() => {
  if (ensureSceneReady()) {
    clearInterval(bootInterval);
    applyViewModeOnce();
    console.log("Scene Ready.");
  }
}, 100);
