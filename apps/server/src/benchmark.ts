import { performance } from "node:perf_hooks";
import { GAME } from "@tile/game-config";
import type { Player, Unit } from "./model.js";
import { RustEngine } from "./rust-engine.js";

type Scenario = "robots" | "combat";

const map = new Map<string, { owner: string | null; obstacle: boolean }>();
for (let y = 0; y < GAME.map.height; y++)
  for (let x = 0; x < GAME.map.width; x++)
    map.set(`${x},${y}`, {
      owner: (x + y) % 2 ? "p1" : "p0",
      obstacle: false,
    });

function player(id: string, x: number, y: number): Player {
  return {
    id,
    name: id,
    x,
    y,
    color: 0,
    hp: 100,
    maxHp: 100,
    money: 0,
    kills: 0,
    alive: true,
    isBot: false,
    input: { x: 0, y: 0, attack: false, seq: 0 },
    captureKey: "",
    captureSince: 0,
    lastAttack: 0,
    invulnerableUntil: 0,
    upgrades: { speed: 0, armor: 0, capture: 0 },
  };
}

function units(count: number, scenario: Scenario): Unit[] {
  return Array.from({ length: count }, (_, index) => {
    const ownerId = `p${index % 2}`,
      pair = Math.floor(index / 2),
      x = scenario === "combat" ? 4 + (pair % 62) * 3 : 72 + (index % 56),
      y = scenario === "combat" ? 4 + (Math.floor(pair / 62) % 62) * 3 : 72 + (Math.floor(index / 56) % 56),
      kind = scenario === "combat" ? "soldier" : "robot";
    return {
      id: `u${index}`,
      ownerId,
      kind,
      x: x + (index % 2) * 0.3,
      y,
      hp: kind === "soldier" ? 70 : 45,
      dirX: 1,
      dirY: 0,
      nextThink: 0,
      lastAttack: 0,
      captureKey: "",
      captureSince: 0,
      nextProduce: 0,
      order: "wander",
      orderX: x,
      orderY: y,
      nextSimulationAt: 0,
      lastSimulatedAt: 0,
      cachedTargetId: "",
      cachedTargetUntil: 0,
    };
  });
}

function percentile(values: number[], ratio: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}

async function run(count: number, scenario: Scenario) {
  const engine = new RustEngine(),
    allUnits = units(count, scenario),
    players = [player("p0", 100, 100), player("p1", 101, 100)],
    samples: number[] = [],
    phases = {
      decode: [] as number[],
      sync: [] as number[],
      schedule: [] as number[],
      movement: [] as number[],
      nodeIpc: [] as number[],
    };
  let now = 1_000_000;
  try {
    for (let tick = 0; tick < 100; tick++) {
      const started = performance.now(),
        schedules = await engine.scheduleDelta(
          now,
          tick === 0 ? allUnits : [],
          [],
          players,
          [],
          map,
        );
      const elapsed = performance.now() - started;
      if (tick >= 20) {
        samples.push(elapsed);
        const metrics = engine.lastMetrics!;
        phases.decode.push(metrics.decode_us / 1000);
        phases.sync.push(metrics.sync_us / 1000);
        phases.schedule.push(metrics.schedule_us / 1000);
        phases.movement.push(metrics.movement_us / 1000);
        phases.nodeIpc.push(
          Math.max(
            0,
            elapsed -
              (metrics.decode_us +
                metrics.sync_us +
                metrics.schedule_us +
                metrics.movement_us) /
                1000,
          ),
        );
      }
      const byId = new Map(allUnits.map((unit) => [unit.id, unit]));
      for (const schedule of schedules) {
        const unit = byId.get(schedule.id)!;
        unit.x = schedule.x;
        unit.y = schedule.y;
        unit.dirX = schedule.dir_x;
        unit.dirY = schedule.dir_y;
        unit.nextThink = schedule.next_think;
        unit.nextSimulationAt = schedule.next_simulation_at;
        unit.lastSimulatedAt = now;
        unit.cachedTargetId = schedule.target_id ?? "";
      }
      now += 50;
    }
  } finally {
    engine.close();
  }
  return {
    scenario,
    units: count,
    averageMs: samples.reduce((sum, value) => sum + value, 0) / samples.length,
    p95Ms: percentile(samples, 0.95),
    maxMs: Math.max(...samples),
    decodeMs: phases.decode.reduce((a, b) => a + b, 0) / samples.length,
    syncMs: phases.sync.reduce((a, b) => a + b, 0) / samples.length,
    scheduleMs: phases.schedule.reduce((a, b) => a + b, 0) / samples.length,
    movementMs: phases.movement.reduce((a, b) => a + b, 0) / samples.length,
    nodeIpcMs: phases.nodeIpc.reduce((a, b) => a + b, 0) / samples.length,
  };
}

const results = [];
const counts = (process.env.BENCH_COUNTS ?? "500,1000,2000,4000")
  .split(",")
  .map(Number)
  .filter((value) => Number.isFinite(value) && value > 0);
for (const scenario of ["robots", "combat"] as const)
  for (const count of counts) {
    const result = await run(count, scenario);
    results.push(result);
    console.log(JSON.stringify(result));
  }
console.table(results);

const inFlight = Math.max(2, Number(process.env.BENCH_IN_FLIGHT ?? 8)),
  saturationCount = counts[counts.length - 1],
  saturationEngine = new RustEngine(),
  saturationUnits = units(saturationCount, "combat"),
  saturationPlayers = [player("p0", 100, 100), player("p1", 101, 100)];
try {
  const started = performance.now();
  const settled = await Promise.allSettled(
    Array.from({ length: inFlight }, (_, index) =>
      saturationEngine.scheduleDeltaWithEvents(
        2_000_000 + index * 50,
        index === 0 ? saturationUnits : [],
        [],
        saturationPlayers,
        [],
        index === 0 ? map : undefined,
      ),
    ),
  );
  console.log(JSON.stringify({
    scenario: "transport-saturation",
    units: saturationCount,
    requests: inFlight,
    elapsedMs: performance.now() - started,
    completedRequests: settled.filter(({ status }) => status === "fulfilled").length,
    failedRequests: settled.filter(({ status }) => status === "rejected").length,
    ...saturationEngine.transportMetrics,
  }));
} finally {
  saturationEngine.close();
}
