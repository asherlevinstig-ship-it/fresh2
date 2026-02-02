/*
 *
 *          Fresh2 - noa hello-world (main game entry)
 *
 *  Based on noa's "hello-world" example, extended with:
 *   - Minecraft-style crosshair overlay
 *   - Colyseus multiplayer client connection (@colyseus/sdk)
 *   - Minecraft-style blocky avatar built from boxes with live skins (Crafatar)
 *
 *  Notes:
 *   - No bundled skin assets are required (skins are loaded from a URL).
 *   - Avatar is attached to the noa player entity via noa entities mesh component.
 *
 *  IMPORTANT FIX:
 *   - Crafatar "skins/<id>" expects a Mojang UUID (no dashes), not a username.
 *     This file resolves username -> UUID via Mojang API and then loads the skin.
 *
 */

/* ============================================================
 * Imports
 * ============================================================
 */

import { Engine } from "noa-engine";
import { Client } from "@colyseus/sdk";

import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
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

// A single "any" view of noa, so JS-check/TS doesn't complain when noa's typings are incomplete.
const noaAny = /** @type {any} */ (noa);

/* ============================================================
 * UI: Minecraft-style Crosshair
 * - Always exists as a DOM overlay.
 * - Shows automatically when pointer lock is active on the canvas.
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

  function getNoaCanvas() {
    if (noaEngine && noaEngine.container && noaEngine.container.canvas) {
      return noaEngine.container.canvas;
    }
    const c = document.querySelector("canvas");
    return c || null;
  }

  function updateVisibility() {
    const canvas = getNoaCanvas();
    const locked = canvas && document.pointerLockElement === canvas;
    crosshair.style.display = locked ? "flex" : "none";
  }

  document.addEventListener("pointerlockchange", updateVisibility);

  // Poll briefly until the canvas exists, then stop.
  const interval = setInterval(() => {
    updateVisibility();
    const canvas = getNoaCanvas();
    if (canvas) {
      clearInterval(interval);
    }
  }, 250);

  return {
    element: crosshair,
    show: () => {
      crosshair.style.display = "flex";
    },
    hide: () => {
      crosshair.style.display = "none";
    },
    refresh: updateVisibility,
  };
}

const crosshairUI = createCrosshairOverlay(noa);

/* ============================================================
 * Colyseus Multiplayer Hook
 * - Uses @colyseus/sdk
 * - Endpoint comes from VITE_COLYSEUS_ENDPOINT, fallback localhost
 * - Includes debugMatchmake preflight (HTTP endpoints)
 * ============================================================
 */

const DEFAULT_LOCAL_ENDPOINT = "ws://localhost:2567";

let COLYSEUS_ENDPOINT =
  import.meta.env && import.meta.env.VITE_COLYSEUS_ENDPOINT
    ? import.meta.env.VITE_COLYSEUS_ENDPOINT
    : DEFAULT_LOCAL_ENDPOINT;

// If page is HTTPS, ensure we use WSS for websocket URLs.
if (
  typeof window !== "undefined" &&
  window.location &&
  window.location.protocol === "https:"
) {
  if (COLYSEUS_ENDPOINT.startsWith("ws://")) {
    COLYSEUS_ENDPOINT = COLYSEUS_ENDPOINT.replace("ws://", "wss://");
  }
}

/**
 * Convert ws:// -> http:// and wss:// -> https:// for fetch() debugging.
 */
function toHttpEndpoint(wsEndpoint) {
  if (wsEndpoint.startsWith("wss://"))
    return wsEndpoint.replace("wss://", "https://");
  if (wsEndpoint.startsWith("ws://"))
    return wsEndpoint.replace("ws://", "http://");
  return wsEndpoint;
}

/**
 * Debug: check basic routes + matchmake response shape.
 */
async function debugMatchmake(endpointWs) {
  const http = toHttpEndpoint(endpointWs);

  console.log("[Colyseus][debug] ws endpoint:", endpointWs);
  console.log("[Colyseus][debug] http endpoint:", http);

  // 1) Test /hi
  try {
    const r1 = await fetch(`${http}/hi`, { method: "GET" });
    const t1 = await r1.text();
    console.log("[Colyseus][debug] GET /hi status:", r1.status);
    console.log("[Colyseus][debug] GET /hi body:", t1.slice(0, 200));
  } catch (e) {
    console.error("[Colyseus][debug] GET /hi failed:", e);
  }

  // 2) Test matchmake joinOrCreate
  try {
    const r2 = await fetch(`${http}/matchmake/joinOrCreate/my_room`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    const t2 = await r2.text();
    console.log(
      "[Colyseus][debug] POST /matchmake/joinOrCreate/my_room status:",
      r2.status
    );
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

// Store references on noa for convenience.
noaAny.colyseus = {
  endpoint: COLYSEUS_ENDPOINT,
  client: colyseusClient,
  room: null,
};

async function connectColyseus() {
  console.log("[Colyseus] attempting connection...");
  console.log(
    "[Colyseus] page protocol:",
    typeof window !== "undefined" && window.location
      ? window.location.protocol
      : "(unknown)"
  );
  console.log("[Colyseus] endpoint:", COLYSEUS_ENDPOINT);
  console.log("[Colyseus] room name:", "my_room");

  await debugMatchmake(COLYSEUS_ENDPOINT);

  try {
    const room = await colyseusClient.joinOrCreate("my_room");
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
  } catch (err) {
    console.error("[Colyseus] connection failed:", err);
    console.error("[Colyseus] endpoint used:", COLYSEUS_ENDPOINT);
    console.error(
      "[Colyseus] isSecurePage:",
      typeof window !== "undefined" && window.location
        ? window.location.protocol === "https:"
        : "(unknown)"
    );
  }
}

// Keep same behavior: connect immediately (non-blocking).
connectColyseus().catch((e) =>
  console.error("[Colyseus] connectColyseus() crash:", e)
);

/* ============================================================
 * Minecraft skin helpers (username -> UUID -> Crafatar skin URL)
 * ============================================================
 */

async function usernameToMojangUuid(username) {
  // Mojang returns "id" as UUID without dashes.
  const url = `https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(
    username
  )}`;
  const r = await fetch(url);
  if (!r.ok) {
    throw new Error(`Mojang username lookup failed (${r.status})`);
  }
  const j = await r.json();
  if (!j || !j.id) throw new Error("Mojang username lookup returned no id");
  return j.id;
}

async function resolveSkinUrl(username) {
  // Prefer UUID-based crafatar endpoint; fall back to username endpoint if lookup fails.
  try {
    const uuid = await usernameToMojangUuid(username);
    return `https://crafatar.com/skins/${uuid}`;
  } catch (e) {
    console.warn(
      "[Skin] Failed to resolve UUID via Mojang; falling back to username URL:",
      e
    );
    return `https://crafatar.com/skins/${encodeURIComponent(username)}`;
  }
}

/* ============================================================
 * Minecraft-style Avatar (boxes + live skin URL)
 * - Uses classic 64x64 Minecraft skin UV layout
 * ============================================================
 */

function uvRect(px, py, pw, ph) {
  const texW = 64;
  const texH = 64;

  const u0 = px / texW;
  const v0 = py / texH;
  const u1 = (px + pw) / texW;
  const v1 = (py + ph) / texH;

  return new Vector4(u0, v0, u1, v1);
}

// Babylon box face order: [0]=front, [1]=back, [2]=right, [3]=left, [4]=top, [5]=bottom
function makeFaceUV(front, back, right, left, top, bottom) {
  return [front, back, right, left, top, bottom];
}

function createPlayerAvatar(scene, skinUrl) {
  const root = new TransformNode("mc-avatar-root", scene);

  const skinTexture = new Texture(
    skinUrl,
    scene,
    false,
    false,
    Texture.NEAREST_NEAREST
  );
  skinTexture.hasAlpha = true;
  skinTexture.wrapU = Texture.CLAMP_ADDRESSMODE;
  skinTexture.wrapV = Texture.CLAMP_ADDRESSMODE;

  const mat = new StandardMaterial("mc-skin-mat", scene);
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

  // HEAD (8x8x8)
  const headUV = makeFaceUV(
    uvRect(8, 8, 8, 8),
    uvRect(24, 8, 8, 8),
    uvRect(16, 8, 8, 8),
    uvRect(0, 8, 8, 8),
    uvRect(8, 0, 8, 8),
    uvRect(16, 0, 8, 8)
  );

  // BODY (8x12x4)
  const bodyUV = makeFaceUV(
    uvRect(20, 20, 8, 12),
    uvRect(32, 20, 8, 12),
    uvRect(28, 20, 4, 12),
    uvRect(16, 20, 4, 12),
    uvRect(20, 16, 8, 4),
    uvRect(28, 16, 8, 4)
  );

  // RIGHT ARM (4x12x4)
  const rightArmUV = makeFaceUV(
    uvRect(44, 20, 4, 12),
    uvRect(52, 20, 4, 12),
    uvRect(48, 20, 4, 12),
    uvRect(40, 20, 4, 12),
    uvRect(44, 16, 4, 4),
    uvRect(48, 16, 4, 4)
  );

  // LEFT ARM (classic reuse)
  const leftArmUV = rightArmUV;

  // RIGHT LEG (4x12x4)
  const rightLegUV = makeFaceUV(
    uvRect(4, 20, 4, 12),
    uvRect(12, 20, 4, 12),
    uvRect(8, 20, 4, 12),
    uvRect(0, 20, 4, 12),
    uvRect(4, 16, 4, 4),
    uvRect(8, 16, 4, 4)
  );

  // LEFT LEG (classic reuse)
  const leftLegUV = rightLegUV;

  // Sizes
  const headSize = { width: 1.0, height: 1.0, depth: 1.0 };
  const bodySize = { width: 1.0, height: 1.5, depth: 0.5 };
  const limbSize = { width: 0.5, height: 1.5, depth: 0.5 };

  // Total avatar height (feet -> head top)
  const AVATAR_TOTAL_HEIGHT = limbSize.height + bodySize.height + headSize.height;

  const head = MeshBuilder.CreateBox(
    "mc-head",
    {
      width: headSize.width,
      height: headSize.height,
      depth: headSize.depth,
      faceUV: headUV,
    },
    scene
  );
  head.material = mat;
  head.parent = root;

  const body = MeshBuilder.CreateBox(
    "mc-body",
    {
      width: bodySize.width,
      height: bodySize.height,
      depth: bodySize.depth,
      faceUV: bodyUV,
    },
    scene
  );
  body.material = mat;
  body.parent = root;

  const rightArm = MeshBuilder.CreateBox(
    "mc-rightArm",
    {
      width: limbSize.width,
      height: limbSize.height,
      depth: limbSize.depth,
      faceUV: rightArmUV,
    },
    scene
  );
  rightArm.material = mat;
  rightArm.parent = root;

  const leftArm = MeshBuilder.CreateBox(
    "mc-leftArm",
    {
      width: limbSize.width,
      height: limbSize.height,
      depth: limbSize.depth,
      faceUV: leftArmUV,
    },
    scene
  );
  leftArm.material = mat;
  leftArm.parent = root;

  const rightLeg = MeshBuilder.CreateBox(
    "mc-rightLeg",
    {
      width: limbSize.width,
      height: limbSize.height,
      depth: limbSize.depth,
      faceUV: rightLegUV,
    },
    scene
  );
  rightLeg.material = mat;
  rightLeg.parent = root;

  const leftLeg = MeshBuilder.CreateBox(
    "mc-leftLeg",
    {
      width: limbSize.width,
      height: limbSize.height,
      depth: limbSize.depth,
      faceUV: leftLegUV,
    },
    scene
  );
  leftLeg.material = mat;
  leftLeg.parent = root;

  // Position parts (root at feet center)
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
    metrics: {
      totalHeight: AVATAR_TOTAL_HEIGHT,
    },
  };
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
 * Player avatar mesh: attach Minecraft-style avatar to player entity
 * ============================================================
 */

function getNoaCanvas() {
  if (noa && noa.container && noa.container.canvas) return noa.container.canvas;
  const c = document.querySelector("canvas");
  return c || null;
}

(async function initPlayerAvatar() {
  const scene = noa.rendering.getScene();

  const username = "Steve";
  const skinUrl = await resolveSkinUrl(username);
  console.log("[Skin] Using skin URL:", skinUrl);

  const avatar = createPlayerAvatar(scene, skinUrl);

  const playerEntity = noa.playerEntity;

  // noa types are incomplete under checkJs; cast once to satisfy VS Code.
  const entities = /** @type {any} */ (noa.entities);

  // ---- FIX for TS2339:
  // We avoid reading noa.playerHeight directly from typed Engine.
  // Instead:
  // 1) probe it from noaAny (untyped), and
  // 2) fall back to a deterministic value if missing.
  const probedPlayerHeight =
    typeof noaAny.playerHeight === "number" ? noaAny.playerHeight : null;

  // If noa doesn't expose playerHeight, use an approximate capsule height:
  // avatar total height is ~4.0 units with our chosen dimensions.
  // Many noa setups are ~1.8-2.0 "meters". We'll use 1.8 as a safe fallback.
  const playerHeight = probedPlayerHeight || 1.8;

  // Avatar root is at feet center.
  // If noa entity position is capsule center, offset should be ~playerHeight/2.
  // This is the common case.
  const meshOffsetY = playerHeight * 0.5;

  entities.addComponent(playerEntity, noa.entities.names.mesh, {
    mesh: avatar.root,
    offset: [0, meshOffsetY, 0],
  });

  // Make sure we can see our own avatar (third-person-ish).
  noa.camera.zoomDistance = 6;

  // Hide avatar in pointer lock (first-person), show otherwise.
  document.addEventListener("pointerlockchange", () => {
    const canvas = getNoaCanvas();
    const locked = canvas && document.pointerLockElement === canvas;
    avatar.root.setEnabled(!locked);
    crosshairUI.refresh();
  });
})().catch((e) => console.error("[Avatar] init failed:", e));

/* ============================================================
 * Minimal interactivity
 * ============================================================
 */

// Clear targeted block on left click
noa.inputs.down.on("fire", function () {
  if (noa.targetedBlock) {
    const pos = noa.targetedBlock.position;
    noa.setBlock(0, pos[0], pos[1], pos[2]);
  }
});

// Place grass on right click
noa.inputs.down.on("alt-fire", function () {
  if (noa.targetedBlock) {
    const pos = noa.targetedBlock.adjacent;
    noa.setBlock(grassID, pos[0], pos[1], pos[2]);
  }
});

// Bind "E" to alt-fire
noa.inputs.bind("alt-fire", "KeyE");

// Each tick: scroll zoom
noa.on("tick", function () {
  const scroll = noa.inputs.pointerState.scrolly;
  if (scroll !== 0) {
    noa.camera.zoomDistance += scroll > 0 ? 1 : -1;
    if (noa.camera.zoomDistance < 0) noa.camera.zoomDistance = 0;
    if (noa.camera.zoomDistance > 10) noa.camera.zoomDistance = 10;
  }
});
