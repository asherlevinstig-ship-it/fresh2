/* 
 *
 *          noa hello-world (full game entry)
 *
 *  Includes:
 *   - noa-engine setup
 *   - crosshair UI
 *   - Colyseus multiplayer client
 *   - biome-based terrain (fast-noise-lite)
 *   - caves
 *   - player mesh
 *   - block interaction
 *
 */

/* ===========================
 * Imports
 * ===========================
 */

import { Engine } from "noa-engine";
import { Client } from "@colyseus/sdk";
import FastNoiseLite from "fastnoise-lite";

import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";

/* ===========================
 * Engine options
 * ===========================
 */

var opts = {
    debug: true,
    showFPS: true,
    chunkSize: 32,
    chunkAddDistance: 2.5,
    chunkRemoveDistance: 3.5,
};

var noa = new Engine(opts);

/* ===========================
 * Crosshair UI
 * ===========================
 */

function createCrosshair(noaEngine) {
    const crosshair = document.createElement("div");
    crosshair.id = "noa-crosshair";

    Object.assign(crosshair.style, {
        position: "fixed",
        top: "50%",
        left: "50%",
        width: "14px",
        height: "14px",
        transform: "translate(-50%, -50%)",
        pointerEvents: "none",
        zIndex: "999999",
        display: "none",
    });

    const lineStyle = {
        position: "absolute",
        backgroundColor: "rgba(255,255,255,0.9)",
        boxShadow: "0 0 2px rgba(0,0,0,0.9)",
    };

    const h = document.createElement("div");
    Object.assign(h.style, lineStyle, {
        width: "100%",
        height: "2px",
        top: "6px",
    });

    const v = document.createElement("div");
    Object.assign(v.style, lineStyle, {
        width: "2px",
        height: "100%",
        left: "6px",
    });

    crosshair.appendChild(h);
    crosshair.appendChild(v);
    document.body.appendChild(crosshair);

    function update() {
        crosshair.style.display = document.pointerLockElement ? "block" : "none";
    }

    document.addEventListener("pointerlockchange", update);

    function bindCanvas() {
        const canvas =
            noaEngine?.container?.canvas || document.querySelector("canvas");

        if (!canvas) return;

        canvas.addEventListener("click", () => {
            if (!document.pointerLockElement && canvas.requestPointerLock) {
                canvas.requestPointerLock();
            }
        });

        update();
    }

    bindCanvas();
    setTimeout(bindCanvas, 300);
    setTimeout(bindCanvas, 1000);
}

createCrosshair(noa);

/* ===========================
 * Colyseus connection
 * ===========================
 */

const DEFAULT_ENDPOINT = "ws://localhost:2567";

let COLYSEUS_ENDPOINT =
    (import.meta.env && import.meta.env.VITE_COLYSEUS_ENDPOINT) ||
    DEFAULT_ENDPOINT;

if (typeof window !== "undefined") {
    if (window.location.protocol === "https:" && COLYSEUS_ENDPOINT.startsWith("ws://")) {
        COLYSEUS_ENDPOINT = COLYSEUS_ENDPOINT.replace("ws://", "wss://");
    }
}

console.log("[Fresh2] build stamp: SDK 0.17 path @colyseus/sdk", Date.now());

const colyseusClient = new Client(COLYSEUS_ENDPOINT);

noa.colyseus = {
    endpoint: COLYSEUS_ENDPOINT,
    client: colyseusClient,
    room: null,
};

async function connectColyseus() {
    console.log("[Colyseus] attempting connection...");
    console.log("[Colyseus] page protocol:", window.location.protocol);
    console.log("[Colyseus] endpoint:", COLYSEUS_ENDPOINT);
    console.log("[Colyseus] room name:", "my_room");

    try {
        const room = await colyseusClient.joinOrCreate("my_room");

        noa.colyseus.room = room;

        console.log("[Colyseus] connected OK");
        console.log("[Colyseus] roomId:", room.roomId);
        console.log("[Colyseus] sessionId:", room.sessionId);

        room.onMessage("*", (type, message) => {
            console.log("[Colyseus] message:", type, message);
        });

        room.onLeave((code) => {
            console.warn("[Colyseus] left room. code:", code);
            noa.colyseus.room = null;
        });
    } catch (err) {
        console.error("[Colyseus] connection failed:", err);
    }
}

connectColyseus();

/* ===========================
 * World seed + noise
 * ===========================
 */

const WORLD_SEED = 1337;

const heightNoise = new FastNoiseLite(WORLD_SEED);
heightNoise.SetNoiseType(FastNoiseLite.NoiseType.OpenSimplex2);
heightNoise.SetFrequency(0.005);

const tempNoise = new FastNoiseLite(WORLD_SEED + 1);
tempNoise.SetNoiseType(FastNoiseLite.NoiseType.OpenSimplex2);
tempNoise.SetFrequency(0.001);

const moistureNoise = new FastNoiseLite(WORLD_SEED + 2);
moistureNoise.SetNoiseType(FastNoiseLite.NoiseType.OpenSimplex2);
moistureNoise.SetFrequency(0.001);

const caveNoise = new FastNoiseLite(WORLD_SEED + 3);
caveNoise.SetNoiseType(FastNoiseLite.NoiseType.OpenSimplex2);
caveNoise.SetFrequency(0.03);

/* ===========================
 * Materials & blocks
 * ===========================
 */

noa.registry.registerMaterial("dirt", { color: [0.45, 0.36, 0.22] });
noa.registry.registerMaterial("grass", { color: [0.1, 0.8, 0.2] });
noa.registry.registerMaterial("sand", { color: [0.9, 0.85, 0.55] });
noa.registry.registerMaterial("snow", { color: [0.95, 0.95, 0.95] });

var dirtID = noa.registry.registerBlock(1, { material: "dirt" });
var grassID = noa.registry.registerBlock(2, { material: "grass" });
var sandID = noa.registry.registerBlock(3, { material: "sand" });
var snowID = noa.registry.registerBlock(4, { material: "snow" });

/* ===========================
 * Biomes
 * ===========================
 */

function getBiome(x, z) {
    const t = tempNoise.GetNoise(x, z);
    const m = moistureNoise.GetNoise(x, z);

    if (t > 0.4 && m < 0.0) return "desert";
    if (t < -0.3) return "snow";
    if (t > 0.2 && m > 0.2) return "mountains";
    return "plains";
}

/* ===========================
 * Terrain voxel logic
 * ===========================
 */

function getVoxelID(x, y, z) {
    const biome = getBiome(x, z);
    const base = heightNoise.GetNoise(x, z);

    let height = 0;

    if (biome === "desert") height = base * 4 + 5;
    if (biome === "plains") height = base * 8 + 8;
    if (biome === "mountains") height = base * 20 + 12;
    if (biome === "snow") height = base * 10 + 10;

    height = Math.floor(height);

    if (y < height - 2 && caveNoise.GetNoise(x, y, z) > 0.5) {
        return 0;
    }

    if (y === height) {
        if (biome === "desert") return sandID;
        if (biome === "snow") return snowID;
        return grassID;
    }

    if (y < height) {
        return dirtID;
    }

    return 0;
}

/* ===========================
 * Chunk generation
 * ===========================
 */

noa.world.on("worldDataNeeded", function (id, data, x, y, z) {
    for (var i = 0; i < data.shape[0]; i++) {
        for (var j = 0; j < data.shape[1]; j++) {
            for (var k = 0; k < data.shape[2]; k++) {
                data.set(i, j, k, getVoxelID(x + i, y + j, z + k));
            }
        }
    }

    noa.world.setChunkData(id, data);
});

/* ===========================
 * Player mesh
 * ===========================
 */

var player = noa.playerEntity;
var pd = noa.entities.getPositionData(player);
var w = pd.width;
var h = pd.height;

var scene = noa.rendering.getScene();
var mesh = CreateBox("player-mesh", {}, scene);

mesh.scaling.x = w;
mesh.scaling.z = w;
mesh.scaling.y = h;
mesh.material = noa.rendering.makeStandardMaterial();

noa.entities.addComponent(player, noa.entities.names.mesh, {
    mesh: mesh,
    offset: [0, h / 2, 0],
});

/* ===========================
 * Interaction
 * ===========================
 */

noa.inputs.down.on("fire", function () {
    if (noa.targetedBlock) {
        const p = noa.targetedBlock.position;
        noa.setBlock(0, p[0], p[1], p[2]);
    }
});

noa.inputs.down.on("alt-fire", function () {
    if (noa.targetedBlock) {
        const p = noa.targetedBlock.adjacent;
        noa.setBlock(grassID, p[0], p[1], p[2]);
    }
});

noa.inputs.bind("alt-fire", "KeyE");

noa.on("tick", function () {
    const scroll = noa.inputs.pointerState.scrolly;
    if (scroll !== 0) {
        noa.camera.zoomDistance += scroll > 0 ? 1 : -1;
        if (noa.camera.zoomDistance < 0) noa.camera.zoomDistance = 0;
        if (noa.camera.zoomDistance > 10) noa.camera.zoomDistance = 10;
    }
});
