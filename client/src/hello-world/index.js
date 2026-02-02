/*
 *
 *          Fresh2 - noa hello-world (main game entry)
 *
 *  Extended with:
 *   - Minecraft-style crosshair overlay (shows only when pointer lock active)
 *   - Click-to-pointer-lock (so crosshair actually appears)
 *   - Colyseus multiplayer client connection (@colyseus/sdk)
 *   - Minecraft-style blocky avatar built from boxes with live skins (MCHeads - CORS friendly)
 *   - Multiplayer remote players driven from Colyseus Schema state (players map)
 *   - FIRST PERSON ARMS / HANDS viewmodel (Minecraft-like):
 *       - Separate arms rig parented to noa.rendering.camera (Babylon camera)
 *       - Shows in pointer lock (first-person)
 *       - Hides in third person
 *       - Simple swing animation on fire / alt-fire
 *       - Simple held block in right hand (grass)
 *
 *  Fixes included:
 *   - Avatar root is a Babylon Mesh (AbstractMesh) to avoid Babylon LOD/active-mesh crashes.
 *   - Skins loaded from https://mc-heads.net/skin/<identifier>.png (username OR UUID).
 *   - First-person: full avatar hidden + removed from shadow render lists (prevents floating shadow).
 *   - Prevents double local-avatar attach (no “Entity already has component: mesh”).
 *   - Robust Colyseus state hookup: waits for room.state.players to exist before using onAdd/onRemove.
 *
 */

/* ============================================================
 * Imports
 * ============================================================
 */

import { Engine } from "noa-engine";
import { Client } from "@colyseus/sdk";

import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Vector4 } from "@babylonjs/core/Maths/math.vector";
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
const noaAny = /** @type {any} */ (noa);

/* ============================================================
 * Helpers
 * ============================================================
 */

function getNoaCanvas() {
  if (noa && noa.container && noa.container.canvas) return noa.container.canvas;
  const c = document.querySelector("canvas");
  return c || null;
}

function safeNum(v, fallback = 0) {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

/* ============================================================
 * UI: Minecraft-style Crosshair
 * ============================================================
 */

function createCrosshairOverlay(noaEngine) {
  const crosshair = document.createElement("div");
  crosshair.id = "noa-crosshair";

  Object.assign(crosshair.style, {
    position: "fixed",
    top: "50%",
    left: "50%",
    width: "16px",
    height: "16px",
    transform: "translate(-50%, -50%)",
    pointerEvents: "none",
    zIndex: "999999",
    display: "none",
    alignItems: "center",
    justifyContent: "center",
  });

  const lineStyle = {
    position: "absolute",
    backgroundColor: "rgba(255,255,255,0.9)",
    boxShadow: "0px 0px 2px rgba(0,0,0,0.85)",
  };

  const hLine = document.createElement("div");
  Object.assign(hLine.style, lineStyle, {
    width: "100%",
    height: "2px",
    top: "7px",
    left: "0px",
  });

  const vLine = document.createElement("div");
  Object.assign(vLine.style, lineStyle, {
    width: "2px",
    height: "100%",
    left: "7px",
    top: "0px",
  });

  crosshair.appendChild(hLine);
  crosshair.appendChild(vLine);
  document.body.appendChild(crosshair);

  function getNoaCanvasLocal() {
    if (noaEngine && noaEngine.container && noaEngine.container.canvas) {
      return noaEngine.container.canvas;
    }
    const c = document.querySelector("canvas");
    return c || null;
  }

  function updateVisibility() {
    const canvas = getNoaCanvasLocal();
    const locked = canvas && document.pointerLockElement === canvas;
    crosshair.style.display = locked ? "flex" : "none";
  }

  document.addEventListener("pointerlockchange", updateVisibility);

  const interval = setInterval(() => {
    updateVisibility();
    const canvas = getNoaCanvasLocal();
    if (canvas) clearInterval(interval);
  }, 250);

  return {
    element: crosshair,
    show: () => (crosshair.style.display = "flex"),
    hide: () => (crosshair.style.display = "none"),
    refresh: updateVisibility,
  };
}

const crosshairUI = createCrosshairOverlay(noa);

/* ============================================================
 * Pointer lock helper (click canvas to lock mouse)
 * ============================================================
 */

(function enableClickToPointerLock() {
  const interval = setInterval(() => {
    const canvas = getNoaCanvas();
    if (!canvas) return;

    clearInterval(interval);

    if (!canvas.hasAttribute("tabindex")) canvas.setAttribute("tabindex", "0");
    canvas.style.outline = "none";

    canvas.addEventListener("click", () => {
      try {
        if (document.pointerLockElement !== canvas) {
          canvas.requestPointerLock();
        }
      } catch (e) {
        console.warn("[PointerLock] request failed:", e);
      }
    });
  }, 100);
})();

/* ============================================================
 * Colyseus setup + debug
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

  console.log("[Colyseus][debug] ws endpoint:", endpointWsOrHttp);
  console.log("[Colyseus][debug] http endpoint:", http);

  try {
    const r1 = await fetch(`${http}/hi`, { method: "GET" });
    const t1 = await r1.text();
    console.log("[Colyseus][debug] GET /hi status:", r1.status);
    console.log("[Colyseus][debug] GET /hi body:", t1.slice(0, 200));
  } catch (e) {
    console.error("[Colyseus][debug] GET /hi failed:", e);
  }

  try {
    const r2 = await fetch(`${http}/matchmake/joinOrCreate/my_room`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    const t2 = await r2.text();
    console.log("[Colyseus][debug] POST /matchmake/joinOrCreate/my_room status:", r2.status);
    console.log("[Colyseus][debug] raw body:", t2.slice(0, 400));

    try {
      const j = JSON.parse(t2);
      console.log("[Colyseus][debug] parsed JSON:", j);
    } catch {
      console.warn("[Colyseus][debug] response was not JSON");
    }
  } catch (e) {
    console.error("[Colyseus][debug] matchmake POST failed:", e);
  }
}

const colyseusClient = new Client(COLYSEUS_ENDPOINT);

noaAny.colyseus = {
  endpoint: COLYSEUS_ENDPOINT,
  client: colyseusClient,
  room: null,
};

/* ============================================================
 * MCHeads skin helper
 * ============================================================
 */

function getMcHeadsSkinUrl(identifier) {
  return `https://mc-heads.net/skin/${encodeURIComponent(identifier)}.png`;
}

/* ============================================================
 * Avatar (Minecraft skin UVs)
 * ============================================================
 */

function uvRect(px, py, pw, ph) {
  const texW = 64;
  const texH = 64;
  return new Vector4(px / texW, py / texH, (px + pw) / texW, (py + ph) / texH);
}

function makeFaceUV(front, back, right, left, top, bottom) {
  return [front, back, right, left, top, bottom];
}

function createSkinMaterial(scene, skinUrl, name = "mc-skin-mat") {
  const skinTexture = new Texture(skinUrl, scene, false, false, Texture.NEAREST_NEAREST);
  skinTexture.hasAlpha = true;
  skinTexture.wrapU = Texture.CLAMP_ADDRESSMODE;
  skinTexture.wrapV = Texture.CLAMP_ADDRESSMODE;

  const mat = new StandardMaterial(name, scene);
  mat.diffuseTexture = skinTexture;
  mat.emissiveColor = new Color3(0.05, 0.05, 0.05);
  mat.specularColor = new Color3(0, 0, 0);

  skinTexture.onLoadObservable.add(() => {
    try {
      mat.freeze();
    } catch {
      // ok
    }
  });

  return mat;
}

function createPlayerAvatar(scene, skinUrl) {
  const root = new Mesh("mc-avatar-root", scene);
  root.isVisible = false;

  const mat = createSkinMaterial(scene, skinUrl, "mc-skin-mat");

  const headUV = makeFaceUV(
    uvRect(8, 8, 8, 8),
    uvRect(24, 8, 8, 8),
    uvRect(16, 8, 8, 8),
    uvRect(0, 8, 8, 8),
    uvRect(8, 0, 8, 8),
    uvRect(16, 0, 8, 8)
  );

  const bodyUV = makeFaceUV(
    uvRect(20, 20, 8, 12),
    uvRect(32, 20, 8, 12),
    uvRect(28, 20, 4, 12),
    uvRect(16, 20, 4, 12),
    uvRect(20, 16, 8, 4),
    uvRect(28, 16, 8, 4)
  );

  const rightArmUV = makeFaceUV(
    uvRect(44, 20, 4, 12),
    uvRect(52, 20, 4, 12),
    uvRect(48, 20, 4, 12),
    uvRect(40, 20, 4, 12),
    uvRect(44, 16, 4, 4),
    uvRect(48, 16, 4, 4)
  );

  const leftArmUV = rightArmUV;

  const rightLegUV = makeFaceUV(
    uvRect(4, 20, 4, 12),
    uvRect(12, 20, 4, 12),
    uvRect(8, 20, 4, 12),
    uvRect(0, 20, 4, 12),
    uvRect(4, 16, 4, 4),
    uvRect(8, 16, 4, 4)
  );

  const leftLegUV = rightLegUV;

  const headSize = { width: 1.0, height: 1.0, depth: 1.0 };
  const bodySize = { width: 1.0, height: 1.5, depth: 0.5 };
  const limbSize = { width: 0.5, height: 1.5, depth: 0.5 };

  const head = MeshBuilder.CreateBox("mc-head", { width: headSize.width, height: headSize.height, depth: headSize.depth, faceUV: headUV }, scene);
  head.material = mat;
  head.parent = root;

  const body = MeshBuilder.CreateBox("mc-body", { width: bodySize.width, height: bodySize.height, depth: bodySize.depth, faceUV: bodyUV }, scene);
  body.material = mat;
  body.parent = root;

  const rightArm = MeshBuilder.CreateBox("mc-rightArm", { width: limbSize.width, height: limbSize.height, depth: limbSize.depth, faceUV: rightArmUV }, scene);
  rightArm.material = mat;
  rightArm.parent = root;

  const leftArm = MeshBuilder.CreateBox("mc-leftArm", { width: limbSize.width, height: limbSize.height, depth: limbSize.depth, faceUV: leftArmUV }, scene);
  leftArm.material = mat;
  leftArm.parent = root;

  const rightLeg = MeshBuilder.CreateBox("mc-rightLeg", { width: limbSize.width, height: limbSize.height, depth: limbSize.depth, faceUV: rightLegUV }, scene);
  rightLeg.material = mat;
  rightLeg.parent = root;

  const leftLeg = MeshBuilder.CreateBox("mc-leftLeg", { width: limbSize.width, height: limbSize.height, depth: limbSize.depth, faceUV: leftLegUV }, scene);
  leftLeg.material = mat;
  leftLeg.parent = root;

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

  return {
    root,
    material: mat,
    parts: { head, body, leftArm, rightArm, leftLeg, rightLeg },
  };
}

/* ============================================================
 * First-person arms / hands viewmodel
 *  - Uses noa.rendering.camera (Babylon camera) to parent arms
 * ============================================================
 */

function getBabylonCameraFromNoa(scene) {
  // In noa-engine v0.33, `noa.rendering.camera` exists per your .d.ts.
  // It is the Babylon camera wrapper used by noa.
  try {
    const cam = noa.rendering && noa.rendering.camera ? noa.rendering.camera : null;
    if (cam) return cam;
  } catch {
    // ignore
  }
  return scene.activeCamera || null;
}

function createFirstPersonArms(scene, skinUrl) {
  const cam = getBabylonCameraFromNoa(scene);
  if (!cam) {
    console.warn("[FPArms] No camera found; skipping first-person arms.");
    return null;
  }

  const root = new Mesh("fp-arms-root", scene);
  root.isVisible = false;
  root.parent = cam;

  // Tweak these for feel
  root.position.set(0.38, -0.42, 0.95);
  root.rotation.set(0, 0, 0);
  root.scaling.set(0.85, 0.85, 0.85);

  // Separate material so we can render on top
  const mat = createSkinMaterial(scene, skinUrl, "fp-skin-mat");
  mat.disableDepthWrite = true;

  const rightArmUV = makeFaceUV(
    uvRect(44, 20, 4, 12),
    uvRect(52, 20, 4, 12),
    uvRect(48, 20, 4, 12),
    uvRect(40, 20, 4, 12),
    uvRect(44, 16, 4, 4),
    uvRect(48, 16, 4, 4)
  );
  const leftArmUV = rightArmUV;

  const armSize = { width: 0.42, height: 1.05, depth: 0.42 };

  const rightArm = MeshBuilder.CreateBox("fp-rightArm", { width: armSize.width, height: armSize.height, depth: armSize.depth, faceUV: rightArmUV }, scene);
  rightArm.material = mat;
  rightArm.parent = root;
  rightArm.renderingGroupId = 2;

  const leftArm = MeshBuilder.CreateBox("fp-leftArm", { width: armSize.width, height: armSize.height, depth: armSize.depth, faceUV: leftArmUV }, scene);
  leftArm.material = mat;
  leftArm.parent = root;
  leftArm.renderingGroupId = 2;

  rightArm.position.set(0.32, -0.15, 0.0);
  leftArm.position.set(-0.22, -0.22, -0.05);

  rightArm.rotation.set(0.15, 0.2, 0.15);
  leftArm.rotation.set(0.05, -0.25, -0.05);

  // Held block cube (simple placeholder)
  const heldBlock = MeshBuilder.CreateBox("fp-heldBlock", { size: 0.35 }, scene);
  const heldMat = new StandardMaterial("fp-heldMat", scene);
  heldMat.diffuseColor = new Color3(0.1, 0.8, 0.2);
  heldMat.specularColor = new Color3(0, 0, 0);
  heldMat.emissiveColor = new Color3(0.02, 0.02, 0.02);
  heldMat.disableDepthWrite = true;
  heldBlock.material = heldMat;
  heldBlock.parent = rightArm;
  heldBlock.position.set(0.0, -0.55, 0.25);
  heldBlock.rotation.set(0.0, 0.6, 0.0);
  heldBlock.renderingGroupId = 2;

  const anim = {
    active: false,
    t: 0,
    duration: 0.18,
    strength: 1.0,
    mode: "break",
  };

  const base = {
    rootRotX: root.rotation.x,
    rootRotY: root.rotation.y,
    rootRotZ: root.rotation.z,
    rightRotX: rightArm.rotation.x,
    rightRotY: rightArm.rotation.y,
    rightRotZ: rightArm.rotation.z,
    leftRotX: leftArm.rotation.x,
    leftRotY: leftArm.rotation.y,
    leftRotZ: leftArm.rotation.z,
  };

  function startSwing(mode = "break") {
    anim.active = true;
    anim.t = 0;
    anim.mode = mode;
    anim.duration = mode === "place" ? 0.14 : 0.18;
    anim.strength = mode === "place" ? 0.75 : 1.0;
  }

  function easeInOutQuad(x) {
    return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
  }

  function update(dt) {
    if (!anim.active) return;

    anim.t += dt;
    const p = clamp(anim.t / anim.duration, 0, 1);
    const e = easeInOutQuad(p);
    const swing = Math.sin(e * Math.PI) * anim.strength;

    rightArm.rotation.x = base.rightRotX + swing * 0.9;
    rightArm.rotation.y = base.rightRotY + swing * 0.25;
    rightArm.rotation.z = base.rightRotZ - swing * 0.15;

    leftArm.rotation.x = base.leftRotX + swing * 0.25;
    leftArm.rotation.y = base.leftRotY - swing * 0.15;
    leftArm.rotation.z = base.leftRotZ + swing * 0.05;

    root.rotation.x = base.rootRotX + swing * 0.08;
    root.rotation.y = base.rootRotY;
    root.rotation.z = base.rootRotZ;

    if (p >= 1) {
      anim.active = false;
      rightArm.rotation.set(base.rightRotX, base.rightRotY, base.rightRotZ);
      leftArm.rotation.set(base.leftRotX, base.leftRotY, base.leftRotZ);
      root.rotation.set(base.rootRotX, base.rootRotY, base.rootRotZ);
    }
  }

  function setEnabled(enabled) {
    root.setEnabled(enabled);
  }

  return { root, rightArm, leftArm, heldBlock, startSwing, update, setEnabled };
}

/* ============================================================
 * Shadows: enable/disable casting via ShadowGenerator renderList
 * ============================================================
 */

function getShadowGenerators(scene) {
  const gens = [];
  const lights = scene.lights || [];
  for (const l of lights) {
    const la = /** @type {any} */ (l);
    try {
      const gen = la.getShadowGenerator ? la.getShadowGenerator() : null;
      if (gen) gens.push(gen);
    } catch {
      // ignore
    }
  }
  return gens;
}

function setMeshesInShadowRenderList(scene, meshes, shouldCast) {
  const gens = getShadowGenerators(scene);
  if (!gens.length) return;

  for (const gen of gens) {
    const sm = gen.getShadowMap ? gen.getShadowMap() : null;
    if (!sm) continue;

    if (!sm.renderList) sm.renderList = [];

    for (const mesh of meshes) {
      const idx = sm.renderList.indexOf(mesh);
      if (shouldCast) {
        if (idx === -1) sm.renderList.push(mesh);
      } else {
        if (idx !== -1) sm.renderList.splice(idx, 1);
      }
    }
  }
}

/* ============================================================
 * Register voxel types (materials + blocks)
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
 * Local avatar + FP arms: init once
 * ============================================================
 */

let localAvatarAttached = false;
let localAvatarRef = null;
let fpArmsRef = null;

function initLocalAvatarOnce(scene, playerIdentifier) {
  if (localAvatarAttached) return localAvatarRef;

  const entities = /** @type {any} */ (noa.entities);
  const playerEntity = noa.playerEntity;

  // If mesh component already exists, don't re-add
  try {
    if (entities && typeof entities.hasComponent === "function") {
      if (entities.hasComponent(playerEntity, noa.entities.names.mesh)) {
        localAvatarAttached = true;
        return localAvatarRef;
      }
    }
  } catch {
    // ignore
  }

  const skinUrl = getMcHeadsSkinUrl(playerIdentifier);
  console.log("[Skin] Using MCHeads skin URL:", skinUrl);

  const avatar = createPlayerAvatar(scene, skinUrl);

  // Create first-person arms (separate rig)
  fpArmsRef = createFirstPersonArms(scene, skinUrl);

  const probedPlayerHeight = typeof noaAny.playerHeight === "number" ? noaAny.playerHeight : null;
  const playerHeight = probedPlayerHeight || 1.8;
  const meshOffsetY = playerHeight * 0.5;

  entities.addComponent(playerEntity, noa.entities.names.mesh, {
    mesh: avatar.root,
    offset: [0, meshOffsetY, 0],
  });

  // Default: third-person zoom distance
  noa.camera.zoomDistance = 6;

  const avatarMeshes = avatar.root.getChildMeshes ? avatar.root.getChildMeshes() : [];

  function applyFirstPersonState(locked) {
    // First-person: hide full avatar, show FP arms
    avatar.root.setEnabled(!locked);

    setMeshesInShadowRenderList(scene, avatarMeshes, !locked);

    for (const m of avatarMeshes) {
      try {
        m.receiveShadows = !locked;
      } catch {
        // ignore
      }
    }

    if (fpArmsRef) fpArmsRef.setEnabled(!!locked);
  }

  const canvas = getNoaCanvas();
  const initiallyLocked = canvas && document.pointerLockElement === canvas;
  applyFirstPersonState(!!initiallyLocked);

  document.addEventListener("pointerlockchange", () => {
    const c = getNoaCanvas();
    const locked = c && document.pointerLockElement === c;
    applyFirstPersonState(!!locked);
    crosshairUI.refresh();
  });

  localAvatarAttached = true;
  localAvatarRef = { avatar };
  return localAvatarRef;
}

/* ============================================================
 * Remote players manager: robust hookup
 * ============================================================
 */

function createRemotePlayersManager(scene, room) {
  const remotes = new Map(); // sessionId -> { avatar, tx, ty, tz }

  function spawnRemote(sessionId, playerState) {
    const name =
      playerState && typeof playerState.name === "string" && playerState.name
        ? playerState.name
        : "Steve";

    const skinUrl = getMcHeadsSkinUrl(name);
    const avatar = createPlayerAvatar(scene, skinUrl);

    avatar.root.setEnabled(true);

    const x = safeNum(playerState.x, 0);
    const y = safeNum(playerState.y, 10);
    const z = safeNum(playerState.z, 0);

    avatar.root.position.set(x, y, z);

    remotes.set(sessionId, { avatar, tx: x, ty: y, tz: z });

    console.log("[Remote] spawned", sessionId, "name:", name);
  }

  function removeRemote(sessionId) {
    const r = remotes.get(sessionId);
    if (!r) return;

    try {
      const childMeshes = r.avatar.root.getChildMeshes ? r.avatar.root.getChildMeshes() : [];
      for (const m of childMeshes) {
        try {
          m.dispose(false, true);
        } catch {
          /* ignore */
        }
      }
      try {
        r.avatar.root.dispose(false, true);
      } catch {
        /* ignore */
      }

      try {
        const mat = r.avatar.material;
        if (mat) {
          const tex = mat.diffuseTexture;
          try {
            tex && tex.dispose && tex.dispose();
          } catch {
            /* ignore */
          }
          try {
            mat.dispose && mat.dispose();
          } catch {
            /* ignore */
          }
        }
      } catch {
        // ignore
      }
    } catch {
      // ignore
    }

    remotes.delete(sessionId);
    console.log("[Remote] removed", sessionId);
  }

  function updateRemote(sessionId, playerState) {
    const r = remotes.get(sessionId);
    if (!r) return;

    r.tx = safeNum(playerState.x, r.tx);
    r.ty = safeNum(playerState.y, r.ty);
    r.tz = safeNum(playerState.z, r.tz);

    const yaw = safeNum(playerState.yaw, 0);
    try {
      r.avatar.root.rotation.y = yaw;
    } catch {
      /* ignore */
    }
  }

  // Smooth movement each tick
  noa.on("tick", () => {
    const dt = 1 / 60;
    const alpha = clamp(dt * 12, 0, 1);

    remotes.forEach((r) => {
      const root = r.avatar.root;
      root.position.set(
        root.position.x + (r.tx - root.position.x) * alpha,
        root.position.y + (r.ty - root.position.y) * alpha,
        root.position.z + (r.tz - root.position.z) * alpha
      );
    });
  });

  function hookPlayersMap(players) {
    players.onAdd = (playerState, sessionId) => {
      if (sessionId === room.sessionId) return;
      spawnRemote(sessionId, playerState);

      try {
        playerState.onChange = () => updateRemote(sessionId, playerState);
      } catch {
        // ignore
      }
    };

    players.onRemove = (_playerState, sessionId) => {
      removeRemote(sessionId);
    };

    try {
      players.forEach((playerState, sessionId) => {
        if (sessionId === room.sessionId) return;
        if (!remotes.has(sessionId)) spawnRemote(sessionId, playerState);
      });
    } catch {
      // ignore
    }
  }

  (function waitForPlayersMap() {
    const maxWaitMs = 5000;
    const start = performance.now();

    const interval = setInterval(() => {
      const players = room && room.state ? room.state.players : null;

      if (players) {
        clearInterval(interval);
        hookPlayersMap(players);
        console.log("[Remote] hooked room.state.players");
        return;
      }

      if (performance.now() - start > maxWaitMs) {
        clearInterval(interval);
        console.warn(
          "[Remote] room.state.players was never found. " +
            "Server may be running an old schema. Remote avatars disabled."
        );
      }
    }, 50);
  })();

  return { remotes };
}

/* ============================================================
 * Local transform sender (client -> server)
 * ============================================================
 */

function getLocalPlayerPositionFallback() {
  try {
    const ent = noa.playerEntity;
    const ents = /** @type {any} */ (noa.entities);
    if (ents && typeof ents.getPosition === "function") {
      const p = ents.getPosition(ent);
      if (p && p.length >= 3) return [p[0], p[1], p[2]];
    }
  } catch {
    // ignore
  }
  return [0, 10, 0];
}

function getCameraYawPitchFallback() {
  const cam = noa.camera || noaAny.camera;
  if (!cam) return { yaw: 0, pitch: 0 };

  const yaw = safeNum(cam.heading, safeNum(cam.yaw, safeNum(cam.rotation?.y, 0)));
  const pitch = safeNum(cam.pitch, safeNum(cam.rotation?.x, 0));
  return { yaw, pitch };
}

/* ============================================================
 * Connect Colyseus + init everything
 * ============================================================
 */

async function connectColyseus() {
  console.log("[Colyseus] attempting connection...");
  console.log("[Colyseus] page protocol:", typeof window !== "undefined" && window.location ? window.location.protocol : "(unknown)");
  console.log("[Colyseus] endpoint:", COLYSEUS_ENDPOINT);
  console.log("[Colyseus] room name:", "my_room");

  await debugMatchmake(COLYSEUS_ENDPOINT);

  try {
    const joinOptions = { name: "Steve" };

    const room = await colyseusClient.joinOrCreate("my_room", joinOptions);
    noaAny.colyseus.room = room;

    console.log("[Colyseus] connected OK");
    console.log("[Colyseus] roomId:", room.roomId || "(unknown)");
    console.log("[Colyseus] sessionId:", room.sessionId);

    room.onMessage("*", (type, message) => {
      console.log("[Colyseus] message:", type, message);
    });

    room.onLeave((code) => {
      console.warn("[Colyseus] left room. code:", code);
      noaAny.colyseus.room = null;
    });

    const scene = noa.rendering.getScene();

    // Init local avatar ONCE (includes FP arms)
    initLocalAvatarOnce(scene, "Steve");

    // Remote players hookup
    createRemotePlayersManager(scene, room);

    // Send local transform periodically
    const sendRateMs = 50; // 20Hz
    setInterval(() => {
      const activeRoom = noaAny.colyseus.room;
      if (!activeRoom) return;

      const [x, y, z] = getLocalPlayerPositionFallback();
      const { yaw, pitch } = getCameraYawPitchFallback();

      activeRoom.send("move", { x, y, z, yaw, pitch });
    }, sendRateMs);
  } catch (err) {
    console.error("[Colyseus] connection failed:", err);
    console.error("[Colyseus] endpoint used:", COLYSEUS_ENDPOINT);
    console.error("[Colyseus] isSecurePage:", typeof window !== "undefined" && window.location ? window.location.protocol === "https:" : "(unknown)");

    // Keep single-player working
    try {
      const scene = noa.rendering.getScene();
      initLocalAvatarOnce(scene, "Steve");
    } catch (e) {
      console.error("[Avatar] init failed after Colyseus failure:", e);
    }
  }
}

connectColyseus().catch((e) => console.error("[Colyseus] connectColyseus() crash:", e));

/* ============================================================
 * Minimal interactivity + FP arm animations
 * ============================================================
 */

// Clear targeted block on left click
noa.inputs.down.on("fire", function () {
  if (fpArmsRef) fpArmsRef.startSwing("break");

  if (noa.targetedBlock) {
    const pos = noa.targetedBlock.position;
    noa.setBlock(0, pos[0], pos[1], pos[2]);
  }
});

// Place grass on right click
noa.inputs.down.on("alt-fire", function () {
  if (fpArmsRef) fpArmsRef.startSwing("place");

  if (noa.targetedBlock) {
    const pos = noa.targetedBlock.adjacent;
    noa.setBlock(grassID, pos[0], pos[1], pos[2]);
  }
});

// Bind "E" to alt-fire
noa.inputs.bind("alt-fire", "KeyE");

// Each tick: scroll zoom + update FP arms animation
noa.on("tick", function () {
  const scroll = noa.inputs.pointerState.scrolly;
  if (scroll !== 0) {
    noa.camera.zoomDistance += scroll > 0 ? 1 : -1;
    if (noa.camera.zoomDistance < 0) noa.camera.zoomDistance = 0;
    if (noa.camera.zoomDistance > 10) noa.camera.zoomDistance = 10;
  }

  if (fpArmsRef) {
    fpArmsRef.update(1 / 60);
  }
});
