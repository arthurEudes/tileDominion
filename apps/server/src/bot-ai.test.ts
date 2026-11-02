import { describe, expect, it } from "vitest";
import { GAME } from "@tile/game-config";
import { DominionRoom } from "./room.js";
import { NEUTRAL_OWNER_ID, World } from "./world.js";

function roomWithoutRuntime() {
  const room = Object.create(DominionRoom.prototype) as DominionRoom;
  room.world = new World();
  for (const tile of room.world.map.values()) tile.obstacle = false;
  room.botThink = new Map();
  room.botBuildThink = new Map();
  room.botSerial = 0;
  room.unitChannels = new Map();
  room.rates = new Map();
  return room;
}

describe("strategic bot lifecycle", () => {
  it("keeps exactly fifty logical player slots when a human joins", () => {
    const room = roomWithoutRuntime();
    for (let index = 0; index < GAME.room.maxPlayers; index++) room.addBot();
    expect(room.world.players.size).toBe(50);
    expect(
      [...room.world.players.values()].filter((player) => player.isBot),
    ).toHaveLength(50);

    expect(room.evictBotForHuman()).toBe(true);
    room.world.addPlayer("human", "Human", 0xffffff);
    expect(room.world.players.size).toBe(50);
    expect(
      [...room.world.players.values()].filter((player) => player.isBot),
    ).toHaveLength(49);
  });

  it("evicts the weakest bot and invalidates its client ownership delta", () => {
    const room = roomWithoutRuntime(),
      weak = room.world.addPlayer("weak", "Weak", 1, true),
      strong = room.world.addPlayer("strong", "Strong", 2, true);
    strong.money = 999;
    room.world.buy(strong.id, "robot");
    const weakUnits = [...room.world.units.values()]
      .filter((unit) => unit.ownerId === weak.id)
      .map((unit) => unit.id);
    room.unitChannels.set("client", {
      nextId: 3,
      ids: new Map(weakUnits.map((id, index) => [id, index + 1])),
      previous: new Map(
        weakUnits.map((id) => [id, [1, 1, 1, 1] as [number, number, number, number]]),
      ),
    });

    expect(room.evictBotForHuman()).toBe(true);
    expect(room.world.players.has(weak.id)).toBe(false);
    expect(room.world.players.has(strong.id)).toBe(true);
    expect(
      [...room.world.units.values()]
        .filter((unit) => weakUnits.includes(unit.id))
        .every((unit) => unit.ownerId === NEUTRAL_OWNER_ID),
    ).toBe(true);
    expect(room.unitChannels.get("client")?.previous.size).toBe(0);
  });

  it("uses relays, fortresses, factories and every mobile unit role", () => {
    const room = roomWithoutRuntime(),
      bot = room.world.addPlayer("bot", "Bot", 1, true),
      enemy = room.world.addPlayer("enemy", "Enemy", 2);
    room.botThink.set(bot.id, 0);
    room.botBuildThink.set(bot.id, 0);
    bot.money = 100_000;
    const enemyHeadquarters = [...room.world.units.values()].find(
      (unit) => unit.ownerId === enemy.id && unit.kind === "headquarters",
    )!;
    enemyHeadquarters.x = bot.x + 5;
    enemyHeadquarters.y = bot.y;

    for (let turn = 0; turn < 22; turn++) {
      if (turn === 1) room.world.suppliedTiles.fill(1);
      room.world.spatial.rebuild(
        room.world.players.values(),
        room.world.units.values(),
      );
      room.botThink.set(bot.id, 0);
      room.botBuildThink.set(bot.id, 0);
      room.updateBots(10_000 + turn * 5_000);
    }

    const units = [...room.world.units.values()].filter(
        (unit) => unit.ownerId === bot.id,
      ),
      buildingTypes = units
        .filter((unit) => unit.kind === "bastion")
        .map((unit) => unit.bastionType);
    expect(buildingTypes).toEqual(
      expect.arrayContaining(["relay", "fortress", "factory"]),
    );
    expect(units.some((unit) => unit.kind === "robot")).toBe(true);
    expect(units.some((unit) => unit.kind === "defender")).toBe(true);
    expect(units.some((unit) => unit.kind === "attacker")).toBe(true);
    expect(bot.input.x).toBeGreaterThan(0);
    expect(Math.abs(bot.input.y)).toBeLessThan(0.01);
    expect(GAME.room.maxPlayers).toBe(50);
  });

  it("turns a departed human into a bot while retaining its assets", () => {
    const room = roomWithoutRuntime(),
      human = room.world.addPlayer("human", "Human", 1),
      units = room.world.units.size,
      tiles = room.world.territoryCounts.get(human.id);
    expect(room.replaceHumanWithBot(human.id)).toBe(true);
    expect(room.world.players.get(human.id)?.isBot).toBe(true);
    expect(room.world.units.size).toBe(units);
    expect(room.world.territoryCounts.get(human.id)).toBe(tiles);
  });
});
