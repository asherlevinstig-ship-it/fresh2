/* 
 * 
 *          noa hello-world example
 * 
 *  This is a bare-minimum example world, intended to be a 
 *  starting point for hacking on noa game world content.
 * 
*/


// Engine options object, and engine instantiation.
import { Engine } from 'noa-engine'

// Colyseus browser client SDK (multiplayer)
import { Client } from '@colyseus/sdk'

// Babylon box builder (used to create the player's mesh)
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder'



/*
 *
 *      Engine options
 *
 *  Options are passed into the engine at construction time.
 *  (See `test` example, or noa docs/source, for more options.)
 *
*/

var opts = {
    debug: true,
    showFPS: true,
    chunkSize: 32,
    chunkAddDistance: 2.5,
    chunkRemoveDistance: 3.5,
}

var noa = new Engine(opts)



/*
 *
 *      UI: Minecraft-style Crosshair
 *
 *  Inserted here to overlay on top of the canvas.
 *
*/

function createCrosshair(noaEngine) {
    // Create the main container div
    const crosshair = document.createElement('div')
    crosshair.id = 'noa-crosshair'

    // Apply CSS to center it and make it transparent to clicks
    Object.assign(crosshair.style, {
        position: 'absolute',
        top: '50%',
        left: '50%',
        width: '14px',
        height: '14px',
        transform: 'translate(-50%, -50%)',
        pointerEvents: 'none',
        zIndex: '1000',
        display: 'none',
        alignItems: 'center',
        justifyContent: 'center',
    })

    // Shared style for the crosshair lines
    const lineStyle = {
        position: 'absolute',
        backgroundColor: 'rgba(255, 255, 255, 0.8)',
        boxShadow: '0px 0px 2px rgba(0, 0, 0, 0.8)',
    }

    // Horizontal line
    const hLine = document.createElement('div')
    Object.assign(hLine.style, lineStyle, {
        width: '100%',
        height: '2px',
        top: '6px',
    })

    // Vertical line
    const vLine = document.createElement('div')
    Object.assign(vLine.style, lineStyle, {
        width: '2px',
        height: '100%',
        left: '6px',
    })

    crosshair.appendChild(hLine)
    crosshair.appendChild(vLine)
    document.body.appendChild(crosshair)

    // Toggle visibility based on Pointer Lock status
    if (noaEngine && noaEngine.container) {
        const canvas = noaEngine.container.canvas
        document.addEventListener('pointerlockchange', () => {
            if (document.pointerLockElement === canvas) {
                crosshair.style.display = 'block'
            } else {
                crosshair.style.display = 'none'
            }
        })
    }
}

// Initialize the crosshair
createCrosshair(noa)



/*
 *
 *      Colyseus Multiplayer Hook
 *
 *  This connects the client (browser) to a Colyseus server.
 *
 *  IMPORTANT NOTE ABOUT ENDPOINTS:
 *  With @colyseus/sdk you should pass the HTTP(S) endpoint (not ws://).
 *  The SDK will negotiate ws/wss internally.
 *
 *  - In local dev, it falls back to http://localhost:2567
 *  - On Vercel, set VITE_COLYSEUS_ENDPOINT to:
 *      https://us-mia-ea26ba04.colyseus.cloud
 *
 *  IMPORTANT:
 *  The room name used here is "my_room". Your server must expose a room
 *  with this identifier in app.config.ts (rooms: { my_room: ... }).
 *
*/

// Default local endpoint (HTTP, not WS)
const DEFAULT_LOCAL_ENDPOINT = 'http://localhost:2567'

// Prefer env var if present, else fall back to local
let COLYSEUS_ENDPOINT =
    import.meta.env.VITE_COLYSEUS_ENDPOINT ?? DEFAULT_LOCAL_ENDPOINT

// If the page is HTTPS but endpoint is http://, upgrade to https:// automatically
if (typeof window !== 'undefined') {
    if (window.location && window.location.protocol === 'https:' && COLYSEUS_ENDPOINT.startsWith('http://')) {
        COLYSEUS_ENDPOINT = COLYSEUS_ENDPOINT.replace('http://', 'https://')
    }
}

// Create client
const colyseusClient = new Client(COLYSEUS_ENDPOINT)

// Store connection references on the noa instance so other parts of the game can use them later
noa.colyseus = {
    endpoint: COLYSEUS_ENDPOINT,
    client: colyseusClient,
    room: null,
}

async function connectColyseus() {
    console.log('[Colyseus] attempting connection...')
    console.log('[Colyseus] page protocol:', (typeof window !== 'undefined' && window.location) ? window.location.protocol : '(unknown)')
    console.log('[Colyseus] endpoint:', COLYSEUS_ENDPOINT)
    console.log('[Colyseus] room name:', 'my_room')

    try {
        // Join an existing room or create one if none exist
        const room = await colyseusClient.joinOrCreate('my_room')

        // Keep reference
        noa.colyseus.room = room

        console.log('[Colyseus] connected OK')
        console.log('[Colyseus] roomId:', room.id)
        console.log('[Colyseus] sessionId:', room.sessionId)

        // Listen for any messages (wildcard)
        room.onMessage('*', (type, message) => {
            console.log('[Colyseus] message:', type, message)
        })

        // Detect leave / disconnect
        room.onLeave((code) => {
            console.warn('[Colyseus] left room. code:', code)
            noa.colyseus.room = null
        })

        // OPTIONAL: send a simple "hello" ping (only if your server expects it)
        // room.send('hello', { time: Date.now() })

    } catch (err) {
        console.error('[Colyseus] connection failed:', err)
        console.error('[Colyseus] endpoint used:', COLYSEUS_ENDPOINT)
        console.error('[Colyseus] isSecurePage:', (typeof window !== 'undefined' && window.location) ? window.location.protocol === 'https:' : '(unknown)')
    }
}

// Kick off connection immediately
connectColyseus()



/*
 *
 *      Registering voxel types
 * 
 *  Two step process. First you register a material, specifying the 
 *  color/texture/etc. of a given block face, then you register a 
 *  block, which specifies the materials for a given block type.
 * 
*/

// block materials (just colors for this demo)
var brownish = [0.45, 0.36, 0.22]
var greenish = [0.1, 0.8, 0.2]
noa.registry.registerMaterial('dirt', { color: brownish })
noa.registry.registerMaterial('grass', { color: greenish })

// block types and their material names
var dirtID = noa.registry.registerBlock(1, { material: 'dirt' })
var grassID = noa.registry.registerBlock(2, { material: 'grass' })



/*
 * 
 *      World generation
 * 
 *  The world is divided into chunks, and `noa` will emit an 
 *  `worldDataNeeded` event for each chunk of data it needs.
 *  The game client should catch this, and call 
 *  `noa.world.setChunkData` whenever the world data is ready.
 *  (The latter can be done asynchronously.)
 * 
*/

// simple height map worldgen function
function getVoxelID(x, y, z) {
    if (y < -3) return dirtID
    var height = 2 * Math.sin(x / 10) + 3 * Math.cos(z / 20)
    if (y < height) return grassID
    return 0 // signifying empty space
}

// register for world events
noa.world.on('worldDataNeeded', function (id, data, x, y, z) {
    // `id` - a unique string id for the chunk
    // `data` - an `ndarray` of voxel ID data (see: https://github.com/scijs/ndarray)
    // `x, y, z` - world coords of the corner of the chunk

    for (var i = 0; i < data.shape[0]; i++) {
        for (var j = 0; j < data.shape[1]; j++) {
            for (var k = 0; k < data.shape[2]; k++) {
                var voxelID = getVoxelID(x + i, y + j, z + k)
                data.set(i, j, k, voxelID)
            }
        }
    }

    // tell noa the chunk's terrain data is now set
    noa.world.setChunkData(id, data)
})



/*
 * 
 *      Create a mesh to represent the player:
 * 
*/

// get the player entity's ID and other info (position, size, ..)
var player = noa.playerEntity
var dat = noa.entities.getPositionData(player)
var w = dat.width
var h = dat.height

// add a mesh to represent the player, and scale it, etc.
var scene = noa.rendering.getScene()
var mesh = CreateBox('player-mesh', {}, scene)
mesh.scaling.x = w
mesh.scaling.z = w
mesh.scaling.y = h

// this adds a default flat material, without specularity
mesh.material = noa.rendering.makeStandardMaterial()

// add "mesh" component to the player entity
// this causes the mesh to move around in sync with the player entity
noa.entities.addComponent(player, noa.entities.names.mesh, {
    mesh: mesh,

    // offset vector is needed because noa positions are always the 
    // bottom-center of the entity, and Babylon's CreateBox gives a 
    // mesh registered at the center of the box
    offset: [0, h / 2, 0],
})



/*
 * 
 *      Minimal interactivity 
 * 
*/

// clear targeted block on left click
noa.inputs.down.on('fire', function () {
    if (noa.targetedBlock) {
        var pos = noa.targetedBlock.position
        noa.setBlock(0, pos[0], pos[1], pos[2])
    }
})

// place some grass on right click
noa.inputs.down.on('alt-fire', function () {
    if (noa.targetedBlock) {
        var pos = noa.targetedBlock.adjacent
        noa.setBlock(grassID, pos[0], pos[1], pos[2])
    }
})

// add a key binding for "E" to do the same as alt-fire
noa.inputs.bind('alt-fire', 'KeyE')

// each tick, consume any scroll events and use them to zoom camera
noa.on('tick', function (dt) {
    var scroll = noa.inputs.pointerState.scrolly
    if (scroll !== 0) {
        noa.camera.zoomDistance += (scroll > 0) ? 1 : -1
        if (noa.camera.zoomDistance < 0) noa.camera.zoomDistance = 0
        if (noa.camera.zoomDistance > 10) noa.camera.zoomDistance = 10
    }
})
