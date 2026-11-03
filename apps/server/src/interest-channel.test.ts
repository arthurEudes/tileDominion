import { decode } from "@msgpack/msgpack";
import { describe, expect, it } from "vitest";
import { expandSnapshot, type CompactSnapshot, type UnitView } from "@tile/protocol";
import { DominionRoom } from "./room.js";
import { World } from "./world.js";
import type { Client } from "colyseus";

describe("shared spatial interest channels", () => {
  it("sends a compact global minimap then only changed strategic cells", () => {
    const room = Object.create(DominionRoom.prototype) as DominionRoom;
    room.world = new World();
    room.minimapOwners = [];
    const owner = room.world.addPlayer("owner", "Owner", 0x11aaee);
    for (let y = 0; y < 4; y++)
      for (let x = 0; x < 4; x++)
        room.world.map.get(`${x},${y}`)!.owner = owner.id;
    let payload: Uint8Array | undefined;
    const client = {
      sendBytes: (type: string, bytes: Uint8Array) => {
        if (type === "minimap") payload = bytes;
      },
    } as unknown as Client;
    (room as unknown as { sendFullMinimap(client: Client): void })
      .sendFullMinimap(client);
    const full = decode(payload!) as [
      number,
      number,
      number,
      Array<[number, string | null]>,
    ];
    expect(full.slice(0, 3)).toEqual([1, 101, 101]);
    expect(full[3]).toContainEqual([0, owner.id]);

    for (let y = 0; y < 4; y++)
      for (let x = 0; x < 4; x++)
        room.world.map.get(`${x},${y}`)!.owner = null;
    const delta = (
      room as unknown as {
        updateMinimap(tiles: string[]): Array<[number, string | null]>;
      }
    ).updateMinimap(["0,0"]);
    expect(delta).toEqual([[0, null]]);
  });

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

  it("sends a purchased attacker through the next tile-free delta", () => {
    const room = Object.create(DominionRoom.prototype) as DominionRoom;
    room.world = new World();
    room.unitChannels = new Map();
    room.clientInterestCells = new Map();
    room.globalUnitIds = new Map();
    room.nextGlobalUnitId = 1;
    const player = room.world.addPlayer("player", "Player", 0x11aaee);
    player.x = player.y = 24;
    player.money = 9999;
    room.world.spatial.rebuild(
      room.world.players.values(),
      room.world.units.values(),
    );

    const received: Uint8Array[] = [],
      client = {
        sessionId: player.id,
        sendBytes: (_type: string, bytes: Uint8Array) => received.push(bytes),
      } as unknown as Client;
    Object.defineProperty(room, "clients", { value: [client] });
    (room as unknown as { broadcastInterestStates(changed: string[]): void })
      .broadcastInterestStates([]);
    received.length = 0;

    expect(room.world.buy(player.id, "attacker")).toBe(true);
    room.world.spatial.rebuild(
      room.world.players.values(),
      room.world.units.values(),
    );
    (room as unknown as { broadcastInterestStates(changed: string[]): void })
      .broadcastInterestStates([]);

    const units = new Map<number, UnitView>(),
      snapshot = expandSnapshot(
        decode(received[0]) as CompactSnapshot,
        units,
      );
    expect(snapshot.tiles).toHaveLength(0);
    expect(snapshot.unitDelta.created).toHaveLength(1);
    expect(snapshot.units.some((unit) => unit.kind === "attacker")).toBe(true);
    expect(received[0].byteLength).toBeLessThan(2_000);

    const attacker = [...room.world.units.values()].find(
      (unit) => unit.kind === "attacker",
    )!;
    room.world.damageUnit(attacker, attacker.hp + 1);
    room.world.spatial.rebuild(
      room.world.players.values(),
      room.world.units.values(),
    );
    received.length = 0;
    (room as unknown as { broadcastInterestStates(changed: string[]): void })
      .broadcastInterestStates([]);
    const removal = expandSnapshot(
      decode(received[0]) as CompactSnapshot,
      units,
    );
    expect(removal.unitDelta.removed).toEqual(snapshot.unitDelta.created);
    expect(room.globalUnitIds.has(attacker.id)).toBe(false);
  });
});
