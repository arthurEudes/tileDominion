import { describe, it, expect } from "vitest";
import { NEUTRAL_OWNER_ID, World } from "./world.js";
import { key } from "./model.js";
import { GAME, incomeForTerritory } from "@tile/game-config";
import { RustEngine } from "./rust-engine.js";
function world() {
  const w = new World();
  for (const t of w.map.values()) t.obstacle = false;
  return w;
}
describe("authoritative rules", () => {
  it("does not partially tick before a Rust failure", async () => {
    const w = world(),
      player = w.addPlayer("a", "A", 1),
      x = player.x;
    player.input = { x: 1, y: 0, attack: false, seq: 1 };
    const failingEngine = {
      scheduleDelta: () => Promise.reject(new Error("engine stopped")),
    } as unknown as RustEngine;

    await expect(w.tickWithRust(failingEngine, 0.1, 1000)).rejects.toThrow(
      "engine stopped",
    );
    expect(player.x).toBe(x);
  });
  it("applies Rust movement once and uses its selected combat target", async () => {
    const w = world(),
      a = w.addPlayer("a", "A", 1),
      b = w.addPlayer("b", "B", 2);
    a.money = b.money = 999;
    w.buy("a", "soldier");
    w.buy("b", "robot");
    const soldier = [...w.units.values()].find(
        (u) => u.ownerId === "a" && u.kind === "soldier",
      )!,
      robot = [...w.units.values()].find(
        (u) => u.ownerId === "b" && u.kind === "robot",
      )!;
    robot.x = soldier.x + 1;
    robot.y = soldier.y;
    const movedX = soldier.x + 0.1,
      hp = robot.hp,
      engine = {
        scheduleDelta: () =>
          Promise.resolve([
            {
              id: soldier.id,
              dt: 0.05,
              interval_ms: 50,
              target_id: robot.id,
              next_simulation_at: 10050,
              x: movedX,
              y: soldier.y,
              dir_x: 1,
              dir_y: 0,
              next_think: soldier.nextThink,
            },
          ]),
      } as unknown as RustEngine;

    await w.tickWithRust(engine, 0.05, 10000);
    expect(soldier.x).toBe(movedX);
    expect(robot.hp).toBe(hp - GAME.units.soldier.damage);
  });
  it("projects a Rust EntityKilled event without recalculating damage", async () => {
    const w = world(),
      owner = w.addPlayer("owner", "Owner", 1),
      enemy = w.addPlayer("enemy", "Enemy", 2);
    enemy.money = 999;
    w.buy(enemy.id, "robot");
    const victim = [...w.units.values()].find(
      (unit) => unit.ownerId === enemy.id && unit.kind === "robot",
    )!;
    const engine = {
      scheduleDeltaWithEvents: () => Promise.resolve({
        schedules: [],
        events: [{
          kind: 3, entityId: null, targetId: victim.id,
          tileIndex: 0, amount: victim.hp, ownerId: owner.id,
        }],
      }),
    } as unknown as RustEngine;

    await w.tickWithRust(engine, 0.05, 1000);
    expect(w.units.has(victim.id)).toBe(false);
  });
  it("keeps captured tile deltas until Rust acknowledges them", async () => {
    const w = world(),
      player = w.addPlayer("a", "A", 1),
      tileKey = key(Math.floor(player.x) + 3, Math.floor(player.y)),
      tile = w.map.get(tileKey)!;
    // Ignore spawn initialization and reproduce the client snapshot clearing
    // its own dirty set before the following Rust tick.
    w.rustDirtyTiles.clear();
    w.setOwner(tileKey, tile, player.id);
    w.dirtyTiles.clear();
    let received: string[] = [];
    const engine = {
      scheduleDelta: (
        _now: number,
        _units: unknown,
        _unitRemovals: unknown,
        _players: unknown,
        _playerRemovals: unknown,
        _map: unknown,
        dirtyTiles: Iterable<string>,
      ) => {
        received = [...dirtyTiles];
        return Promise.resolve([]);
      },
    } as unknown as RustEngine;

    expect(w.rustDirtyTiles.has(tileKey)).toBe(true);
    await w.tickWithRust(engine, 0.05, 1000);
    expect(received).toContain(tileKey);
    expect(w.rustDirtyTiles.has(tileKey)).toBe(false);
  });
  it("captures a tile through the real Rust tick path", async () => {
    const w = world(),
      player = w.addPlayer("a", "A", 1),
      tileKey = key(Math.floor(player.x) + 3, Math.floor(player.y)),
      tile = w.map.get(tileKey)!,
      engine = new RustEngine(),
      startedAt = Date.now() + 1000;
    tile.owner = null;
    player.x += 3;
    player.input = { x: 0, y: 0, attack: false, seq: 1 };
    try {
      await w.tickWithRust(engine, 0.05, startedAt);
      await w.tickWithRust(
        engine,
        0.05,
        startedAt + GAME.capture.holdMs + 1,
      );
      expect(tile.owner).toBe(player.id);
    } finally {
      engine.close();
    }
  });
  it("captures without an instant reward", () => {
    const w = world(),
      p = w.addPlayer("a", "A", 1),
      t = w.map.get(key(Math.floor(p.x) + 3, Math.floor(p.y)))!;
    t.owner = null;
    p.x += 3;
    w.tickPlayer(p, 0.01, 1000);
    w.tickPlayer(p, 0.01, 1000 + GAME.capture.holdMs + 1);
    expect(t.owner).toBe("a");
    expect(p.money).toBe(GAME.economy.startingMoney);
  });
  it("pays income from owned tiles", () => {
    const w = world(),
      p = w.addPlayer("a", "A", 1),
      before = p.money;
    w.tick(GAME.economy.incomeIntervalMs / 1000);
    expect(p.money).toBe(before + incomeForTerritory(w.counts("a").tiles));
  });
  it("pays base income without any territory", () => {
    const w = world(),
      p = w.addPlayer("a", "A", 1);
    for (const [tileKey, tile] of w.map)
      if (tile.owner === p.id) w.setOwner(tileKey, tile, null);
    const before = p.money;
    w.tick(GAME.economy.incomeIntervalMs / 1000);
    expect(p.money).toBe(before + GAME.economy.baseIncome);
  });
  it("applies diminishing territory returns", () => {
    expect(incomeForTerritory(100)).toBe(17);
    expect(incomeForTerritory(300)).toBe(31);
    expect(incomeForTerritory(1000)).toBe(52);
  });
  it("limits AI capture searches to its configured local radius", () => {
    const w = world(),
      p = w.addPlayer("a", "A", 1);
    p.x = 100.5;
    p.y = 100.5;
    for (const tile of w.map.values()) tile.owner = p.id;
    w.map.get(key(100 + GAME.bots.searchRadius + 1, 100))!.owner = null;
    expect(w.findCaptureTarget(p)).toBeUndefined();
    w.map.get(key(100 + GAME.bots.searchRadius - 1, 100))!.owner = null;
    expect(w.findCaptureTarget(p)).toBeDefined();
  });
  it("enemy capture changes owner", () => {
    const w = world(),
      a = w.addPlayer("a", "A", 1),
      b = w.addPlayer("b", "B", 2),
      t = w.map.get(key(Math.floor(a.x), Math.floor(a.y)))!;
    b.x = a.x;
    b.y = a.y;
    w.tickPlayer(b, 0, 1);
    w.tickPlayer(
      b,
      0,
      1 + GAME.capture.holdMs * GAME.capture.enemyMultiplier - 1,
    );
    expect(t.owner).toBe("a");
    w.tickPlayer(
      b,
      0,
      1 + GAME.capture.holdMs * GAME.capture.enemyMultiplier + 1,
    );
    expect(t.owner).toBe("b");
  });
  it("robot captures neutral tiles in twice the player base duration", () => {
    const w = world(),
      a = w.addPlayer("a", "A", 1);
    a.money = 999;
    w.buy("a", "robot");
    const robot = [...w.units.values()].find((u) => u.kind === "robot")!,
      k = key(Math.floor(robot.x) + 3, Math.floor(robot.y)),
      t = w.map.get(k)!;
    robot.x += 3;
    robot.dirX = robot.dirY = 0;
    robot.nextThink = Number.POSITIVE_INFINITY;
    const startX = robot.x,
      startY = robot.y;
    w.tickUnit(robot, 0.2, 1000);
    expect(robot.x).toBe(startX);
    expect(robot.y).toBe(startY);
    const duration = GAME.capture.holdMs * GAME.capture.robotMultiplier;
    w.tickUnit(robot, 0, 1000 + duration - 1);
    expect(t.owner).not.toBe(a.id);
    w.tickUnit(robot, 0, 1000 + duration + 1);
    expect(t.owner).toBe(a.id);
  });
  it("robot combines its slower capture with the enemy multiplier", () => {
    const w = world(),
      a = w.addPlayer("a", "A", 1),
      b = w.addPlayer("b", "B", 2);
    a.money = 999;
    w.buy("a", "robot");
    const robot = [...w.units.values()].find((u) => u.kind === "robot")!,
      k = key(Math.floor(robot.x), Math.floor(robot.y)),
      t = w.map.get(k)!;
    w.setOwner(k, t, b.id);
    robot.dirX = robot.dirY = 0;
    robot.nextThink = Number.POSITIVE_INFINITY;
    w.tickUnit(robot, 0, 1000);
    const duration =
      GAME.capture.holdMs *
      GAME.capture.robotMultiplier *
      GAME.capture.enemyMultiplier;
    w.tickUnit(robot, 0, 1000 + duration - 1);
    expect(t.owner).toBe(b.id);
    w.tickUnit(robot, 0, 1000 + duration + 1);
    expect(t.owner).toBe(a.id);
  });
  it("rejects expensive purchase", () => {
    const w = world(),
      p = w.addPlayer("a", "A", 1);
    p.money = 0;
    expect(w.buy("a", "soldier")).toBe(false);
  });
  it("allows robots without a purchase cap", () => {
    const w = world(),
      p = w.addPlayer("a", "A", 1);
    p.money = 99999;
    for (let i = 0; i < 20; i++) expect(w.buy("a", "robot")).toBe(true);
    expect(w.counts("a").robots).toBe(20);
  });
  it("directs robots toward one of the three nearest non-allied tiles", () => {
    const w = world(),
      p = w.addPlayer("a", "A", 1);
    p.money = 999;
    w.buy("a", "robot");
    const robot = [...w.units.values()].find((u) => u.kind === "robot")!;
    robot.x = 100.5;
    robot.y = 100.5;
    for (const tile of w.map.values()) tile.owner = p.id;
    w.map.get(key(103, 100))!.owner = null;
    w.map.get(key(95, 100))!.owner = null;
    w.map.get(key(100, 104))!.owner = null;
    robot.nextThink = 0;
    w.tickUnit(robot, 0.1, 1000);
    expect([
      "103.5,100.5",
      "95.5,100.5",
      "100.5,104.5",
    ]).toContain(`${robot.orderX},${robot.orderY}`);
  });
  it("restores robots to their original speed", () => {
    const w = world(),
      p = w.addPlayer("a", "A", 1);
    p.money = 999;
    w.buy("a", "robot");
    const robot = [...w.units.values()].find((u) => u.kind === "robot")!;
    robot.x = 100.5;
    robot.y = 100.5;
    for (const tile of w.map.values()) tile.owner = p.id;
    w.map.get(key(110, 100))!.owner = null;
    const start = robot.x;
    robot.dirX = 1;
    robot.dirY = 0;
    robot.nextThink = Number.POSITIVE_INFINITY;
    w.tickUnit(robot, 1, 1000);
    expect(robot.x - start).toBeCloseTo(2.2);
  });
  it("allows soldiers without a purchase cap", () => {
    const w = world(),
      p = w.addPlayer("a", "A", 1);
    p.money = 99999;
    for (let i = 0; i < 20; i++) expect(w.buy("a", "soldier")).toBe(true);
    expect(w.counts("a").soldiers).toBe(20);
  });
  it("gives defenders triple health and 1.5 times attacker damage", () => {
    const w = world(),
      a = w.addPlayer("a", "A", 1),
      b = w.addPlayer("b", "B", 2);
    a.money = b.money = 999;
    expect(w.buy("a", "defender")).toBe(true);
    expect(w.buy("b", "robot")).toBe(true);
    const defender = [...w.units.values()].find(
        (unit) => unit.ownerId === a.id && unit.kind === "defender",
      )!,
      robot = [...w.units.values()].find(
        (unit) => unit.ownerId === b.id && unit.kind === "robot",
      )!,
      hp = robot.hp;
    expect(defender.hp).toBe(GAME.units.attacker.hp * 3);
    robot.x = defender.x + 1;
    robot.y = defender.y;
    w.spatial.rebuild(w.players.values(), w.units.values());
    w.tickUnit(defender, 0, Date.now() + 1000);
    expect(robot.hp).toBe(hp - GAME.units.attacker.damage * 1.5);
  });
  it("places a paid bastion only on owned territory", () => {
    const w = world(),
      p = w.addPlayer("a", "A", 1),
      x = Math.floor(p.x),
      y = Math.floor(p.y);
    p.money = GAME.units.bastion.price;
    expect(w.placeBastion("a", x, y, "fortress", 1000)).toBe(true);
    expect(p.money).toBe(0);
    expect(w.counts("a").bastions).toBe(1);
    expect(w.placeBastion("a", x + 20, y, "fortress", 1000)).toBe(false);
  });
  it("fortresses produce defenders and factories produce robots", () => {
    const w = world(),
      p = w.addPlayer("a", "A", 1);
    p.money = 9999;
    const x = Math.floor(p.x),
      y = Math.floor(p.y);
    w.placeBastion("a", x, y, "fortress", 1000);
    w.placeBastion("a", x + 1, y, "factory", 1000);
    const bastions = [...w.units.values()].filter((u) => u.kind === "bastion"),
      fortress = bastions.find((u) => u.bastionType === "fortress")!,
      factory = bastions.find((u) => u.bastionType === "factory")!;
    w.tickUnit(
      fortress,
      0,
      1000 + GAME.units.bastion.fortressProductionMs,
    );
    w.tickUnit(
      factory,
      0,
      1000 + GAME.units.bastion.factoryProductionMs,
    );
    expect([...w.units.values()].some((u) => u.kind === "defender")).toBe(true);
    expect([...w.units.values()].some((u) => u.kind === "robot")).toBe(true);
  });
  it("keeps each fortress at no more than eight active defenders", () => {
    const w = world(),
      p = w.addPlayer("a", "A", 1),
      x = Math.floor(p.x),
      y = Math.floor(p.y);
    p.money = 9999;
    expect(w.placeBastion(p.id, x, y, "fortress", 1000)).toBe(true);
    const fortress = [...w.units.values()].find(
      (unit) => unit.kind === "bastion" && unit.bastionType === "fortress",
    )!;
    for (let production = 0; production < 12; production++)
      w.tickUnit(fortress, 0, fortress.nextProduce);
    const produced = [...w.units.values()].filter(
      (unit) =>
        unit.kind === "defender" && unit.sourceBastionId === fortress.id,
    );
    expect(produced).toHaveLength(GAME.units.bastion.maxDefenders);

    w.damageUnit(produced[0], 9999);
    w.tickUnit(fortress, 0, fortress.nextProduce);
    expect(
      [...w.units.values()].filter(
        (unit) =>
          unit.kind === "defender" && unit.sourceBastionId === fortress.id,
      ),
    ).toHaveLength(GAME.units.bastion.maxDefenders);
  });
  it("keeps defenders on allied territory and returns them when isolated", () => {
    const w = world(),
      p = w.addPlayer("a", "A", 1);
    p.money = 999;
    w.buy(p.id, "defender");
    const defender = [...w.units.values()].find(
        (unit) => unit.kind === "defender",
      )!;
    const alliedX = Math.floor(defender.x),
      alliedY = Math.floor(defender.y);
    defender.dirX = 1;
    defender.dirY = 0;
    defender.nextThink = 5000;
    w.tickUnit(defender, 1, 1000);
    expect(
      w.map.get(key(Math.floor(defender.x), Math.floor(defender.y)))?.owner,
    ).toBe(p.id);

    defender.x = alliedX + 3.5;
    defender.y = alliedY + 0.5;
    w.tickUnit(defender, 0.5, 2000);
    expect(defender.dirX).toBeLessThan(0);
  });
  it("lets defenders leave allied territory for a target then return", () => {
    const w = world(),
      owner = w.addPlayer("owner", "Owner", 1),
      enemy = w.addPlayer("enemy", "Enemy", 2);
    owner.money = enemy.money = 999;
    w.buy(owner.id, "defender");
    w.buy(enemy.id, "robot");
    const defender = [...w.units.values()].find(
        (unit) => unit.ownerId === owner.id && unit.kind === "defender",
      )!,
      robot = [...w.units.values()].find(
        (unit) => unit.ownerId === enemy.id && unit.kind === "robot",
      )!;
    for (const tile of w.map.values()) tile.owner = null;
    w.map.get(key(10, 10))!.owner = owner.id;
    Object.assign(defender, {
      x: 10.5,
      y: 10.5,
      homeX: 10.5,
      homeY: 10.5,
      orderX: 10.5,
      orderY: 10.5,
      nextThink: 0,
    });
    robot.x = 14.5;
    robot.y = 10.5;
    w.spatial.rebuild(w.players.values(), w.units.values());
    w.tickUnit(defender, 0.5, 1000);
    expect(defender.x).toBeGreaterThan(11);
    expect(w.map.get(key(Math.floor(defender.x), Math.floor(defender.y)))?.owner)
      .not.toBe(owner.id);

    const sortieX = defender.x;
    w.units.delete(robot.id);
    w.spatial.rebuild(w.players.values(), w.units.values());
    w.tickUnit(defender, 0.5, 2000);
    expect(defender.x).toBeLessThan(sortieX);
  });
  it("lets defenders patrol beyond the former invisible edge", () => {
    const w = world(),
      owner = w.addPlayer("owner", "Owner", 1);
    owner.money = 999;
    w.buy(owner.id, "defender");
    const defender = [...w.units.values()].find(
      (unit) => unit.kind === "defender",
    )!;
    for (const tile of w.map.values()) tile.owner = null;
    for (let x = 10; x <= 22; x++) w.map.get(key(x, 10))!.owner = owner.id;
    Object.assign(defender, {
      x: 21.5,
      y: 10.5,
      homeX: 10.5,
      homeY: 10.5,
      orderX: 10.5,
      orderY: 10.5,
      dirX: 1,
      dirY: 0,
      nextThink: 5000,
    });
    const before = defender.x;
    w.spatial.rebuild(w.players.values(), w.units.values());
    w.tickUnit(defender, 0.5, 1000);
    expect(defender.x).toBeGreaterThan(before);
    expect(defender.dirX).toBeGreaterThan(0);
  });
  it("holds a defender still while its nearby target is in range", () => {
    const w = world(),
      owner = w.addPlayer("owner", "Owner", 1),
      enemy = w.addPlayer("enemy", "Enemy", 2);
    owner.money = enemy.money = 999;
    w.buy(owner.id, "defender");
    w.buy(enemy.id, "robot");
    const defender = [...w.units.values()].find(
        (unit) => unit.ownerId === owner.id && unit.kind === "defender",
      )!,
      robot = [...w.units.values()].find(
        (unit) => unit.ownerId === enemy.id && unit.kind === "robot",
      )!;
    robot.x = defender.x + GAME.units.defender.range - 0.2;
    robot.y = defender.y;
    defender.dirX = 1;
    defender.lastAttack = 1000;
    const before = { x: defender.x, y: defender.y };
    w.spatial.rebuild(w.players.values(), w.units.values());
    w.tickUnit(defender, 0.5, 1100);
    expect({ x: defender.x, y: defender.y }).toEqual(before);
    expect([defender.dirX, defender.dirY]).toEqual([0, 0]);
  });
  it("blocks allied and enemy movement with a destructible wall", () => {
    const w = world(),
      owner = w.addPlayer("owner", "Owner", 1),
      enemy = w.addPlayer("enemy", "Enemy", 2),
      wallX = Math.floor(owner.x) + 2,
      wallY = Math.floor(owner.y);
    owner.money = 9999;
    expect(w.placeBastion(owner.id, wallX, wallY, "wall", 1000)).toBe(true);
    const wall = [...w.units.values()].find(
      (unit) => unit.bastionType === "wall",
    )!;
    expect(wall.hp).toBe(GAME.units.bastion.wallHp);

    for (const player of [owner, enemy]) {
      player.x = wallX - 0.2;
      player.y = wallY + 0.5;
      player.input = { x: 1, y: 0, attack: false, seq: 1 };
      const before = player.x;
      w.tickPlayer(player, 0.2, 2000);
      expect(player.x).toBe(before);
    }

    w.damageUnit(wall, 9999);
    expect(w.wallTiles.has(key(wallX, wallY))).toBe(false);
    owner.input.seq++;
    w.tickPlayer(owner, 0.2, 3000);
    expect(owner.x).toBeGreaterThan(wallX);
  });
  it("makes turrets automatically damage the nearest enemy", () => {
    const w = world(),
      owner = w.addPlayer("owner", "Owner", 1),
      enemy = w.addPlayer("enemy", "Enemy", 2),
      turretX = Math.floor(owner.x) + 1,
      turretY = Math.floor(owner.y);
    owner.money = enemy.money = 9999;
    expect(
      w.placeBastion(owner.id, turretX, turretY, "turret", 1000),
    ).toBe(true);
    w.buy(enemy.id, "robot");
    const turret = [...w.units.values()].find(
        (unit) => unit.bastionType === "turret",
      )!,
      robot = [...w.units.values()].find(
        (unit) => unit.ownerId === enemy.id && unit.kind === "robot",
      )!;
    robot.x = turret.x + 2;
    robot.y = turret.y;
    const hp = robot.hp;
    w.spatial.rebuild(w.players.values(), w.units.values());
    w.tickUnit(turret, 0, 2000);
    expect(robot.hp).toBe(hp - GAME.units.bastion.turretDamage);
  });
  it("halves isolated territory income and eventually neutralizes it", () => {
    const w = world(),
      p = w.addPlayer("a", "A", 1),
      farX = p.x < GAME.map.width / 2 ? GAME.map.width - 5 : 4,
      farY = p.y < GAME.map.height / 2 ? GAME.map.height - 5 : 4,
      farKey = key(farX, farY),
      farTile = w.map.get(farKey)!,
      now = Date.now() + 1000;
    w.setOwner(farKey, farTile, p.id);
    p.money = 0;
    w.tick(1, now);
    expect(farTile.supplyDecay).toBe(1);
    expect(w.unsuppliedTerritoryCounts.get(p.id)).toBeGreaterThan(0);
    const incomeWithIsolation = p.money;
    expect(incomeWithIsolation).toBe(incomeForTerritory(
      (w.suppliedTerritoryCounts.get(p.id) ?? 0) +
        (w.unsuppliedTerritoryCounts.get(p.id) ?? 0) * 0.5,
    ));

    w.tick(0, now + GAME.supply.decayMs + GAME.supply.updateIntervalMs);
    expect(farTile.owner).toBeNull();
    expect(farTile.supplyDecay).toBe(0);
  });
  it("allows an independent relay to supply a remote enclave", () => {
    const w = world(),
      p = w.addPlayer("a", "A", 1),
      origin = { x: p.x, y: p.y },
      x = p.x < GAME.map.width / 2 ? GAME.map.width - 5 : 4,
      y = p.y < GAME.map.height / 2 ? GAME.map.height - 5 : 4,
      enclave = w.map.get(key(x, y))!,
      now = Date.now() + 1000;
    w.setOwner(key(x, y), enclave, p.id);
    p.x = x + 0.5;
    p.y = y + 0.5;
    p.money = GAME.units.bastion.price;
    expect(w.placeBastion(p.id, x, y, "relay", now)).toBe(true);
    p.x = origin.x;
    p.y = origin.y;
    w.tick(0, now + GAME.supply.updateIntervalMs);
    expect(w.suppliedTiles[y * GAME.map.width + x]).toBe(1);
    expect(enclave.supplyDecay).toBe(0);
  });
  it("anchors supply independently from the character", () => {
    const w = world(),
      p = w.addPlayer("a", "A", 1),
      anchor = w.supplyAnchors.get(p.id)!;
    p.x = Math.min(GAME.map.width - 1, anchor.x + 80);
    p.y = Math.min(GAME.map.height - 1, anchor.y + 80);

    w.tick(0, Date.now() + GAME.supply.updateIntervalMs + 1);
    expect(w.isTileSupplied(anchor.x, anchor.y)).toBe(true);
    expect(w.map.get(key(anchor.x, anchor.y))?.owner).toBe(p.id);
  });
  it("relocates a captured supply anchor onto allied territory", () => {
    const w = world(),
      p = w.addPlayer("a", "A", 1),
      enemy = w.addPlayer("b", "B", 2),
      previous = w.supplyAnchors.get(p.id)!,
      tile = w.map.get(key(previous.x, previous.y))!;

    w.setOwner(key(previous.x, previous.y), tile, enemy.id);
    const relocated = w.supplyAnchors.get(p.id)!;
    expect(relocated).not.toEqual(previous);
    expect(w.map.get(key(relocated.x, relocated.y))?.owner).toBe(p.id);
  });
  it("orders only the owner's soldiers", () => {
    const w = world(),
      a = w.addPlayer("a", "A", 1),
      b = w.addPlayer("b", "B", 2);
    a.money = b.money = 999;
    w.buy("a", "soldier");
    w.buy("b", "soldier");
    const own = [...w.units.values()].find(
        (u) => u.ownerId === "a" && u.kind === "soldier",
      )!,
      enemy = [...w.units.values()].find(
        (u) => u.ownerId === "b" && u.kind === "soldier",
      )!;
    expect(
      w.orderSoldiers("a", {
        unitIds: [own.id, enemy.id],
        mode: "guard",
        x: 20,
        y: 20,
      }),
    ).toBe(1);
    expect(own.order).toBe("guard");
    expect(enemy.order).toBe("wander");
  });
  it("steers a directed soldier around a blocking wall", () => {
    const w = world(),
      p = w.addPlayer("a", "A", 1);
    p.money = 999;
    w.buy("a", "soldier");
    const soldier = [...w.units.values()].find((u) => u.kind === "soldier")!;
    soldier.x = 10.8;
    soldier.y = 10.5;
    soldier.dirX = 1;
    soldier.dirY = 0;
    w.map.get(key(11, 10))!.obstacle = true;
    w.moveMobileUnit(soldier, GAME.units.soldier.speed, 0.2);
    expect(Math.floor(soldier.x)).toBe(10);
    expect(soldier.y).not.toBe(10.5);
  });
  it("eliminates without territory", () => {
    const w = world(),
      p = w.addPlayer("a", "A", 1);
    for (const t of w.map.values()) if (t.owner === "a") t.owner = null;
    w.damagePlayer(p, 999, "x");
    expect(p.alive).toBe(false);
  });
  it("respawns with territory", () => {
    const w = world(),
      p = w.addPlayer("a", "A", 1);
    p.x += 3;
    w.damagePlayer(p, 999, "x");
    expect(p.alive).toBe(true);
    expect(p.hp).toBe(p.maxHp);
    expect(w.map.get(key(Math.floor(p.x), Math.floor(p.y)))?.owner).toBe(p.id);
  });
  it("destroys robot", () => {
    const w = world(),
      p = w.addPlayer("a", "A", 1);
    p.money = GAME.units.robot.price;
    w.buy("a", "robot");
    const u = [...w.units.values()].find((unit) => unit.kind === "robot")!;
    w.damageUnit(u, 999);
    expect([...w.units.values()].some((unit) => unit.kind === "robot")).toBe(
      false,
    );
  });
  it("halves damage to a unit standing on allied territory", () => {
    const w = world(),
      p = w.addPlayer("a", "A", 1);
    p.money = 999;
    w.buy("a", "robot");
    const robot = [...w.units.values()].find((u) => u.kind === "robot")!,
      hp = robot.hp;
    expect(
      w.map.get(key(Math.floor(robot.x), Math.floor(robot.y)))!.owner,
    ).toBe(p.id);
    w.damageUnit(robot, 20);
    expect(robot.hp).toBe(hp - 10);
  });
  it("does not let player characters attack", () => {
    const w = world(),
      attacker = w.addPlayer("a", "A", 1, true),
      target = w.addPlayer("b", "B", 2);
    attacker.x = target.x = 20;
    attacker.y = target.y = 20;
    w.setInput(attacker.id, { x: 0, y: 0, attack: true, seq: 1 });
    expect(attacker.input.attack).toBe(false);
    target.invulnerableUntil = 0;
    const hp = target.hp;
    w.spatial.rebuild(w.players.values(), w.units.values());

    w.tickPlayer(attacker, 0.05, 10000);
    expect(target.hp).toBe(hp);
    expect(attacker.lastAttack).toBe(0);
  });
  it("soldier attacks an enemy robot", () => {
    const w = world(),
      a = w.addPlayer("a", "A", 1),
      b = w.addPlayer("b", "B", 2);
    a.money = b.money = 999;
    w.buy("a", "soldier");
    w.buy("b", "robot");
    const soldier = [...w.units.values()].find(
        (u) => u.ownerId === "a" && u.kind === "soldier",
      )!,
      robot = [...w.units.values()].find(
        (u) => u.ownerId === "b" && u.kind === "robot",
      )!;
    robot.x = soldier.x + 0.5;
    robot.y = soldier.y;
    const hp = robot.hp;
    w.spatial.rebuild(w.players.values(), w.units.values());
    w.tickUnit(soldier, 0.05, 10000);
    expect(robot.hp).toBe(hp - GAME.units.soldier.damage);
  });
  it("soldier attacks an enemy soldier", () => {
    const w = world(),
      a = w.addPlayer("a", "A", 1),
      b = w.addPlayer("b", "B", 2);
    a.money = b.money = 999;
    w.buy("a", "soldier");
    w.buy("b", "soldier");
    const units = [...w.units.values()].filter((u) => u.kind === "soldier"),
      attacker = units[0],
      enemy = units[1];
    enemy.x = attacker.x + 0.5;
    enemy.y = attacker.y;
    const hp = enemy.hp;
    w.spatial.rebuild(w.players.values(), w.units.values());
    w.tickUnit(attacker, 0.05, 10000);
    expect(enemy.hp).toBe(hp - GAME.units.soldier.damage);
  });
  it("soldier attacks an enemy player", () => {
    const w = world(),
      a = w.addPlayer("a", "A", 1),
      b = w.addPlayer("b", "B", 2);
    a.money = 999;
    w.buy("a", "soldier");
    const soldier = [...w.units.values()].find((u) => u.kind === "soldier")!;
    b.x = soldier.x + 0.5;
    b.y = soldier.y;
    b.invulnerableUntil = 0;
    const hp = b.hp;
    w.spatial.rebuild(w.players.values(), w.units.values());
    w.tickUnit(soldier, 0.05, 10000);
    expect(b.hp).toBe(hp - GAME.units.soldier.damage);
  });
  it("does not inspect enemies outside a soldier's spatial combat radius", () => {
    const w = world(),
      a = w.addPlayer("a", "A", 1),
      b = w.addPlayer("b", "B", 2);
    a.money = b.money = 999;
    w.buy("a", "soldier");
    w.buy("b", "robot");
    const soldier = [...w.units.values()].find(
        (u) => u.ownerId === "a" && u.kind === "soldier",
      )!,
      robot = [...w.units.values()].find(
        (u) => u.ownerId === "b" && u.kind === "robot",
      )!;
    robot.x = soldier.x + GAME.units.soldier.detectionRange + 2;
    robot.y = soldier.y;
    const hp = robot.hp;
    w.spatial.rebuild(w.players.values(), w.units.values());
    w.tickUnit(soldier, 0.05, 10000);
    expect(robot.hp).toBe(hp);
  });
  it("uses combat, intermediate and distant simulation frequencies", () => {
    const w = world(),
      a = w.addPlayer("a", "A", 1),
      b = w.addPlayer("b", "B", 2);
    a.money = b.money = 999;
    w.buy("a", "soldier");
    w.buy("b", "robot");
    const soldier = [...w.units.values()].find(
        (u) => u.ownerId === "a" && u.kind === "soldier",
      )!,
      enemy = [...w.units.values()].find(
        (u) => u.ownerId === "b" && u.kind === "robot",
      )!;
    enemy.x = soldier.x + 1;
    enemy.y = soldier.y;
    w.spatial.rebuild(w.players.values(), w.units.values());
    expect(w.simulationInterval(soldier)).toBe(
      GAME.simulation.combatIntervalMs,
    );
    enemy.x = soldier.x + 50;
    w.spatial.rebuild(w.players.values(), w.units.values());
    expect(w.simulationInterval(soldier)).toBe(
      GAME.simulation.intermediateIntervalMs,
    );
    a.isBot = true;
    b.isBot = true;
    expect(w.simulationInterval(soldier)).toBe(
      GAME.simulation.distantIntervalMs,
    );
  });
  it("keeps a valid soldier target cached for one second", () => {
    const w = world(),
      a = w.addPlayer("a", "A", 1),
      b = w.addPlayer("b", "B", 2);
    a.money = b.money = 999;
    w.buy("a", "soldier");
    w.buy("b", "robot");
    const soldier = [...w.units.values()].find(
        (u) => u.ownerId === "a" && u.kind === "soldier",
      )!,
      enemy = [...w.units.values()].find(
        (u) => u.ownerId === "b" && u.kind === "robot",
      )!;
    enemy.x = soldier.x + 1;
    enemy.y = soldier.y;
    w.spatial.rebuild(w.players.values(), w.units.values());
    w.tickUnit(soldier, 0.05, 10000);
    expect(soldier.cachedTargetId).toBe(enemy.id);
    expect(soldier.cachedTargetUntil).toBe(
      10000 + GAME.simulation.targetCacheMs,
    );
    w.tickUnit(soldier, 0.05, 10500);
    expect(soldier.cachedTargetId).toBe(enemy.id);
  });
  it("keeps robots inside map bounds", () => {
    const w = world(),
      p = w.addPlayer("a", "A", 1);
    p.money = 999;
    w.buy("a", "robot");
    const robot = [...w.units.values()].find((u) => u.kind === "robot")!;
    robot.x = -50;
    robot.y = GAME.map.height + 50;
    w.enforceUnitBounds(robot);
    expect(robot.x).toBeGreaterThanOrEqual(0.15);
    expect(robot.y).toBeLessThanOrEqual(GAME.map.height - 0.15);
  });
  it("speed upgrades increase actual server movement", () => {
    const base = world(),
      upgraded = world(),
      a = base.addPlayer("a", "A", 1),
      b = upgraded.addPlayer("b", "B", 2);
    b.money = 999;
    expect(upgraded.buy("b", "speed")).toBe(true);
    a.input = { x: 1, y: 0, attack: false, seq: 1 };
    b.input = { x: 1, y: 0, attack: false, seq: 1 };
    const ax = a.x,
      bx = b.x;
    base.tickPlayer(a, 0.1, 1000);
    upgraded.tickPlayer(b, 0.1, 1000);
    expect(a.x - ax).toBeCloseTo(GAME.player.speed * 0.1);
    expect(b.x - bx).toBeCloseTo(
      GAME.player.speed * (1 + GAME.upgrades.speed.bonus) * 0.1,
    );
  });
  it("armor upgrades immediately increase current and maximum hp", () => {
    const w = world(),
      p = w.addPlayer("a", "A", 1);
    p.money = 999;
    const hp = p.hp,
      maxHp = p.maxHp;
    expect(w.buy("a", "armor")).toBe(true);
    expect(p.hp).toBe(hp + GAME.upgrades.armor.hp);
    expect(p.maxHp).toBe(maxHp + GAME.upgrades.armor.hp);
  });
  it("capture upgrades reduce the real capture duration", () => {
    const w = world(),
      p = w.addPlayer("a", "A", 1);
    p.money = 999;
    expect(w.buy("a", "capture")).toBe(true);
    const t = w.map.get(key(Math.floor(p.x) + 3, Math.floor(p.y)))!;
    t.owner = null;
    p.x += 3;
    w.tickPlayer(p, 0, 1000);
    const upgradedDelay = GAME.capture.holdMs * GAME.capture.improvedMultiplier;
    w.tickPlayer(p, 0, 1000 + upgradedDelay + 1);
    expect(t.owner).toBe("a");
    expect(upgradedDelay).toBeLessThan(GAME.capture.holdMs);
  });
  it("converts a disconnected human to a bot without losing its empire", () => {
    const w = world(),
      p = w.addPlayer("human", "Human", 1),
      unitCount = w.units.size,
      tileCount = w.territoryCounts.get(p.id);
    expect(w.convertPlayerToBot(p.id, "IA relève")).toBe(true);
    expect(w.players.get(p.id)).toMatchObject({
      id: p.id,
      name: "IA relève",
      isBot: true,
    });
    expect(w.units.size).toBe(unitCount);
    expect(w.territoryCounts.get(p.id)).toBe(tileCount);
  });
  it("leaves an evicted bot's assets neutral and frozen", () => {
    const w = world(),
      p = w.addPlayer("bot", "Bot", 1, true);
    p.money = 9999;
    expect(w.buy(p.id, "attacker")).toBe(true);
    expect(
      w.placeBastion(
        p.id,
        Math.floor(p.x),
        Math.floor(p.y),
        "relay",
      ),
    ).toBe(true);
    const ownedTile = w.map.get(key(Math.floor(p.x), Math.floor(p.y)))!,
      previousUnits = [...w.units.values()].filter(
        (unit) => unit.ownerId === p.id,
      ),
      neutralized = w.neutralizePlayer(p.id);
    expect(w.players.has(p.id)).toBe(false);
    expect(ownedTile.owner).toBeNull();
    expect(neutralized).toHaveLength(previousUnits.length);
    for (const unit of previousUnits) {
      expect(unit.ownerId).toBe(NEUTRAL_OWNER_ID);
      expect(unit.nextSimulationAt).toBe(Number.MAX_SAFE_INTEGER);
      const position = [unit.x, unit.y];
      w.tickUnit(unit, 1, Date.now() + 60_000);
      expect([unit.x, unit.y]).toEqual(position);
    }
  });
  it("counts every player's forces with one aggregate result", () => {
    const w = world(),
      a = w.addPlayer("a", "A", 1),
      b = w.addPlayer("b", "B", 2);
    a.money = b.money = 999;
    w.buy(a.id, "robot");
    w.buy(a.id, "defender");
    w.buy(b.id, "attacker");
    expect(w.allCounts().get(a.id)).toMatchObject({
      robots: 1,
      soldiers: 1,
    });
    expect(w.allCounts().get(b.id)).toMatchObject({
      robots: 0,
      soldiers: 1,
    });
    const attacker = [...w.units.values()].find(
      (unit) => unit.ownerId === b.id && unit.kind === "attacker",
    )!;
    w.damageUnit(attacker, 9999);
    expect(w.counts(b.id).soldiers).toBe(0);
    expect(w.networkRemovedUnits.has(attacker.id)).toBe(true);
  });
});
