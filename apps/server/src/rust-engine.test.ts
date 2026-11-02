import { describe, expect, it } from "vitest";
import type { Player, Unit } from "./model.js";
import { RustEngine, rustExecutablePath } from "./rust-engine.js";

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
      expect(secondTick[0].x).toBeGreaterThan(schedules[0].x);
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

  it("patrols a defender without leaving its guard circle", async () => {
    const engine = new RustEngine(),
      defender = {
        id: "u-defender",
        ownerId: "p1",
        kind: "defender",
        x: 10,
        y: 10,
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
      const [patrol] = await engine.schedule(1000, [defender], []);
      expect(Math.hypot(patrol.x - 10, patrol.y - 10)).toBeGreaterThan(0);
      expect(Math.hypot(patrol.x - 10, patrol.y - 10)).toBeLessThan(12);

      defender.x = 21.9;
      defender.y = 10;
      defender.dirX = 1;
      defender.dirY = 0;
      defender.nextThink = 5000;
      defender.nextSimulationAt = 0;
      defender.lastSimulatedAt = 1000;
      const [returned] = await engine.schedule(1500, [defender], []);
      expect(returned.x).toBeLessThan(defender.x);
      expect(Math.hypot(returned.x - 10, returned.y - 10)).toBeLessThan(12);
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
});
