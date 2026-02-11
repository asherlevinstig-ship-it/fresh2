import {
  defineServer,
  defineRoom,
  monitor,
  playground,
  createRouter,
  createEndpoint,
} from "colyseus";
import cors from "cors";
import { MyRoom } from "./rooms/MyRoom.js";

export default defineServer({
  rooms: {
    my_room: defineRoom(MyRoom),
  },

  routes: createRouter({
    api_hello: createEndpoint("/api/hello", { method: "GET" }, async () => {
      return { message: "Hello World" };
    }),
  }),

  express: (app) => {
    app.use(cors({
      origin: true,
      credentials: true,
      methods: "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS",
    }));

    app.get("/hi", (req, res) => res.send("ok"));

    app.use("/monitor", monitor());
    if (process.env.NODE_ENV !== "production") app.use("/", playground());
  },
});
