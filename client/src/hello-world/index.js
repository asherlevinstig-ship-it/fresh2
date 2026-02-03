/*
 * Fresh2 - noa hello-world (main game entry) - DIAGNOSTIC BASELINE
 *
 * Purpose:
 * - Run Babylon identity probe to detect duplicate Babylon runtimes.
 * - Create a pinned emissive sphere always in front of the NOA camera.
 * - Keep NOA voxel world generation.
 * - Keep Colyseus connect (optional).
 *
 * If the sphere doesn't appear AND the probe shows mismatched Babylon instances,
 * you must dedupe Babylon in Vite (resolve.dedupe) and remove @babylonjs/* packages.
 */

import { Engine } from "noa-engine";
import { Client } from "@colyseus/sdk";
import * as BABYLON from "babylonjs";

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
 * Simple world
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
 * Helpers: access NOA scene + camera safely in JS
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
    // In noa-engine v0.33.0, rendering.camera exists
    if (r && r.camera) return r.camera;
  } catch {}
  return null;
}

/* ============================================================
 * Babylon identity probe (detect duplicate runtimes)
 * ============================================================
 */

function probeBabylonIdentity() {
  const scene = getNoaSceneAny();
  const cam = getNoaCameraAny();
  const engine = scene && typeof scene.getEngine === "function" ? scene.getEngine() : null;

  console.log("========================================");
  console.log("[Probe] START Babylon identity probe");
  console.log("[Probe] imported BABYLON.Engine.Version =", BABYLON && BABYLON.Engine ? BABYLON.Engine.Version : "(missing)");

  console.log("[Probe] NOA scene exists?", !!scene);
  console.log("[Probe] NOA camera exists?", !!cam, "cameraType:", cam && cam.constructor ? cam.constructor.name : "(none)");
  console.log("[Probe] scene.constructor?.name =", scene && scene.constructor ? scene.constructor.name : "(none)");
  console.log("[Probe] engine.constructor?.name =", engine && engine.constructor ? engine.constructor.name : "(none)");

  // Try to detect global BABYLON (sometimes present depending on build)
  const globalB = /** @type {any} */ (globalThis).BABYLON;
  console.log("[Probe] globalThis.BABYLON exists?", !!globalB);
  if (globalB && globalB.Engine) {
    console.log("[Probe] global BABYLON.Engine.Version =", globalB.Engine.Version);
    console.log("[Probe] imported BABYLON === global BABYLON ?", globalB === BABYLON);
  }

  // Create a mesh using imported BABYLON, on NOA's scene
  if (scene) {
    try {
      const m = BABYLON.MeshBuilder.CreateBox("probeBox", { size: 1 }, scene);
      console.log("[Probe] created mesh via imported BABYLON:", m && m.name);

      // instanceof checks are strong evidence of single vs duplicate Babylon
      const okImported = m instanceof BABYLON.AbstractMesh;
      console.log("[Probe] m instanceof imported BABYLON.AbstractMesh =", okImported);

      if (globalB && globalB.AbstractMesh) {
        const okGlobal = m instanceof globalB.AbstractMesh;
        console.log("[Probe] m instanceof global BABYLON.AbstractMesh =", okGlobal);
      }

      // scene ownership check
      console.log("[Probe] m.getScene() === scene =", m.getScene && m.getScene() === scene);

      // clean up probe mesh quickly
      m.dispose(false, true);
    } catch (e) {
      console.warn("[Probe] mesh creation failed:", e);
    }
  }

  console.log("[Probe] END Babylon identity probe");
  console.log("========================================");
}

/* ============================================================
 * Visual diagnostic mesh (always in front of camera)
 * ============================================================
 */

let diagBall = null;

function makeDiagBall(scene) {
  const ball = BABYLON.MeshBuilder.CreateSphere("diagBall", { diameter: 2.5 }, scene);

  const mat = new BABYLON.StandardMaterial("diagBallMat", scene);
  mat.emissiveColor = new BABYLON.Color3(0, 1, 1); // bright cyan
  mat.disableLighting = true;
  mat.alpha = 1;

  ball.material = mat;
  ball.isPickable = false;
  ball.alwaysSelectAsActiveMesh = true;
  ball.isVisible = true;
  ball.visibility = 1;
  ball.setEnabled(true);

  // ensure it renders with the camera layer mask (belt-and-braces)
  try {
    ball.layerMask = 0x0fffffff;
    if (scene.activeCamera) scene.activeCamera.layerMask = 0x0fffffff;
  } catch {}

  console.log("[Diag] ball created");
  return ball;
}

function stickInFrontOfCamera(scene, cam, mesh, dist) {
  try {
    // Forward direction (Babylon cameras face +Z in local space)
    const forward = cam.getDirection(new BABYLON.Vector3(0, 0, 1));
    mesh.position.copyFrom(cam.position.add(forward.scale(dist)));
  } catch (e) {
    console.warn("[Diag] stickInFrontOfCamera failed:", e);
  }
}

/* ============================================================
 * Run probe once scene exists, then maintain diagnostic ball
 * ============================================================
 */

let probed = false;

noa.on("beforeRender", function () {
  const scene = getNoaSceneAny();
  const cam = getNoaCameraAny();
  if (!scene || !cam) return;

  // Run identity probe once (first frame where scene+cam exist)
  if (!probed) {
    probed = true;
    probeBabylonIdentity();

    // Make camera clip planes generous (prevents clipping surprises)
    try {
      if (scene.activeCamera) {
        scene.activeCamera.minZ = 0.01;
        scene.activeCamera.maxZ = 5000;
      }
    } catch {}
  }

  // Create + pin the diagnostic sphere every frame
  if (!diagBall) diagBall = makeDiagBall(scene);
  stickInFrontOfCamera(scene, cam, diagBall, 6);
});

/* ============================================================
 * Colyseus (keep minimal, no message spam)
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

    // Avoid the "welcome not registered" warning by not subscribing to "*"
    // You can register specific messages when you actually use them:
    // room.onMessage("someType", (msg) => { ... });

    room.onLeave(() => console.warn("[Colyseus] left"));
  } catch (e) {
    console.warn("[Colyseus] connect failed (ok for diagnostics):", e);
  }
})();
