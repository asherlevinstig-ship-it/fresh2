import {
    defineServer,
    defineRoom,
    monitor,
    playground,
    createRouter,
    createEndpoint,
} from "colyseus";

/**
 * Import your Room files
 */
import { MyRoom } from "./rooms/MyRoom.js";

/**
 * Create and configure the Colyseus server
 */
const server = defineServer({

    /**
     * Define your room handlers
     * Clients will connect using:
     *   client.joinOrCreate("my_room")
     */
    rooms: {
        my_room: defineRoom(MyRoom),
    },

    /**
     * Experimental:
     * Define API routes with built-in integration
     * for the Playground and SDK HTTP client.
     *
     * Usage from SDK:
     *   client.http.get("/api/hello").then((response) => {})
     */
    routes: createRouter({
        api_hello: createEndpoint(
            "/api/hello",
            {
                method: "GET",
            },
            async (ctx) => {
                return {
                    message: "Hello World",
                };
            }
        ),
    }),

    /**
     * Bind your custom Express routes here
     * Read more:
     * https://expressjs.com/en/starter/basic-routing.html
     */
    express: (app) => {

        /**
         * Basic test route
         */
        app.get("/hi", (req, res) => {
            res.send("It's time to kick ass and chew bubblegum!");
        });

        /**
         * Colyseus Monitor
         * Recommended to protect with authentication in production
         *
         * Read more:
         * https://docs.colyseus.io/tools/monitoring/#restrict-access-to-the-panel-using-a-password
         */
        app.use("/monitor", monitor());

        /**
         * Colyseus Playground
         * DO NOT expose this in production environments
         */
        if (process.env.NODE_ENV !== "production") {
            app.use("/", playground());
        }
    },

});

/**
 * Export the configured server
 */
export default server;
