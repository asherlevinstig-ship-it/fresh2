import "noa-engine";

declare module "noa-engine" {
  interface Engine {
    colyseus?: {
      endpoint: string;
      client: any;
      room: any;
    };
  }

  interface Entities {
    addComponent(
      entity: number,
      name: string,
      data?: any
    ): void;
  }
}
