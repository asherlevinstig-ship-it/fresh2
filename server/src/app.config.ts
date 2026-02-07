import {
    defineServer,
    defineRoom,
    monitor,
    playground,
    createRouter,
    createEndpoint,
} from "colyseus";
import cors from "cors"; // <--- 1. ADD THIS IMPORT

/**
 * Import your Room files
 */
import { MyRoom } from "./rooms/MyRoom.js";

const server = defineServer({

    rooms: {
        my_room: defineRoom(MyRoom),
    },

    routes: createRouter({
        api_hello: createEndpoint(
            "/api/hello",
            { method: "GET" },
            async (ctx) => {
                return { message: "Hello World" };
            }
        ),
    }),

    /**
     * Bind your custom Express routes here
     */
    express: (app) => {
        // <--- 2. ADD THIS LINE RIGHT HERE AT THE TOP
        app.use(cors({
            origin: true, // Allow all origins (Vercel, Localhost, etc.)
            credentials: true,
            methods: "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS"
        })); 

        /**
         * Basic test route
         */
        app.get("/hi", (req, res) => {
            res.send("It's time to kick ass and chew bubblegum!");
        });

        app.use("/monitor", monitor());

        if (process.env.NODE_ENV !== "production") {
            app.use("/", playground());
        }
    },

});

export default server;