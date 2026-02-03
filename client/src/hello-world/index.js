/*
 * Fresh2 - noa hello-world (main game entry) - FIXED V3
 *
 * Fixes:
 * - Proper TypeScript casts using `as unknown as`
 * - noa.entities methods accessed via bracket notation to avoid TS errors
 * - Manual arm positioning instead of camera parenting
 */

import { Engine } from "noa-engine";
import { Client } from "@colyseus/sdk";

import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Vector3, Quaternion, Vector4 } from "@babylonjs/core/Maths/math.vector";
import { Color3 } from "@babylonjs/core/Maths/math.color";

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

let viewMode = 0; // 0 first, 1 third-back, 2 third-front
let forceCrosshair = false;

let applyViewModeGlobal = null;

let fpArmsRef = null;
let localAvatar = null;

let debugSphere = null;
let debugSphereOn = false;

/* ============================================================
 * Small helpers
 * ============================================================
 */

function safeNum(v, fallback = 0) {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

/* ============================================================
 * Pointer lock target
 * ============================================================
 */

/**
 * @returns {any} The pointer lock target element
 */
function getPointerLockTarget() {
  // noa.container is the #noa-container div
  const noaAny = noa;
  const c = noaAny.container;
  if (c && typeof c === "object" && "requestPointerLock" in c) {
    return c;
  }
  const div = document.getElementById("noa-container");
  if (div) return div;
  return document.querySelector("canvas");
}

function isPointerLockedToNoa() {
  const target = getPointerLockTarget();
  return !!(target && document.pointerLockElement === target);
}

/* ============================================================
 * Debug HUD
 * ============================================================
 */

function createDebugHUD() {
  const el = document.createElement("div");
  el.id = "noa-debug-hud";
  Object.assign(el.style, {
    position: "fixed",
    top: "10px",
    left: "10px",
    zIndex: "1000000",
    padding: "8px 10px",
    background: "rgba(0,0,0,0.65)",
    color: "#fff",
    fontFamily: "monospace",
    fontSize: "12px",
    lineHeight: "1.35",
    borderRadius: "6px",
    pointerEvents: "none",
    whiteSpace: "pre",
    maxWidth: "70vw",
  });
  document.body.appendChild(el);

  const state = {
    viewMode: 0,
    locked: false,

    camPos: "(none)",
    camHeading: 0,
    camPitch: 0,

    avatarEnabled: false,
    avatarPos: "(none)",

    armsEnabled: false,
    armsPos: "(none)",

    debugSphere: false,
    debugSpherePos: "(none)",

    crosshair: false,
    last: "(boot)",
    lastError: "(none)",
  };

  function render() {
    el.textContent =
      `Fresh2 Debug V3\n` +
      `viewMode: ${state.viewMode} (${state.viewMode === 0 ? "first" : state.viewMode === 1 ? "third-back" : "third-front"})\n` +
      `locked: ${state.locked}\n` +
      `camPos: ${state.camPos}\n` +
      `camHeading: ${state.camHeading.toFixed(2)} pitch: ${state.camPitch.toFixed(2)}\n` +
      `avatar: enabled=${state.avatarEnabled} pos=${state.avatarPos}\n` +
      `arms: enabled=${state.armsEnabled} pos=${state.armsPos}\n` +
      `debugSphere (F8): ${state.debugSphere} pos=${state.debugSpherePos}\n` +
      `crosshair: ${state.crosshair}\n` +
      `last: ${state.last}\n` +
      `error: ${state.lastError}\n` +
      `\nKeys: F5 view | F6 crosshair | F7 flip arms | F8 debug sphere\n`;
  }

  return { el, state, render };
}

const debugHUD = createDebugHUD();

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
    debugHUD.state.crosshair = show;
    debugHUD.state.locked = locked;
    debugHUD.render();
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
    
    // Cast to any to avoid TS errors with noa's Container type
    const el = target;
    if (typeof el.hasAttribute === 'function' && !el.hasAttribute("tabindex")) {
      el.setAttribute("tabindex", "1");
    }
    if (el.style) {
      el.style.outline = "none";
    }
    
    el.addEventListener("click", () => {
      try {
        if (viewMode !== 0) return;
        if (document.pointerLockElement !== el) {
          el.requestPointerLock();
        }
      } catch (e) {
        debugHUD.state.lastError = String((e && typeof e === 'object' && 'message' in e) ? e.message : e);
      }
    });
    console.log("[PointerLock] handler attached");
  }, 100);
})();

/* ============================================================
 * noa Camera helpers
 * ============================================================
 */

function getNoaCameraPosition() {
  try {
    const pos = noa.camera.getPosition();
    if (pos && pos.length >= 3) {
      return new Vector3(pos[0], pos[1], pos[2]);
    }
  } catch {}
  
  // Fallback: player position + eye offset
  try {
    const ent = noa.playerEntity;
    const pos = noa.entities.getPosition(ent);
    if (pos && pos.length >= 3) {
      return new Vector3(pos[0], pos[1] + 1.6, pos[2]);
    }
  } catch {}
  
  return new Vector3(0, 10, 0);
}

function getNoaCameraRotation() {
  const heading = safeNum(noa.camera.heading, 0);
  const pitch = safeNum(noa.camera.pitch, 0);
  return { heading, pitch };
}

/* ============================================================
 * Key handlers: F5/F6/F7/F8
 * ============================================================
 */

document.addEventListener("keydown", (e) => {
  if (e.code === "F5") {
    e.preventDefault();
    viewMode = (viewMode + 1) % 3;
    if (viewMode !== 0) {
      try { document.exitPointerLock?.(); } catch {}
    }
    try { if (typeof applyViewModeGlobal === "function") applyViewModeGlobal(); } catch {}
    crosshairUI.refresh();
    console.log("[View] mode:", viewMode);
  }

  if (e.code === "F6") {
    e.preventDefault();
    forceCrosshair = !forceCrosshair;
    crosshairUI.refresh();
  }

  if (e.code === "F7") {
    e.preventDefault();
    if (fpArmsRef) {
      fpArmsRef.flipZ = !fpArmsRef.flipZ;
      console.log("[Debug] arms flipZ:", fpArmsRef.flipZ);
    }
  }

  if (e.code === "F8") {
    e.preventDefault();
    debugSphereOn = !debugSphereOn;
    if (debugSphere) {
      debugSphere.setEnabled(debugSphereOn);
    }
    debugHUD.state.debugSphere = debugSphereOn;
    debugHUD.render();
    console.log("[Debug] sphere:", debugSphereOn);
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
const noaAny = noa;
noaAny.colyseus = { endpoint: COLYSEUS_ENDPOINT, client: colyseusClient, room: null };

/* ============================================================
 * Skins
 * ============================================================
 */

function getMcHeadsSkinUrl(identifier) {
  return `https://mc-heads.net/skin/${encodeURIComponent(identifier)}.png`;
}

/* ============================================================
 * UV helpers + material
 * ============================================================
 */

function uvRect(px, py, pw, ph) {
  const texW = 64, texH = 64;
  return new Vector4(px / texW, py / texH, (px + pw) / texW, (py + ph) / texH);
}

function makeFaceUV(front, back, right, left, top, bottom) {
  return [front, back, right, left, top, bottom];
}

function createSkinMaterial(scene, skinUrl, name) {
  const skinTexture = new Texture(skinUrl, scene, false, false, Texture.NEAREST_NEAREST);
  skinTexture.hasAlpha = true;
  skinTexture.wrapU = Texture.CLAMP_ADDRESSMODE;
  skinTexture.wrapV = Texture.CLAMP_ADDRESSMODE;

  const mat = new StandardMaterial(name, scene);
  mat.diffuseTexture = skinTexture;
  mat.emissiveColor = new Color3(0.15, 0.15, 0.15);
  mat.specularColor = new Color3(0, 0, 0);
  mat.backFaceCulling = false;

  skinTexture.onLoadObservable?.add(() => console.log("[Skin] loaded:", skinUrl));
  return mat;
}

/* ============================================================
 * Third-person avatar
 * ============================================================
 */

function createPlayerAvatar(scene, skinUrl) {
  const root = new Mesh("mc-avatar-root", scene);
  root.isVisible = false;

  const mat = createSkinMaterial(scene, skinUrl, "mc-skin-mat");

  const headUV = makeFaceUV(
    uvRect(8, 8, 8, 8), uvRect(24, 8, 8, 8), uvRect(16, 8, 8, 8),
    uvRect(0, 8, 8, 8), uvRect(8, 0, 8, 8), uvRect(16, 0, 8, 8)
  );
  const bodyUV = makeFaceUV(
    uvRect(20, 20, 8, 12), uvRect(32, 20, 8, 12), uvRect(28, 20, 4, 12),
    uvRect(16, 20, 4, 12), uvRect(20, 16, 8, 4), uvRect(28, 16, 8, 4)
  );
  const armUV = makeFaceUV(
    uvRect(44, 20, 4, 12), uvRect(52, 20, 4, 12), uvRect(48, 20, 4, 12),
    uvRect(40, 20, 4, 12), uvRect(44, 16, 4, 4), uvRect(48, 16, 4, 4)
  );
  const legUV = makeFaceUV(
    uvRect(4, 20, 4, 12), uvRect(12, 20, 4, 12), uvRect(8, 20, 4, 12),
    uvRect(0, 20, 4, 12), uvRect(4, 16, 4, 4), uvRect(8, 16, 4, 4)
  );

  const headSize = { width: 1.0, height: 1.0, depth: 1.0 };
  const bodySize = { width: 1.0, height: 1.5, depth: 0.5 };
  const limbSize = { width: 0.5, height: 1.5, depth: 0.5 };

  function makePart(name, size, uv) {
    const mesh = MeshBuilder.CreateBox(name, { width: size.width, height: size.height, depth: size.depth, faceUV: uv }, scene);
    mesh.material = mat;
    mesh.parent = root;
    mesh.isVisible = true;
    mesh.isPickable = false;
    return mesh;
  }

  const head = makePart("mc-head", headSize, headUV);
  const body = makePart("mc-body", bodySize, bodyUV);
  const rightArm = makePart("mc-rightArm", limbSize, armUV);
  const leftArm = makePart("mc-leftArm", limbSize, armUV);
  const rightLeg = makePart("mc-rightLeg", limbSize, legUV);
  const leftLeg = makePart("mc-leftLeg", limbSize, legUV);

  const legY = limbSize.height / 2;
  rightLeg.position.set(-0.25, legY, 0);
  leftLeg.position.set(0.25, legY, 0);

  const bodyY = limbSize.height + bodySize.height / 2;
  body.position.set(0, bodyY, 0);

  const headY = limbSize.height + bodySize.height + headSize.height / 2;
  head.position.set(0, headY, 0);

  const armY = limbSize.height + bodySize.height - limbSize.height / 2;
  rightArm.position.set(-(bodySize.width / 2 + limbSize.width / 2), armY, 0);
  leftArm.position.set(bodySize.width / 2 + limbSize.width / 2, armY, 0);

  console.log("[Avatar] created with 6 parts");

  return { root, head, body, rightArm, leftArm, rightLeg, leftLeg, material: mat };
}

/* ============================================================
 * First-person arms - NO PARENTING, manual positioning
 * ============================================================
 */

function createFirstPersonArms(scene, skinUrl) {
  const root = new Mesh("fp-arms-root", scene);
  root.isVisible = false;

  const mat = createSkinMaterial(scene, skinUrl, "fp-skin-mat");

  const armUV = makeFaceUV(
    uvRect(44, 20, 4, 12), uvRect(52, 20, 4, 12), uvRect(48, 20, 4, 12),
    uvRect(40, 20, 4, 12), uvRect(44, 16, 4, 4), uvRect(48, 16, 4, 4)
  );

  const armSize = { width: 0.35, height: 0.9, depth: 0.35 };

  const rightArm = MeshBuilder.CreateBox("fp-rightArm", { width: armSize.width, height: armSize.height, depth: armSize.depth, faceUV: armUV }, scene);
  rightArm.material = mat;
  rightArm.parent = root;
  rightArm.isVisible = true;
  rightArm.isPickable = false;

  const leftArm = MeshBuilder.CreateBox("fp-leftArm", { width: armSize.width, height: armSize.height, depth: armSize.depth, faceUV: armUV }, scene);
  leftArm.material = mat;
  leftArm.parent = root;
  leftArm.isVisible = true;
  leftArm.isPickable = false;

  const rightArmOffset = new Vector3(0.45, -0.35, 0.55);
  const leftArmOffset = new Vector3(-0.35, -0.40, 0.50);

  rightArm.position.copyFrom(rightArmOffset);
  leftArm.position.copyFrom(leftArmOffset);

  rightArm.rotation.set(0.15, 0.2, 0.15);
  leftArm.rotation.set(0.05, -0.25, -0.05);

  const anim = { active: false, t: 0, duration: 0.18 };
  const base = {
    rx: rightArm.rotation.x, ry: rightArm.rotation.y, rz: rightArm.rotation.z,
    lx: leftArm.rotation.x, ly: leftArm.rotation.y, lz: leftArm.rotation.z,
  };

  let enabled = false;
  let flipZ = false;

  function startSwing() {
    anim.active = true;
    anim.t = 0;
  }

  function easeInOutQuad(x) {
    return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
  }

  function updateAnim(dt) {
    if (!anim.active) return;
    anim.t += dt;
    const p = clamp(anim.t / anim.duration, 0, 1);
    const e = easeInOutQuad(p);
    const swing = Math.sin(e * Math.PI);

    rightArm.rotation.x = base.rx + swing * 0.9;
    rightArm.rotation.y = base.ry + swing * 0.25;
    rightArm.rotation.z = base.rz - swing * 0.15;

    leftArm.rotation.x = base.lx + swing * 0.25;
    leftArm.rotation.y = base.ly - swing * 0.15;
    leftArm.rotation.z = base.lz + swing * 0.05;

    if (p >= 1) {
      anim.active = false;
      rightArm.rotation.set(base.rx, base.ry, base.rz);
      leftArm.rotation.set(base.lx, base.ly, base.lz);
    }
  }

  function updatePosition() {
    if (!enabled) return;

    const camPos = getNoaCameraPosition();
    const { heading, pitch } = getNoaCameraRotation();

    const quat = Quaternion.RotationYawPitchRoll(heading, pitch, 0);

    const forwardDist = flipZ ? -0.6 : 0.6;
    const downDist = -0.3;
    const rightDist = 0.1;

    const localOffset = new Vector3(rightDist, downDist, forwardDist);
    const worldOffset = localOffset.rotateByQuaternionToRef(quat, new Vector3());

    root.position.copyFrom(camPos.add(worldOffset));
    root.rotationQuaternion = quat;
  }

  function setEnabled(val) {
    enabled = val;
    root.setEnabled(val);
    rightArm.setEnabled(val);
    leftArm.setEnabled(val);
  }

  console.log("[FPArms] created (manual positioning)");

  return {
    root,
    rightArm,
    leftArm,
    startSwing,
    updateAnim,
    updatePosition,
    setEnabled,
    get flipZ() { return flipZ; },
    set flipZ(v) { flipZ = v; },
    get enabled() { return enabled; },
  };
}

/* ============================================================
 * Debug sphere - world space
 * ============================================================
 */

function createDebugSphere(scene) {
  const sphere = MeshBuilder.CreateSphere("debugSphere", { diameter: 1.5 }, scene);
  const mat = new StandardMaterial("debugSphereMat", scene);
  mat.diffuseColor = new Color3(1, 0, 1);
  mat.emissiveColor = new Color3(0.5, 0, 0.5);
  mat.backFaceCulling = false;
  sphere.material = mat;
  sphere.isPickable = false;
  sphere.setEnabled(false);

  console.log("[DebugSphere] created in world space");
  return sphere;
}

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
 * Local avatar init + view mode
 * ============================================================
 */

let localAvatarAttached = false;

function initLocalAvatarOnce(scene, playerIdentifier) {
  if (localAvatarAttached) return;

  const skinUrl = getMcHeadsSkinUrl(playerIdentifier);
  console.log("[Skin] URL:", skinUrl);

  localAvatar = createPlayerAvatar(scene, skinUrl);
  fpArmsRef = createFirstPersonArms(scene, skinUrl);
  debugSphere = createDebugSphere(scene);

  // Attach avatar to player entity using bracket notation to avoid TS errors
  const playerEntity = noa.playerEntity;
  try {
    const entities = noa.entities;
    const meshCompName = entities.names?.mesh ?? "mesh";
    
    // Access methods via bracket notation to avoid TypeScript errors
    const hasComp = entities["hasComponent"];
    const addComp = entities["addComponent"];
    
    if (typeof hasComp === "function" && typeof addComp === "function") {
      if (!hasComp.call(entities, playerEntity, meshCompName)) {
        addComp.call(entities, playerEntity, meshCompName, {
          mesh: localAvatar.root,
          offset: [0, 0, 0],
        });
        console.log("[Avatar] attached to player entity");
      }
    } else {
      // Fallback for older noa versions
      console.warn("[Avatar] hasComponent/addComponent not found, trying direct add");
      if (addComp) {
        addComp.call(entities, playerEntity, meshCompName, {
          mesh: localAvatar.root,
          offset: [0, 0, 0],
        });
        console.log("[Avatar] attached (fallback)");
      }
    }
  } catch (e) {
    console.error("[Avatar] attach failed:", e);
    debugHUD.state.lastError = String((e && typeof e === 'object' && 'message' in e) ? e.message : e);
  }

  function applyViewMode() {
    const locked = isPointerLockedToNoa();
    const isFirst = viewMode === 0;

    noa.camera.zoomDistance = isFirst ? 0 : 6;

    // Avatar: hidden in first person
    localAvatar.root.setEnabled(!isFirst);
    localAvatar.head.setEnabled(!isFirst);
    localAvatar.body.setEnabled(!isFirst);
    localAvatar.rightArm.setEnabled(!isFirst);
    localAvatar.leftArm.setEnabled(!isFirst);
    localAvatar.rightLeg.setEnabled(!isFirst);
    localAvatar.leftLeg.setEnabled(!isFirst);

    // Arms: shown only in first person AND locked
    const armsOn = isFirst && locked;
    fpArmsRef.setEnabled(armsOn);

    debugHUD.state.viewMode = viewMode;
    debugHUD.state.avatarEnabled = !isFirst;
    debugHUD.state.armsEnabled = armsOn;
    debugHUD.state.last = "applyViewMode";
    debugHUD.render();

    console.log("[applyViewMode] viewMode:", viewMode, "locked:", locked, "avatar:", !isFirst, "arms:", armsOn);
  }

  applyViewModeGlobal = applyViewMode;
  applyViewMode();

  document.addEventListener("pointerlockchange", applyViewMode);

  localAvatarAttached = true;
}

/* ============================================================
 * Remote players
 * ============================================================
 */

function createRemotePlayersManager(scene, room) {
  const remotes = new Map();

  function spawnRemote(sessionId, playerState) {
    const name = playerState?.name || "Steve";
    const skinUrl = getMcHeadsSkinUrl(name);
    const avatar = createPlayerAvatar(scene, skinUrl);
    
    avatar.root.setEnabled(true);
    avatar.head.setEnabled(true);
    avatar.body.setEnabled(true);
    avatar.rightArm.setEnabled(true);
    avatar.leftArm.setEnabled(true);
    avatar.rightLeg.setEnabled(true);
    avatar.leftLeg.setEnabled(true);

    const x = safeNum(playerState.x, 0);
    const y = safeNum(playerState.y, 10);
    const z = safeNum(playerState.z, 0);
    avatar.root.position.set(x, y, z);

    remotes.set(sessionId, { avatar, tx: x, ty: y, tz: z });
    console.log("[Remote] spawned", sessionId, name);
  }

  function removeRemote(sessionId) {
    const r = remotes.get(sessionId);
    if (!r) return;
    try { r.avatar.root.dispose(false, true); } catch {}
    remotes.delete(sessionId);
  }

  function updateRemote(sessionId, playerState) {
    const r = remotes.get(sessionId);
    if (!r) return;
    r.tx = safeNum(playerState.x, r.tx);
    r.ty = safeNum(playerState.y, r.ty);
    r.tz = safeNum(playerState.z, r.tz);
  }

  noa.on("tick", () => {
    const alpha = 0.2;
    remotes.forEach((r) => {
      const root = r.avatar.root;
      root.position.x += (r.tx - root.position.x) * alpha;
      root.position.y += (r.ty - root.position.y) * alpha;
      root.position.z += (r.tz - root.position.z) * alpha;
    });
  });

  (function waitForPlayersMap() {
    const interval = setInterval(() => {
      const players = room?.state?.players;
      if (players) {
        clearInterval(interval);
        players.onAdd = (playerState, sessionId) => {
          if (sessionId === room.sessionId) return;
          spawnRemote(sessionId, playerState);
          try { playerState.onChange = () => updateRemote(sessionId, playerState); } catch {}
        };
        players.onRemove = (_ps, sessionId) => removeRemote(sessionId);
        console.log("[Remote] hooked");
      }
    }, 50);
    setTimeout(() => clearInterval(interval), 5000);
  })();
}

/* ============================================================
 * Position helpers
 * ============================================================
 */

function getLocalPlayerPosition() {
  try {
    const p = noa.entities.getPosition(noa.playerEntity);
    if (p?.length >= 3) return [p[0], p[1], p[2]];
  } catch {}
  return [0, 10, 0];
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
    noaAny.colyseus.room = room;

    console.log("[Colyseus] connected, session:", room.sessionId);

    room.onMessage("*", (type, message) => console.log("[Colyseus] msg:", type, message));
    room.onLeave(() => {
      console.warn("[Colyseus] left");
      noaAny.colyseus.room = null;
    });

    const scene = noa.rendering.getScene();
    initLocalAvatarOnce(scene, "Steve");
    createRemotePlayersManager(scene, room);

    setInterval(() => {
      const activeRoom = noaAny.colyseus.room;
      if (!activeRoom) return;
      const [x, y, z] = getLocalPlayerPosition();
      const { heading, pitch } = getNoaCameraRotation();
      activeRoom.send("move", { x, y, z, yaw: heading, pitch });
    }, 50);

  } catch (err) {
    console.error("[Colyseus] failed:", err);
    debugHUD.state.lastError = String(err?.message || err);

    const scene = noa.rendering.getScene();
    initLocalAvatarOnce(scene, "Steve");
  }
}

connectColyseus();

/* ============================================================
 * Main tick
 * ============================================================
 */

noa.on("tick", function () {
  const dt = 1 / 60;

  if (fpArmsRef) {
    fpArmsRef.updateAnim(dt);
  }

  const scroll = noa.inputs.pointerState.scrolly;
  if (scroll !== 0 && viewMode !== 0) {
    noa.camera.zoomDistance += scroll > 0 ? 1 : -1;
    noa.camera.zoomDistance = clamp(noa.camera.zoomDistance, 2, 12);
  }
});

noa.on("beforeRender", function () {
  if (fpArmsRef && fpArmsRef.enabled) {
    fpArmsRef.updatePosition();
  }

  if (debugSphere && debugSphereOn) {
    const camPos = getNoaCameraPosition();
    const { heading } = getNoaCameraRotation();
    
    const forwardX = Math.sin(heading) * 3;
    const forwardZ = Math.cos(heading) * 3;
    debugSphere.position.set(camPos.x + forwardX, camPos.y, camPos.z + forwardZ);
    
    debugHUD.state.debugSpherePos = `${debugSphere.position.x.toFixed(1)},${debugSphere.position.y.toFixed(1)},${debugSphere.position.z.toFixed(1)}`;
  }

  if (localAvatar) {
    const pos = localAvatar.root.position;
    debugHUD.state.avatarPos = `${pos.x.toFixed(1)},${pos.y.toFixed(1)},${pos.z.toFixed(1)}`;
  }
  if (fpArmsRef) {
    const pos = fpArmsRef.root.position;
    debugHUD.state.armsPos = `${pos.x.toFixed(1)},${pos.y.toFixed(1)},${pos.z.toFixed(1)}`;
  }

  const camPos = getNoaCameraPosition();
  const { heading, pitch } = getNoaCameraRotation();
  debugHUD.state.camPos = `${camPos.x.toFixed(1)},${camPos.y.toFixed(1)},${camPos.z.toFixed(1)}`;
  debugHUD.state.camHeading = heading;
  debugHUD.state.camPitch = pitch;
  debugHUD.render();
});

/* ============================================================
 * Interactivity
 * ============================================================
 */

noa.inputs.down.on("fire", function () {
  if (fpArmsRef && viewMode === 0) fpArmsRef.startSwing();
  if (noa.targetedBlock) {
    const pos = noa.targetedBlock.position;
    noa.setBlock(0, pos[0], pos[1], pos[2]);
  }
});

noa.inputs.down.on("alt-fire", function () {
  if (fpArmsRef && viewMode === 0) fpArmsRef.startSwing();
  if (noa.targetedBlock) {
    const pos = noa.targetedBlock.adjacent;
    noa.setBlock(grassID, pos[0], pos[1], pos[2]);
  }
});

noa.inputs.bind("alt-fire", "KeyE");