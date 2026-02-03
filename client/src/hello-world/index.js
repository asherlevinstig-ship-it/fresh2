/*
 * Fresh2 - noa hello-world (main game entry) - REWORK V7.2 (JS-safe, NO OMITS)
 *
 * Rethink:
 * - Treat NOA's Babylon camera as `any` (prevents "FreeCamera not assignable to Node" in JS+TS check)
 * - Never pass Babylon Vector3 into typed DeepImmutable signatures (use plain arrays or create via same module)
 * - Parent using setParent / parent assignment through `any` to avoid protected/private typing conflicts
 *
 * Still recommended: dedupe Babylon packages in the build (single Babylon instance).
 */

import { Engine } from "noa-engine";
import { Client } from "@colyseus/sdk";

// Use babylonjs (UMD) to better match NOA.
// If your project still has @babylonjs/core, TS may still see mixed types.
// This file avoids those type errors by using `any` barriers.
import * as BABYLON from "babylonjs";

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
let armsRequirePointerLock = true;

let applyViewModeGlobal = null;

let fpArmsRef = null;
let localAvatar = null;

let debugSphere = null;
let debugSphereOn = false;
let testCube = null;

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

function getPointerLockTarget() {
  const noaAny = /** @type {any} */ (noa);
  const c = noaAny && noaAny.container;
  if (c && typeof c === "object" && "requestPointerLock" in c) return c;
  const div = document.getElementById("noa-container");
  if (div) return div;
  return document.querySelector("canvas");
}

function toDomElement(maybeEl) {
  if (!maybeEl) return null;
  if (maybeEl instanceof HTMLElement) return maybeEl;
  if (maybeEl instanceof HTMLCanvasElement) return maybeEl;

  if (typeof maybeEl === "object") {
    const hasAdd = typeof maybeEl.addEventListener === "function";
    const hasReq = typeof maybeEl.requestPointerLock === "function";
    if (hasAdd && hasReq) return /** @type {any} */ (maybeEl);
  }
  return null;
}

function isPointerLockedToNoa() {
  const el = toDomElement(getPointerLockTarget());
  return !!(el && document.pointerLockElement === el);
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
    avatarEnabled: false,
    avatarPos: "(none)",
    armsEnabled: false,
    armsPos: "(none)",
    armsRequireLock: true,
    testCubePos: "(none)",
    testCubeOn: false,
    debugSphere: false,
    debugSpherePos: "(none)",
    crosshair: false,
    last: "(boot)",
    lastError: "(none)",
  };

  function render() {
    el.textContent =
      `Fresh2 Debug V7.2\n` +
      `viewMode: ${state.viewMode} (${state.viewMode === 0 ? "first" : state.viewMode === 1 ? "third-back" : "third-front"})\n` +
      `locked: ${state.locked}\n` +
      `camPos: ${state.camPos}\n` +
      `avatar: enabled=${state.avatarEnabled} pos=${state.avatarPos}\n` +
      `arms: enabled=${state.armsEnabled} pos=${state.armsPos} (requireLock=${state.armsRequireLock})\n` +
      `testCube: enabled=${state.testCubeOn} pos=${state.testCubePos}\n` +
      `debugSphere: ${state.debugSphere} pos=${state.debugSpherePos}\n` +
      `crosshair: ${state.crosshair}\n` +
      `last: ${state.last}\n` +
      `error: ${state.lastError}\n` +
      `\nKeys: F5 view | F6 crosshair | F7 flip arms | F8 debug sphere | F9 arms lock toggle\n`;
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
    const el = toDomElement(getPointerLockTarget());
    if (!el) return;
    clearInterval(interval);

    if (typeof el.hasAttribute === "function" && !el.hasAttribute("tabindex")) el.setAttribute("tabindex", "1");
    if (el.style) el.style.outline = "none";

    el.addEventListener("click", () => {
      try {
        if (viewMode !== 0) return;
        if (document.pointerLockElement !== el) el.requestPointerLock();
      } catch (e) {
        debugHUD.state.lastError = String(e && e.message ? e.message : e);
      }
    });

    console.log("[PointerLock] handler attached");
  }, 100);
})();

/* ============================================================
 * NOA + Babylon camera access (treat as any to avoid TS conflicts)
 * ============================================================
 */

function getNoaBabylonCameraAny() {
  try {
    const r = /** @type {any} */ (noa).rendering;
    const cam = r && r.camera ? r.camera : null;
    return /** @type {any} */ (cam);
  } catch {
    return null;
  }
}

function getNoaSceneAny() {
  try {
    const s = /** @type {any} */ (noa).rendering.getScene();
    return /** @type {any} */ (s);
  } catch {
    return null;
  }
}

/* ============================================================
 * Skins + UV
 * ============================================================
 */

function getMcHeadsSkinUrl(identifier) {
  return `https://mc-heads.net/skin/${encodeURIComponent(identifier)}.png`;
}

function uvRect(px, py, pw, ph) {
  const texW = 64, texH = 64;
  return new BABYLON.Vector4(px / texW, py / texH, (px + pw) / texW, (py + ph) / texH);
}
function makeFaceUV(front, back, right, left, top, bottom) {
  return [front, back, right, left, top, bottom];
}

function createSkinMaterial(scene, skinUrl, name) {
  const tex = new BABYLON.Texture(skinUrl, scene, false, false, BABYLON.Texture.NEAREST_NEAREST);
  tex.hasAlpha = true;
  tex.wrapU = BABYLON.Texture.CLAMP_ADDRESSMODE;
  tex.wrapV = BABYLON.Texture.CLAMP_ADDRESSMODE;

  const mat = new BABYLON.StandardMaterial(name, scene);
  mat.diffuseTexture = tex;
  mat.emissiveColor = new BABYLON.Color3(0.15, 0.15, 0.15);
  mat.specularColor = new BABYLON.Color3(0, 0, 0);
  mat.backFaceCulling = false;

  tex.onLoadObservable?.add(() => console.log("[Skin] loaded:", skinUrl));
  return mat;
}

/* ============================================================
 * Test cube (placed in front of camera every frame)
 * ============================================================
 */

function createTestCube(scene) {
  const cube = BABYLON.MeshBuilder.CreateBox("testCube", { size: 2 }, scene);
  const mat = new BABYLON.StandardMaterial("testCubeMat", scene);
  mat.emissiveColor = new BABYLON.Color3(1, 0, 0);
  mat.disableLighting = true;
  cube.material = mat;
  cube.isPickable = false;
  cube.alwaysSelectAsActiveMesh = true;
  cube.setEnabled(true);
  cube.isVisible = true;
  console.log("[TestCube] created");
  return cube;
}

/* ============================================================
 * Third-person avatar
 * ============================================================
 */

function createPlayerAvatar(scene, skinUrl) {
  const root = new BABYLON.TransformNode("mc-avatar-root", scene);

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

  function part(name, w, h, d, uv) {
    const m = BABYLON.MeshBuilder.CreateBox(name, { width: w, height: h, depth: d, faceUV: uv }, scene);
    m.material = mat;
    m.parent = root;
    m.isPickable = false;
    m.alwaysSelectAsActiveMesh = true;
    return m;
  }

  const head = part("mc-head", 1, 1, 1, headUV);
  const body = part("mc-body", 1, 1.5, 0.5, bodyUV);
  const ra = part("mc-rightArm", 0.5, 1.5, 0.5, armUV);
  const la = part("mc-leftArm", 0.5, 1.5, 0.5, armUV);
  const rl = part("mc-rightLeg", 0.5, 1.5, 0.5, legUV);
  const ll = part("mc-leftLeg", 0.5, 1.5, 0.5, legUV);

  rl.position.set(-0.25, 0.75, 0);
  ll.position.set(0.25, 0.75, 0);
  body.position.set(0, 1.5 + 0.75, 0);
  head.position.set(0, 1.5 + 1.5 + 0.5, 0);
  ra.position.set(-0.75, 1.5 + 0.75, 0);
  la.position.set(0.75, 1.5 + 0.75, 0);

  console.log("[Avatar] created");
  return { root, head, body, rightArm: ra, leftArm: la, rightLeg: rl, leftLeg: ll };
}

/* ============================================================
 * First-person arms (camera-parented, using ANY barrier)
 * ============================================================
 */

function createFirstPersonArms(scene, skinUrl) {
  const root = new BABYLON.TransformNode("fp-arms-root", scene);
  root.setEnabled(false);

  const mat = createSkinMaterial(scene, skinUrl, "fp-skin-mat");
  const armUV = makeFaceUV(
    uvRect(44, 20, 4, 12), uvRect(52, 20, 4, 12), uvRect(48, 20, 4, 12),
    uvRect(40, 20, 4, 12), uvRect(44, 16, 4, 4), uvRect(48, 16, 4, 4)
  );

  const r = BABYLON.MeshBuilder.CreateBox("fp-rightArm", { width: 0.35, height: 0.9, depth: 0.35, faceUV: armUV }, scene);
  const l = BABYLON.MeshBuilder.CreateBox("fp-leftArm", { width: 0.35, height: 0.9, depth: 0.35, faceUV: armUV }, scene);
  r.material = mat; l.material = mat;
  r.parent = root; l.parent = root;

  r.position.set(0.45, -0.35, 1.0);
  l.position.set(-0.35, -0.40, 0.95);

  r.rotation.set(0.15, 0.2, 0.15);
  l.rotation.set(0.05, -0.25, -0.05);

  let enabled = false;
  let flipZ = false;

  const base = {
    rx: r.rotation.x, ry: r.rotation.y, rz: r.rotation.z,
    lx: l.rotation.x, ly: l.rotation.y, lz: l.rotation.z,
  };
  const anim = { active: false, t: 0, duration: 0.18 };

  function easeInOutQuad(x) {
    return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
  }

  function startSwing() { anim.active = true; anim.t = 0; }

  function updateAnim(dt) {
    if (!anim.active) return;
    anim.t += dt;
    const p = clamp(anim.t / anim.duration, 0, 1);
    const e = easeInOutQuad(p);
    const swing = Math.sin(e * Math.PI);

    r.rotation.x = base.rx + swing * 0.9;
    r.rotation.y = base.ry + swing * 0.25;
    r.rotation.z = base.rz - swing * 0.15;

    l.rotation.x = base.lx + swing * 0.25;
    l.rotation.y = base.ly - swing * 0.15;
    l.rotation.z = base.lz + swing * 0.05;

    if (p >= 1) {
      anim.active = false;
      r.rotation.set(base.rx, base.ry, base.rz);
      l.rotation.set(base.lx, base.ly, base.lz);
    }
  }

  function attachToCamera() {
    const camAny = getNoaBabylonCameraAny();
    if (!camAny) return;

    // avoid TS "FreeCamera not assignable to Node" by using `any`
    const rootAny = /** @type {any} */ (root);

    // both work depending on Babylon build:
    if (typeof rootAny.setParent === "function") rootAny.setParent(camAny);
    else rootAny.parent = camAny;

    root.position.set(0, 0, flipZ ? -1 : 1);
  }

  function setEnabled(v) {
    enabled = v;
    root.setEnabled(v);
    if (v) attachToCamera();
  }

  return {
    root, rightArm: r, leftArm: l,
    startSwing, updateAnim,
    setEnabled,
    get enabled() { return enabled; },
    get flipZ() { return flipZ; },
    set flipZ(v) {
      flipZ = v;
      if (enabled) root.position.z = flipZ ? -1 : 1;
    },
  };
}

/* ============================================================
 * Debug sphere
 * ============================================================
 */

function createDebugSphere(scene) {
  const sphere = BABYLON.MeshBuilder.CreateSphere("debugSphere", { diameter: 1.5 }, scene);
  const mat = new BABYLON.StandardMaterial("debugSphereMat", scene);
  mat.emissiveColor = new BABYLON.Color3(1, 0, 1);
  mat.disableLighting = true;
  sphere.material = mat;
  sphere.isPickable = false;
  sphere.setEnabled(false);
  sphere.isVisible = false;
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

  testCube = createTestCube(scene);
  localAvatar = createPlayerAvatar(scene, skinUrl);
  fpArmsRef = createFirstPersonArms(scene, skinUrl);
  debugSphere = createDebugSphere(scene);

  // Attach avatar to player entity
  const playerEntity = noa.playerEntity;
  try {
    const entities = /** @type {any} */ (noa).entities;
    const meshCompName = (entities.names && entities.names.mesh) ? entities.names.mesh : "mesh";
    const hasComp = entities["hasComponent"];
    const addComp = entities["addComponent"];
    const getComp = entities["getComponent"];

    if (typeof hasComp === "function" && typeof addComp === "function") {
      if (!hasComp.call(entities, playerEntity, meshCompName)) {
        addComp.call(entities, playerEntity, meshCompName, { mesh: localAvatar.root, offset: [0, 0, 0] });
      } else if (typeof getComp === "function") {
        const comp = getComp.call(entities, playerEntity, meshCompName);
        if (comp && typeof comp === "object" && "mesh" in comp) comp.mesh = localAvatar.root;
      }
    } else if (typeof addComp === "function") {
      addComp.call(entities, playerEntity, meshCompName, { mesh: localAvatar.root, offset: [0, 0, 0] });
    }

    console.log("[Avatar] attached to player entity");
  } catch (e) {
    console.error("[Avatar] attach failed:", e);
    debugHUD.state.lastError = String(e && e.message ? e.message : e);
  }

  function applyViewMode() {
    const locked = isPointerLockedToNoa();
    const isFirst = viewMode === 0;

    noa.camera.zoomDistance = isFirst ? 0 : 6;

    const avatarOn = !isFirst;
    localAvatar.root.setEnabled(avatarOn);

    const armsOn = isFirst && (!armsRequirePointerLock || locked);
    fpArmsRef.setEnabled(armsOn);

    debugHUD.state.viewMode = viewMode;
    debugHUD.state.avatarEnabled = avatarOn;
    debugHUD.state.armsEnabled = armsOn;
    debugHUD.state.armsRequireLock = armsRequirePointerLock;
    debugHUD.state.last = "applyViewMode";
    debugHUD.render();

    console.log("[applyViewMode] viewMode:", viewMode, "locked:", locked, "avatar:", avatarOn, "arms:", armsOn);
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

    const x = safeNum(playerState?.x, 0);
    const y = safeNum(playerState?.y, 10);
    const z = safeNum(playerState?.z, 0);

    avatar.root.position.set(x, y, z);

    remotes.set(sessionId, { avatar, tx: x, ty: y, tz: z });
    console.log("[Remote] spawned", sessionId, name);
  }

  function removeRemote(sessionId) {
    const r = remotes.get(sessionId);
    if (!r) return;
    try {
      // avatar.root is TransformNode; disposing children meshes should still work
      r.avatar.head.dispose(false, true);
      r.avatar.body.dispose(false, true);
      r.avatar.rightArm.dispose(false, true);
      r.avatar.leftArm.dispose(false, true);
      r.avatar.rightLeg.dispose(false, true);
      r.avatar.leftLeg.dispose(false, true);
      r.avatar.root.dispose();
    } catch {}
    remotes.delete(sessionId);
  }

  function updateRemote(sessionId, playerState) {
    const r = remotes.get(sessionId);
    if (!r) return;
    r.tx = safeNum(playerState?.x, r.tx);
    r.ty = safeNum(playerState?.y, r.ty);
    r.tz = safeNum(playerState?.z, r.tz);
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
 * Position helper
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
 * Colyseus connect
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
noa.colyseus = { endpoint: COLYSEUS_ENDPOINT, client: colyseusClient, room: null };

async function connectColyseus() {
  console.log("[Colyseus] connecting to:", COLYSEUS_ENDPOINT);
  await debugMatchmake(COLYSEUS_ENDPOINT);

  try {
    const room = await colyseusClient.joinOrCreate("my_room", { name: "Steve" });
    noa.colyseus.room = room;

    console.log("[Colyseus] connected, session:", room.sessionId);

    const scene = getNoaSceneAny();
    const camAny = getNoaBabylonCameraAny();
    console.log("[Babylon][probe] scene?", !!scene, "camera?", !!camAny, "cameraType:", camAny?.constructor?.name);

    initLocalAvatarOnce(scene, "Steve");
    createRemotePlayersManager(scene, room);

    setInterval(() => {
      const activeRoom = noa.colyseus.room;
      if (!activeRoom) return;
      const [x, y, z] = getLocalPlayerPosition();
      activeRoom.send("move", { x, y, z });
    }, 50);

  } catch (err) {
    console.error("[Colyseus] failed:", err);
    debugHUD.state.lastError = String(err?.message || err);

    const scene = getNoaSceneAny();
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
  if (fpArmsRef) fpArmsRef.updateAnim(dt);

  const scroll = noa.inputs.pointerState.scrolly;
  if (scroll !== 0 && viewMode !== 0) {
    noa.camera.zoomDistance += scroll > 0 ? 1 : -1;
    noa.camera.zoomDistance = clamp(noa.camera.zoomDistance, 2, 12);
  }
});

noa.on("beforeRender", function () {
  const camAny = getNoaBabylonCameraAny();

  // Place cube in front of camera each frame
  if (camAny && testCube) {
    try {
      // Avoid TS DeepImmutable issues: use BABYLON.Vector3 from same module as camera methods expect.
      const dir = camAny.getDirection(new BABYLON.Vector3(0, 0, 1));
      const pos = camAny.position.add(dir.scale(8));
      testCube.position.copyFrom(pos);

      debugHUD.state.testCubePos = `${testCube.position.x.toFixed(1)},${testCube.position.y.toFixed(1)},${testCube.position.z.toFixed(1)}`;
      debugHUD.state.testCubeOn = testCube.isEnabled();
    } catch (e) {
      debugHUD.state.lastError = String(e && e.message ? e.message : e);
    }
  }

  if (camAny && camAny.position) {
    debugHUD.state.camPos = `${camAny.position.x.toFixed(1)},${camAny.position.y.toFixed(1)},${camAny.position.z.toFixed(1)}`;
  }

  if (debugSphere && debugSphereOn && camAny) {
    const dir = camAny.getDirection(new BABYLON.Vector3(0, 0, 1));
    debugSphere.position.copyFrom(camAny.position.add(dir.scale(3)));
    debugHUD.state.debugSpherePos = `${debugSphere.position.x.toFixed(1)},${debugSphere.position.y.toFixed(1)},${debugSphere.position.z.toFixed(1)}`;
  }

  if (localAvatar) {
    const p = localAvatar.root.position;
    debugHUD.state.avatarPos = `${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}`;
  }
  if (fpArmsRef) {
    const ap = fpArmsRef.root.getAbsolutePosition();
    debugHUD.state.armsPos = `${ap.x.toFixed(1)},${ap.y.toFixed(1)},${ap.z.toFixed(1)}`;
  }

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

/* ============================================================
 * Keys
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
  }

  if (e.code === "F6") {
    e.preventDefault();
    forceCrosshair = !forceCrosshair;
    crosshairUI.refresh();
  }

  if (e.code === "F7") {
    e.preventDefault();
    if (fpArmsRef) fpArmsRef.flipZ = !fpArmsRef.flipZ;
  }

  if (e.code === "F8") {
    e.preventDefault();
    debugSphereOn = !debugSphereOn;
    if (debugSphere) {
      debugSphere.setEnabled(debugSphereOn);
      debugSphere.isVisible = debugSphereOn;
    }
    debugHUD.state.debugSphere = debugSphereOn;
  }

  if (e.code === "F9") {
    e.preventDefault();
    armsRequirePointerLock = !armsRequirePointerLock;
    debugHUD.state.armsRequireLock = armsRequirePointerLock;
    try { if (typeof applyViewModeGlobal === "function") applyViewModeGlobal(); } catch {}
  }
});
