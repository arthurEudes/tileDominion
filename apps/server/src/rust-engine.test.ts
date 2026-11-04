import { describe, expect, it } from "vitest";
import type { Player, Unit } from "./model.js";
import { RustEngine, rustExecutablePath } from "./rust-engine.js";
import { GAME } from "@tile/game-config";
import { decode } from "@msgpack/msgpack";

describe("Rust engine executable", () => {
  it("uses the native executable name on Windows", () => {
    expect(rustExecutablePath("win32")).toMatch(
      /tile-dominion-simulation\.exe$/,
    );
  });

  it("uses the extensionless executable name on Unix", () => {
    expect(rustExecutablePath("linux")).toMatch(
      /tile-dominion-simulation$/,
    );
  });

  it("exchanges a framed MessagePack tick with the native engine", async () => {
    const engine = new RustEngine();
    const soldier = {
      id: "u1",
      ownerId: "p1",
      kind: "soldier",
      x: 10,
      y: 10,
      dirX: 1,
      dirY: 0,
      order: "wander",
      orderX: 10,
      orderY: 10,
      nextThink: 0,
      hp: 70,
      nextSimulationAt: 0,
      lastSimulatedAt: 900,
      cachedTargetId: "",
      cachedTargetUntil: 0,
    } as Unit;
    const enemy = {
      id: "p2",
      x: 11,
      y: 10,
      alive: true,
      isBot: false,
      invulnerableUntil: 0,
    } as Player;

    try {
      const schedules = await engine.schedule(1000, [soldier], [enemy]);
      expect(schedules).toHaveLength(1);
      expect(schedules[0]).toMatchObject({
        id: "u1",
        interval_ms: 50,
        target_id: "p2",
        next_simulation_at: 1050,
      });
      soldier.nextSimulationAt = 1050;
      soldier.lastSimulatedAt = 1000;
      soldier.x = schedules[0].x;
      soldier.y = schedules[0].y;
      soldier.dirX = schedules[0].dir_x;
      soldier.dirY = schedules[0].dir_y;
      const secondTick = await engine.schedule(1050, [soldier], [enemy]);
      expect(secondTick).toHaveLength(1);
      expect(secondTick[0].x).toBe(schedules[0].x);
      expect([secondTick[0].dir_x, secondTick[0].dir_y]).toEqual([0, 0]);
    } finally {
      engine.close();
    }
  });

  it("returns client-ready opaque unit frames without mirrored schedules", async () => {
    const engine = new RustEngine();
    const robot = {
      id: "opaque-unit", ownerId: "opaque-owner", kind: "robot",
      x: 10.5, y: 11.5, hp: 45, dirX: 0, dirY: 0, order: "wander",
      orderX: 10.5, orderY: 11.5, nextThink: 0, nextSimulationAt: 0,
      lastSimulatedAt: 0, cachedTargetId: "", cachedTargetUntil: 0,
    } as Unit;
    try {
      engine.setNetworkCells([[0, 0, true]]);
      const result = await engine.scheduleDeltaWithEvents(
        1000,
        [robot],
        [],
        [],
        [],
        undefined,
        [],
        undefined,
        undefined,
        false,
      );
      expect(result.schedules).toEqual([]);
      expect(result.networkZones).toHaveLength(1);
      expect(result.networkZones[0].frame).toBeInstanceOf(Uint8Array);
      const frame = decode(result.networkZones[0].frame) as [unknown[], unknown[], unknown[], boolean];
      expect(frame[0]).toHaveLength(1);
      expect(frame[3]).toBe(true);
      expect(engine.idMappings()).toEqual(expect.arrayContaining([
        expect.arrayContaining([expect.any(Number), robot.id]),
        expect.arrayContaining([expect.any(Number), robot.ownerId]),
      ]));
    } finally {
      engine.close();
    }
  });

  it("moves a purchased robot away from allied spawn territory", async () => {
    const engine = new RustEngine(),
      map = new Map<string, { owner: string | null; obstacle: boolean }>();
    for (let y = 0; y < 202; y++)
      for (let x = 0; x < 202; x++)
        map.set(`${x},${y}`, {
          owner: x >= 8 && x <= 12 && y >= 8 && y <= 12 ? "p1" : null,
          obstacle: false,
        });
    const robot = {
        id: "u1",
        ownerId: "p1",
        kind: "robot",
        x: 10.5,
        y: 10.5,
        hp: 45,
        dirX: 1,
        dirY: 0,
        order: "wander",
        orderX: 10.5,
        orderY: 10.5,
        nextThink: 0,
        nextSimulationAt: 0,
        lastSimulatedAt: 900,
        cachedTargetId: "",
        cachedTargetUntil: 0,
      } as Unit,
      owner = {
        id: "p1",
        x: 10.5,
        y: 10.5,
        alive: true,
        isBot: false,
        invulnerableUntil: 0,
      } as Player;
    try {
      const [schedule] = await engine.schedule(1000, [robot], [owner], map);
      expect(Math.hypot(schedule.x - robot.x, schedule.y - robot.y)).toBeGreaterThan(0.1);
    } finally {
      engine.close();
    }
  });

  it("holds a robot only until its Rust-authoritative capture completes", async () => {
    const engine = new RustEngine(),
      robot = {
        id: "capturing-robot", ownerId: "p1", kind: "robot",
        x: 10.5, y: 10.5, hp: 45, dirX: 1, dirY: 0, order: "wander",
        orderX: 10.5, orderY: 10.5, nextThink: 0, nextSimulationAt: 0,
        lastSimulatedAt: 900, cachedTargetId: "", cachedTargetUntil: 0,
        captureKey: "", captureSince: 0,
      } as Unit,
      map = new Map([["10,10", { owner: null, obstacle: false }]]);
    try {
      const first = await engine.scheduleDeltaWithEvents(
        1000, [robot], [], [], [], map,
      );
      expect(first.schedules[0]).toMatchObject({ x: robot.x, y: robot.y });

      const completed = await engine.scheduleDeltaWithEvents(
        1000 + GAME.capture.holdMs * GAME.capture.robotMultiplier + 1,
        [], [], [], [],
      );
      expect(completed.events).toContainEqual(expect.objectContaining({
        kind: 0, entityId: robot.id, ownerId: robot.ownerId,
      }));

      const resumed = await engine.scheduleDeltaWithEvents(10000, [], [], [], []);
      const schedule = resumed.schedules.find(({ id }) => id === robot.id)!;
      expect(Math.hypot(schedule.x - robot.x, schedule.y - robot.y)).toBeGreaterThan(0);
    } finally {
      engine.close();
    }
  });

  it("moves players and completes their captures authoritatively in Rust", async () => {
    const engine = new RustEngine(),
      map = new Map<string, { owner: string | null; obstacle: boolean }>([
        ["10,10", { owner: null, obstacle: false }],
      ]),
      player = {
        id: "player-rust", name: "Rust", x: 10.5, y: 10.5,
        color: 1, hp: 100, maxHp: 100, money: 0, kills: 0,
        alive: true, isBot: false,
        input: { x: 0, y: 0, attack: false, seq: 1 },
        captureKey: "", captureSince: 0, lastAttack: 0,
        invulnerableUntil: 0,
        upgrades: { speed: 0, armor: 0, capture: 0 },
      } satisfies Player;
    try {
      const first = await engine.scheduleDeltaWithEvents(
        1000, [], [], [player], [], map,
      );
      expect(first.players[0].captureKey).toBe("10,10");
      player.captureKey = first.players[0].captureKey;
      player.captureSince = first.players[0].captureSince;
      const second = await engine.scheduleDeltaWithEvents(
        1600, [], [], [player], [], map,
      );
      expect(second.events).toContainEqual(expect.objectContaining({
        kind: 0, ownerId: player.id, tileIndex: 10 * GAME.map.width + 10,
      }));
    } finally {
      engine.close();
    }
  });

  it("makes Rust authoritative for turret targeting and cooldown", async () => {
    const engine = new RustEngine();
    const turret = {
      id: "turret", ownerId: "p1", kind: "bastion", bastionType: "turret",
      x: 10, y: 10, hp: 360, dirX: 0, dirY: 0, order: "wander",
      orderX: 10, orderY: 10, nextThink: 0, nextSimulationAt: 0,
      lastSimulatedAt: 0, lastAttack: 0, cachedTargetId: "", cachedTargetUntil: 0,
    } as Unit;
    const enemy = {
      id: "enemy", ownerId: "p2", kind: "robot", x: 12, y: 10, hp: 45,
      dirX: 0, dirY: 0, order: "wander", orderX: 12, orderY: 10,
      nextThink: Number.MAX_SAFE_INTEGER, nextSimulationAt: 0, lastSimulatedAt: 0,
      cachedTargetId: "", cachedTargetUntil: 0,
    } as Unit;
    try {
      const first = await engine.scheduleDeltaWithEvents(
        2000, [turret, enemy], [], [], [],
      );
      expect(first.events).toContainEqual(expect.objectContaining({
        kind: 1, entityId: "turret", targetId: "enemy",
        amount: GAME.units.bastion.turretDamage,
      }));
      expect(first.schedules.find(({ id }) => id === "turret")?.last_attack).toBe(2000);

      const second = await engine.scheduleDeltaWithEvents(2001, [], [], [], []);
      expect(second.events).not.toContainEqual(expect.objectContaining({ entityId: "turret" }));
    } finally {
      engine.close();
    }
  });

  it("replaces a stale soldier direction with its follow order", async () => {
    const engine = new RustEngine(),
      soldier = {
        id: "u-follow",
        ownerId: "p1",
        kind: "soldier",
        x: 10,
        y: 10,
        hp: 70,
        dirX: 1,
        dirY: 0,
        order: "follow",
        orderX: 10,
        orderY: 10,
        nextThink: 0,
        nextSimulationAt: 0,
        lastSimulatedAt: 900,
        cachedTargetId: "old-enemy",
        cachedTargetUntil: 2000,
      } as Unit,
      owner = {
        id: "p1",
        x: 6,
        y: 10,
        alive: true,
        isBot: false,
        invulnerableUntil: 0,
      } as Player;
    try {
      const [schedule] = await engine.schedule(1000, [soldier], [owner]);
      expect(schedule.target_id).toBeNull();
      expect(schedule.dir_x).toBeLessThan(0);
      expect(schedule.x).toBeLessThan(soldier.x);
    } finally {
      engine.close();
    }
  });

  it("keeps defenders on allied territory and returns isolated defenders", async () => {
    const engine = new RustEngine(),
      map = new Map([["10,10", { owner: "p1", obstacle: false }]]),
      defender = {
        id: "u-defender",
        ownerId: "p1",
        kind: "defender",
        x: 10.5,
        y: 10.5,
        hp: 210,
        dirX: 1,
        dirY: 0,
        order: "guard",
        orderX: 10,
        orderY: 10,
        nextThink: 0,
        nextSimulationAt: 0,
        lastSimulatedAt: 500,
        cachedTargetId: "",
        cachedTargetUntil: 0,
      } as Unit;
    try {
      const [patrol] = await engine.schedule(1000, [defender], [], map);
      expect(Math.floor(patrol.x)).toBe(10);
      expect(Math.floor(patrol.y)).toBe(10);

      defender.x = 12.5;
      defender.y = 10.5;
      defender.dirX = 1;
      defender.dirY = 0;
      defender.nextThink = 5000;
      defender.nextSimulationAt = 0;
      defender.lastSimulatedAt = 1000;
      const [returned] = await engine.schedule(1500, [defender], []);
      expect(returned.x).toBeLessThan(defender.x);
    } finally {
      engine.close();
    }
  });

  it("lets defenders leave allied territory for a target then return", async () => {
    const engine = new RustEngine(),
      map = new Map([["10,10", { owner: "p1", obstacle: false }]]),
      defender = {
        id: "sortie-defender", ownerId: "p1", kind: "defender",
        x: 10.5, y: 10.5, hp: 210, dirX: 1, dirY: 0,
        order: "guard", orderX: 10.5, orderY: 10.5,
        homeX: 10.5, homeY: 10.5, nextThink: 0,
        nextSimulationAt: 0, lastSimulatedAt: 500,
        cachedTargetId: "", cachedTargetUntil: 0,
      } as Unit,
      enemy = {
        id: "sortie-target", ownerId: "p2", kind: "robot",
        x: 14.5, y: 10.5, hp: 45, dirX: 0, dirY: 0,
        order: "wander", orderX: 14.5, orderY: 10.5,
        nextThink: Number.MAX_SAFE_INTEGER, nextSimulationAt: 0,
        lastSimulatedAt: 500, cachedTargetId: "", cachedTargetUntil: 0,
      } as Unit;
    try {
      const first = await engine.schedule(1000, [defender, enemy], [], map),
        sortie = first.find(({ id }) => id === defender.id)!;
      expect(sortie.target_id).toBe(enemy.id);
      expect(sortie.x).toBeGreaterThan(11);

      const second = await engine.scheduleDeltaWithEvents(
          1500, [], [enemy.id], [], [],
        ),
        returned = second.schedules.find(({ id }) => id === defender.id)!;
      expect(returned.target_id).toBeNull();
      expect(returned.x).toBeLessThan(sortie.x);
    } finally {
      engine.close();
    }
  });

  it("lets a defender patrol beyond its former leash on allied territory", async () => {
    const engine = new RustEngine(),
      map = new Map<string, { owner: string | null; obstacle: boolean }>();
    for (let x = 10; x <= 22; x++)
      map.set(`${x},10`, { owner: "p1", obstacle: false });
    const defender = {
      id: "patrol-edge", ownerId: "p1", kind: "defender",
      x: 21.5, y: 10.5, hp: 210, dirX: 1, dirY: 0,
      order: "guard", orderX: 10.5, orderY: 10.5,
      homeX: 10.5, homeY: 10.5, nextThink: 5000,
      nextSimulationAt: 0, lastSimulatedAt: 500,
      cachedTargetId: "", cachedTargetUntil: 5000,
    } as Unit;
    try {
      const [schedule] = await engine.schedule(1000, [defender], [], map);
      expect(schedule.x).toBeGreaterThan(defender.x);
      expect(schedule.dir_x).toBeGreaterThan(0);
    } finally {
      engine.close();
    }
  });

  it("does not turn a zero defender direction into an eastward drift", async () => {
    const engine = new RustEngine(),
      defender = {
        id: "stationary-defender", ownerId: "p1", kind: "defender",
        x: 10.5, y: 10.5, hp: 210, dirX: 0, dirY: 0,
        order: "guard", orderX: 10.5, orderY: 10.5,
        homeX: 10.5, homeY: 10.5, nextThink: 5000,
        nextSimulationAt: 0, lastSimulatedAt: 500,
        cachedTargetId: "", cachedTargetUntil: 5000,
      } as Unit;
    try {
      const [schedule] = await engine.schedule(1000, [defender], []);
      expect(schedule.x).toBe(defender.x);
      expect(schedule.y).toBe(defender.y);
    } finally {
      engine.close();
    }
  });

  it("stops a defender that already has its target in range", async () => {
    const engine = new RustEngine(),
      defender = {
        id: "ranged-defender", ownerId: "p1", kind: "defender",
        x: 10.5, y: 10.5, hp: 210, dirX: 1, dirY: 0,
        order: "guard", orderX: 10.5, orderY: 10.5,
        homeX: 10.5, homeY: 10.5, nextThink: 0,
        nextSimulationAt: 0, lastSimulatedAt: 500,
        cachedTargetId: "ranged-target", cachedTargetUntil: 5000,
        lastAttack: 900,
      } as Unit,
      target = {
        id: "ranged-target", ownerId: "p2", kind: "robot",
        x: 12.5, y: 10.5, hp: 45, dirX: 0, dirY: 0,
        order: "wander", orderX: 12.5, orderY: 10.5,
        nextThink: Number.MAX_SAFE_INTEGER,
        nextSimulationAt: Number.MAX_SAFE_INTEGER, lastSimulatedAt: 500,
        cachedTargetId: "", cachedTargetUntil: 0,
      } as Unit;
    try {
      const schedules = await engine.schedule(
          1000,
          [defender, target],
          [],
          new Map([["10,10", { owner: "p1", obstacle: false }]]),
        ),
        schedule = schedules.find(({ id }) => id === defender.id)!;
      expect(schedule.target_id).toBe(target.id);
      expect(schedule.x).toBe(defender.x);
      expect(schedule.y).toBe(defender.y);
      expect([schedule.dir_x, schedule.dir_y]).toEqual([0, 0]);
    } finally {
      engine.close();
    }
  });

  it("never moves a unit into a wall tile", async () => {
    const engine = new RustEngine(),
      soldier = {
        id: "soldier-wall-test",
        ownerId: "p1",
        kind: "soldier",
        x: 10.2,
        y: 10.5,
        hp: 70,
        dirX: 1,
        dirY: 0,
        order: "wander",
        orderX: 10.2,
        orderY: 10.5,
        nextThink: 5000,
        nextSimulationAt: 0,
        lastSimulatedAt: 500,
        cachedTargetId: "",
        cachedTargetUntil: 5000,
      } as Unit,
      wall = {
        ...soldier,
        id: "wall",
        ownerId: "p1",
        kind: "bastion",
        bastionType: "wall",
        x: 11.5,
        y: 10.5,
        hp: 750,
        dirX: 0,
        nextThink: Number.MAX_SAFE_INTEGER,
      } as Unit;
    try {
      const schedules = await engine.schedule(
        1000,
        [soldier, wall],
        [],
        new Map(),
      );
      const moved = schedules.find(({ id }) => id === soldier.id)!;
      expect([Math.floor(moved.x), Math.floor(moved.y)]).not.toEqual([11, 10]);
    } finally {
      engine.close();
    }
  });

  it("does not make a wandering soldier acquire a distant enemy", async () => {
    const engine = new RustEngine(),
      soldier = {
        id: "u-wander",
        ownerId: "p1",
        kind: "soldier",
        x: 30,
        y: 10,
        hp: 70,
        dirX: 1,
        dirY: 0,
        order: "wander",
        orderX: 30,
        orderY: 10,
        nextThink: 0,
        nextSimulationAt: 0,
        lastSimulatedAt: 900,
        cachedTargetId: "",
        cachedTargetUntil: 0,
      } as Unit,
      farEnemy = {
        ...soldier,
        id: "u-enemy",
        ownerId: "p2",
        kind: "headquarters",
        x: 100,
        dirX: 0,
      } as Unit,
      owner = {
        id: "p1",
        x: 10,
        y: 10,
        alive: true,
        isBot: false,
        invulnerableUntil: 0,
      } as Player;
    try {
      const schedules = await engine.schedule(
        1000,
        [soldier, farEnemy],
        [owner],
      );
      const schedule = schedules.find(({ id }) => id === soldier.id)!;
      expect(schedule.target_id).toBeNull();
      expect(Math.hypot(schedule.dir_x, schedule.dir_y)).toBeCloseTo(1);
    } finally {
      engine.close();
    }
  });

  it("releases removed unit identifiers after Rust acknowledges them", async () => {
    const engine = new RustEngine(),
      robot = {
        id: "temporary-unit",
        ownerId: "p1",
        kind: "robot",
        x: 10,
        y: 10,
        hp: 45,
        dirX: 1,
        dirY: 0,
        order: "wander",
        orderX: 10,
        orderY: 10,
        nextThink: 0,
        nextSimulationAt: 0,
        lastSimulatedAt: 0,
        cachedTargetId: "",
        cachedTargetUntil: 0,
      } as Unit;
    try {
      await engine.scheduleDelta(1000, [robot], [], [], []);
      await engine.scheduleDelta(1050, [], [robot.id], [], []);
      const ids = (
        engine as unknown as { idNumbers: Map<string, number> }
      ).idNumbers;
      expect(ids.has(robot.id)).toBe(false);
      expect(ids.has(robot.ownerId)).toBe(true);
    } finally {
      engine.close();
    }
  });

  it("keeps an attacker locked through the Node to Rust protocol", async () => {
    const engine = new RustEngine(),
      attacker = {
        id: "attacker",
        ownerId: "p1",
        kind: "attacker",
        x: 10,
        y: 10,
        hp: 70,
        dirX: 1,
        dirY: 0,
        order: "wander",
        orderX: 10,
        orderY: 10,
        nextThink: 0,
        nextSimulationAt: 0,
        lastSimulatedAt: 900,
        cachedTargetId: "",
        cachedTargetUntil: 0,
      } as Unit,
      target = {
        ...attacker,
        id: "target",
        ownerId: "p2",
        kind: "robot",
        x: 11,
        hp: 45,
      } as Unit;
    try {
      const first = await engine.schedule(1000, [attacker, target], []);
      const attackSchedule = first.find(({ id }) => id === attacker.id)!;
      expect(attackSchedule.target_id).toBe(target.id);
      attacker.cachedTargetId = target.id;
      attacker.cachedTargetUntil = 3000;
      attacker.nextSimulationAt = 1050;
      attacker.lastSimulatedAt = 1000;
      target.x = 100;
      target.nextSimulationAt = 1050;
      target.lastSimulatedAt = 1000;
      const second = await engine.schedule(1050, [attacker, target], []);
      expect(second.find(({ id }) => id === attacker.id)?.target_id).toBe(
        target.id,
      );
    } finally {
      engine.close();
    }
  });

  it("returns correlated combat events and transport metrics", async () => {
    const engine = new RustEngine(),
      attacker = {
        id: "event-attacker", ownerId: "p1", kind: "soldier",
        x: 10, y: 10, hp: 70, dirX: 1, dirY: 0, order: "wander",
        orderX: 10, orderY: 10, nextThink: 0, nextSimulationAt: 0,
        lastSimulatedAt: 900, cachedTargetId: "", cachedTargetUntil: 0,
        lastAttack: 0, captureKey: "", captureSince: 0, nextProduce: 0,
      } as Unit,
      target = {
        ...attacker, id: "event-target", ownerId: "p2", kind: "robot", x: 11,
      } as Unit;
    try {
      const result = await engine.scheduleDeltaWithEvents(
        1000, [attacker, target], [], [], [],
      );
      expect(result.events).toContainEqual(expect.objectContaining({
        kind: 1,
        entityId: attacker.id,
        targetId: target.id,
        amount: GAME.units.soldier.damage,
      }));
      expect(engine.transportMetrics).toMatchObject({
        inFlight: 0,
        completed: 1,
        timedOut: 0,
      });
    } finally {
      engine.close();
    }
  });

  it("removes a lethally damaged unit from the authoritative Rust world", async () => {
    const engine = new RustEngine(),
      attacker = {
        id: "killer", ownerId: "p1", kind: "soldier", x: 10, y: 10,
        hp: 70, dirX: 1, dirY: 0, order: "wander", orderX: 10, orderY: 10,
        nextThink: 0, nextSimulationAt: 0, lastSimulatedAt: 900,
        cachedTargetId: "", cachedTargetUntil: 0, lastAttack: 0,
      } as Unit,
      target = {
        ...attacker, id: "victim", ownerId: "p2", kind: "robot", x: 11, hp: 5,
      } as Unit;
    try {
      const result = await engine.scheduleDeltaWithEvents(
        1000, [attacker, target], [], [], [],
      );
      expect(result.events).toContainEqual(expect.objectContaining({
        kind: 3, entityId: "killer", targetId: "victim",
      }));

      const following = await engine.scheduleDeltaWithEvents(2000, [], [], [], []);
      expect(following.schedules.some(({ id }) => id === "victim")).toBe(false);
    } finally {
      engine.close();
    }
  });

  it("computes allied-territory damage reduction inside Rust", async () => {
    const engine = new RustEngine(),
      attacker = {
        id: "armor-attacker", ownerId: "p1", kind: "soldier", x: 10, y: 10,
        hp: 70, dirX: 1, dirY: 0, order: "wander", orderX: 10, orderY: 10,
        nextThink: 0, nextSimulationAt: 0, lastSimulatedAt: 900,
        cachedTargetId: "", cachedTargetUntil: 0, lastAttack: 0,
      } as Unit,
      target = {
        ...attacker, id: "armored-target", ownerId: "p2", kind: "robot", x: 11,
        hp: 45, nextSimulationAt: 2000,
      } as Unit,
      map = new Map([["11,10", { owner: "p2", obstacle: false }]]);
    try {
      const result = await engine.scheduleDeltaWithEvents(
        1000, [attacker, target], [], [], [], map,
      );
      expect(result.events).toContainEqual(expect.objectContaining({
        kind: 1,
        targetId: target.id,
        amount: GAME.units.soldier.damage * 0.5,
      }));
    } finally {
      engine.close();
    }
  });

  it("returns unit production events from the persistent Rust state", async () => {
    const engine = new RustEngine(),
      factory = {
        id: "factory", ownerId: "p1", kind: "bastion", bastionType: "factory",
        x: 10.5, y: 10.5, hp: 420, dirX: 0, dirY: 0, order: "guard",
        orderX: 10.5, orderY: 10.5, nextThink: Number.MAX_SAFE_INTEGER,
        nextSimulationAt: 0, lastSimulatedAt: 0, cachedTargetId: "",
        cachedTargetUntil: 0, lastAttack: 0, captureKey: "", captureSince: 0,
        nextProduce: 1000,
      } as Unit;
    try {
      const result = await engine.scheduleDeltaWithEvents(
        1000, [factory], [], [], [],
      );
      expect(result.events).toContainEqual(expect.objectContaining({
        kind: 2,
        entityId: factory.id,
        ownerId: factory.ownerId,
        tileIndex: 0,
      }));
    } finally {
      engine.close();
    }
  });
});
