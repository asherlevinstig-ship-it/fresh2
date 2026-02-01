import { Room, Client, CloseCode } from "colyseus";
import { MyRoomState } from "./schema/MyRoomState.js";

export class MyRoom extends Room {
  public maxClients = 4;
  public state = new MyRoomState();

  /**
   * Called when a new room is created.
   */
  public onCreate(options: any) {
    // Set the initial state (already done via property initializer)
    // If you prefer explicit init, you can do:
    // this.setState(new MyRoomState());

    // Optional: log creation
    console.log("room", this.roomId, "created with options:", options);

    /**
     * Register message handlers here.
     * Clients will call: room.send("yourMessageType", payload)
     */
    this.onMessage("yourMessageType", (client: Client, message: any) => {
      /**
       * Handle "yourMessageType" message.
       */
      console.log(client.sessionId, "sent a message:", message);
    });

    /**
     * Optional helper message type you can use for quick connectivity tests.
     * Clients can call: room.send("hello", {...})
     */
    this.onMessage("hello", (client: Client, message: any) => {
      console.log(client.sessionId, "said hello:", message);

      // Example: reply to only that client
      client.send("hello_ack", { ok: true, serverTime: Date.now() });
    });
  }

  /**
   * Called when a client joins the room.
   */
  public onJoin(client: Client, options: any) {
    console.log(client.sessionId, "joined!", "options:", options);

    // Optional: send a welcome message
    client.send("welcome", {
      roomId: this.roomId,
      sessionId: client.sessionId,
    });
  }

  /**
   * Called when a client leaves the room.
   */
  public onLeave(client: Client, code: CloseCode) {
    console.log(client.sessionId, "left!", code);
  }

  /**
   * Called when the room is disposed.
   */
  public onDispose() {
    console.log("room", this.roomId, "disposing...");
  }
}
