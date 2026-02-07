import { WorldStore } from "../rooms/world/WorldStore.js";

export const WORLD = new WorldStore({
  minCoord: -100000,
  maxCoord: 100000,
});
