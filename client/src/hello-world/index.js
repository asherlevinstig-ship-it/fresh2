/*
 * Fresh2 - noa hello-world - Babylon runtime probe + pinned mesh
 *
 * This file is designed to verify:
 * - You are running a SINGLE Babylon runtime (v6.x) across NOA + your code
 * - A diagnostic sphere renders in front of the camera
 *
 * IMPORTANT:
 * - Requires: @babylonjs/core@6.49.0
 * - Must NOT have: babylonjs (UMD) installed (that was v5.57.1 in your probe)
 */

import { Engine } from "noa-engine";
import { Client } from "@colyseus/sdk";

import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";

/* ============================================================
 * NOA init
 * ============================================================
 */

const noa = new Engine({
  debug: true,
  showFPS: true,
  chunkSize: 32,
  chunkAddDistance: 2.5,
  chunkRemoveDistance: 3.5,
});

/* ============================================================
 * World
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
        data.set(i, j, k, getVoxelID(x + i, y + j, z + k));
      }
    }
  }
  noa.world.setChunkData(id, data);
});

/* ============================================================
 * Helpers: NOA scene/camera access
 * ============================================================
 */

function getNoaSceneAny() {
  try {
    const r = /** @type {any} */ (noa).rendering;
    if (r && typeof r.getScene === "function") return r.getScene();
  } catch {}
  return null;
}

function getNoaCameraAny() {
  try {
    const r = /** @type {any} */ (noa).rendering;
    return r && r.camera ? r.camera : null;
  } catch {}
  return null;
}

/* ============================================================
 * Babylon identity probe
 * ============================================================
 */

function probeBabylonIdentityV6() {
  const scene = getNoaSceneAny();
  const cam = getNoaCameraAny();
  const engine = scene && typeof scene.getEngine === "function" ? scene.getEngine() : null;

  console.log("========================================");
  console.log("[Probe] START Babylon identity probe (core v6 expected)");
  console.log("[Probe] NOA scene exists?", !!scene);
  console.log("[Probe] NOA camera exists?", !!cam, "cameraType:", cam && cam.constructor ? cam.constructor.name : "(none)");
  console.log("[Probe] scene.constructor?.name =", scene && scene.constructor ? scene.constructor.name : "(none)");
  console.log("[Probe] engine.constructor?.name =", engine && engine.constructor ? engine.constructor.name : "(none)");

  // If babylonjs UMD is still installed, it may set a global BABYLON (often v5)
  const globalB = /** @type {any} */ (globalThis).BABYLON;
  console.log("[Probe] globalThis.BABYLON exists?", !!globalB);
  if (globalB && globalB.Engine) {
    console.log("[Probe] global BABYLON.Engine.Version =", globalB.Engine.Version);
  }

  // Create a probe mesh using @babylonjs/core (MeshBuilder import)
  if (scene) {
    try {
      const m = MeshBuilder.CreateBox("probeBox", { size: 1 }, scene);
      console.log("[Probe] created mesh via @babylonjs/core MeshBuilder:", m && m.name);
      console.log("[Probe] m.getScene() === scene =", m.getScene && m.getScene() === scene);
      m.dispose(false, true);
    } catch (e) {
      console.warn("[Probe] probe mesh creation failed:", e);
    }
  }

  console.log("[Probe] END Babylon identity probe");
  console.log("========================================");
}

/* ============================================================
 * Visual diagnostic sphere (pinned in front of camera)
 * ============================================================
 */

let diagBall = null;

function makeDiagBall(scene) {
  const ball = MeshBuilder.CreateSphere("diagBall", { diameter: 2.5 }, scene);

  const mat = new StandardMaterial("diagBallMat", scene);
  mat.emissiveColor = new Color3(0, 1, 1); // cyan glow
  mat.disableLighting = true;
  mat.alpha = 1;

  ball.material = mat;
  ball.isPickable = false;
  ball.alwaysSelectAsActiveMesh = true;
  ball.isVisible = true;
  ball.visibility = 1;
  ball.setEnabled(true);

  // keep rendering simple
  ball.renderingGroupId = 0;

  console.log("[Diag] ball created");
  return ball;
}

function stickInFrontOfCamera(cam, mesh, dist) {
  // Critical: avoid constructing our own Vector3 from a different runtime.
  // getForwardRay returns runtime-native direction vectors.
  try {
    const ray = cam.getForwardRay(dist);
    const p = ray.origin.add(ray.direction.scale(dist));
    mesh.position.copyFrom(p);
  } catch (e) {
    console.warn("[Diag] stickInFrontOfCamera failed:", e);
  }
}

/* ============================================================
 * Run probe once, pin sphere every frame
 * ============================================================
 */

let probed = false;

noa.on("beforeRender", function () {
  const scene = getNoaSceneAny();
  const cam = getNoaCameraAny();
  if (!scene || !cam) return;

  if (!probed) {
    probed = true;
    probeBabylonIdentityV6();

    // widen clip planes (avoid surprise clipping)
    try {
      if (scene.activeCamera) {
        scene.activeCamera.minZ = 0.01;
        scene.activeCamera.maxZ = 5000;
      }
    } catch {}
  }

  if (!diagBall) diagBall = makeDiagBall(scene);
  stickInFrontOfCamera(cam, diagBall, 6);
});

/* ============================================================
 * Colyseus (minimal)
 * ============================================================
 */

const DEFAULT_LOCAL_ENDPOINT = "ws://localhost:2567";
const COLYSEUS_ENDPOINT =
  import.meta.env && import.meta.env.VITE_COLYSEUS_ENDPOINT
    ? import.meta.env.VITE_COLYSEUS_ENDPOINT
    : DEFAULT_LOCAL_ENDPOINT;

const colyseusClient = new Client(COLYSEUS_ENDPOINT);

function toHttpEndpoint(wsEndpoint) {
  if (typeof wsEndpoint !== "string") return wsEndpoint;
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
    console.warn("[Colyseus][debug] GET /hi failed:", e);
  }
}

(async function connectColyseus() {
  console.log("[Colyseus] connecting to:", COLYSEUS_ENDPOINT);
  await debugMatchmake(COLYSEUS_ENDPOINT);

  try {
    const room = await colyseusClient.joinOrCreate("my_room", { name: "Steve" });
    console.log("[Colyseus] connected, session:", room.sessionId);

    room.onLeave(() => console.warn("[Colyseus] left"));
  } catch (e) {
    console.warn("[Colyseus] connect failed (ok for diagnostics):", e);
  }
})();
