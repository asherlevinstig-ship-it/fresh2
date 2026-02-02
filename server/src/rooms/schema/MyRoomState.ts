import { Schema, type, MapSchema } from "@colyseus/schema";

export class PlayerState extends Schema {
  @type("string") id: string = "";
  @type("string") name: string = "Steve"; // MCHeads identifier (username or UUID)

  @type("number") x: number = 0;
  @type("number") y: number = 0;
  @type("number") z: number = 0;

  @type("number") yaw: number = 0;   // radians or degrees (pick one and stick to it)
  @type("number") pitch: number = 0; // radians or degrees
}

export class MyRoomState extends Schema {
  @type({ map: PlayerState }) players = new MapSchema<PlayerState>();
}
