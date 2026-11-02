import { decode } from "@msgpack/msgpack";
import { describe, expect, it } from "vitest";
import { expandSnapshot, type CompactSnapshot, type UnitView } from "@tile/protocol";
import { DominionRoom } from "./room.js";
import { World } from "./world.js";
import type { Client } from "colyseus";

describe("shared spatial interest channels", () => {
  it("reuses one payload inside a cell and excludes distant units", () => {
    const room = Object.create(DominionRoom.prototype) as DominionRoom;
    room.world = new World();
    room.unitChannels = new Map();
    room.clientInterestCells = new Map();
    room.globalUnitIds = new Map();
    room.nextGlobalUnitId = 1;
    const a = room.world.addPlayer("a", "A", 1),
      b = room.world.addPlayer("b", "B", 2);
    a.x = b.x = 24;
    a.y = b.y = 24;
    room.world.spawnProducedUnit(a.id, "robot", 26, 24);
    room.world.spawnProducedUnit(b.id, "robot", 300, 300);
    room.world.spatial.rebuild(room.world.players.values(), room.world.units.values());

    const received = new Map<string, Uint8Array>();
    const clients = ["a", "b"].map(
      (sessionId) =>
        ({
          sessionId,
          sendBytes: (_type: string, bytes: Uint8Array) => received.set(sessionId, bytes),
        }) as unknown as Client,
    );
    Object.defineProperty(room, "clients", { value: clients });

    (room as unknown as {
      broadcastInterestStates(changed: string[]): void;
    }).broadcastInterestStates([]);

    expect(received.get("a")).toBe(received.get("b"));
    const units = new Map<number, UnitView>(),
      snapshot = expandSnapshot(
        decode(received.get("a")!) as CompactSnapshot,
        units,
      );
    expect(snapshot.units.some((unit) => unit.x === 26)).toBe(true);
    expect(snapshot.units.some((unit) => unit.x === 300)).toBe(false);
  });

  it("includes the owner metadata for every visible AI unit", () => {
    const room = Object.create(DominionRoom.prototype) as DominionRoom;
    room.world = new World();
    room.unitChannels = new Map();
    room.globalUnitIds = new Map();
    room.nextGlobalUnitId = 1;
    const viewer = room.world.addPlayer("viewer", "Viewer", 0x11aaee),
      bot = room.world.addPlayer("bot", "Bot", 0xee5511, true);
    viewer.x = viewer.y = 24;
    bot.x = bot.y = 300;
    room.world.spawnProducedUnit(bot.id, "robot", 26, 24);
    room.world.spatial.rebuild(room.world.players.values(), room.world.units.values());

    const snapshot = (room as unknown as {
      interestSnapshot(cell: string, full: boolean, tiles: string[]): {
        units: UnitView[];
        players: Array<{ id: string; color: number }>;
      };
    }).interestSnapshot("1,1", false, []);
    expect(snapshot.units.some(({ ownerId }) => ownerId === bot.id)).toBe(true);
    expect(snapshot.players).toContainEqual(expect.objectContaining({
      id: bot.id, color: bot.color,
    }));
  });
});
