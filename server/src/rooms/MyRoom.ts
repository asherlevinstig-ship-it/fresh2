import { Room, Client, CloseCode } from "colyseus";
import { MyRoomState, PlayerState } from "./schema/MyRoomState.js";

type JoinOptions = { name?: string };

type MoveMsg = {
  x: number;
  y: number;
  z: number;
  yaw?: number;
  pitch?: number;
};

export class MyRoom extends Room {
  public maxClients = 16;

  // Optional: keep a typed view of state for TS convenience
  public state!: MyRoomState;

  public onCreate(options: any) {
    this.setState(new MyRoomState());

    console.log("room", this.roomId, "created with options:", options);

    this.onMessage("move", (client: Client, msg: MoveMsg) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;

      if (
        !Number.isFinite(msg.x) ||
        !Number.isFinite(msg.y) ||
        !Number.isFinite(msg.z)
      ) {
        return;
      }

      p.x = msg.x;
      p.y = msg.y;
      p.z = msg.z;

      if (typeof msg.yaw === "number" && Number.isFinite(msg.yaw)) p.yaw = msg.yaw;
      if (typeof msg.pitch === "number" && Number.isFinite(msg.pitch)) p.pitch = msg.pitch;
    });

    this.onMessage("hello", (client: Client, message: any) => {
      console.log(client.sessionId, "said hello:", message);
      client.send("hello_ack", { ok: true, serverTime: Date.now() });
    });
  }

  public onJoin(client: Client, options: JoinOptions) {
    console.log(client.sessionId, "joined!", "options:", options);

    const p = new PlayerState();
    p.id = client.sessionId;

    if (options && typeof options.name === "string" && options.name.trim()) {
      p.name = options.name.trim();
    } else {
      p.name = "Steve";
    }

    // Spawn
    p.x = 0;
    p.y = 10;
    p.z = 0;
    p.yaw = 0;
    p.pitch = 0;

    this.state.players.set(client.sessionId, p);

    client.send("welcome", {
      roomId: this.roomId,
      sessionId: client.sessionId,
    });
  }

  public onLeave(client: Client, code: CloseCode) {
    console.log(client.sessionId, "left!", code);
    this.state.players.delete(client.sessionId);
  }

  public onDispose() {
    console.log("room", this.roomId, "disposing...");
  }
}
