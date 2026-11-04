import { performance } from "node:perf_hooks";
import { GAME } from "@tile/game-config";
import { World } from "./world.js";
import { RustEngine } from "./rust-engine.js";
import { key, type Unit } from "./model.js";

const counts = (process.env.BENCH_COUNTS ?? "1000,2000,4000,8000")
    .split(",")
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0),
  playerCount = Math.max(2, Number(process.env.BENCH_PLAYERS ?? 20)),
  ticks = Math.max(10, Number(process.env.BENCH_TICKS ?? 80)),
  warmupTicks = Math.min(ticks - 1, Number(process.env.BENCH_WARMUP ?? 20));

function percentile(values: number[], ratio: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}

function unit(id: string, ownerId: string, kind: Unit["kind"], index: number): Unit {
  const pair = Math.floor(index / 2),
    x = 20 + (pair % 100) * 2,
    y = 20 + (Math.floor(pair / 100) % 100) * 2,
    combat = kind === "soldier" || kind === "attacker" || kind === "defender";
  return {
    id,
    ownerId,
    kind,
    x: x + (index % 2) * 0.4,
    y,
    // Keep the population stable while still exercising real damage events.
    hp: kind === "bastion" ? GAME.units.bastion.hp : 1_000_000,
    dirX: 1,
    dirY: 0,
    nextThink: 0,
    lastAttack: 0,
    captureKey: "",
    captureSince: 0,
    nextProduce: 0,
    order: combat ? "attack" : "wander",
    orderX: x,
    orderY: y,
    nextSimulationAt: 0,
    lastSimulatedAt: 0,
    cachedTargetId: "",
    cachedTargetUntil: 0,
  };
}

async function run(unitCount: number) {
  const world = new World(),
    engine = new RustEngine(),
    players = Array.from({ length: playerCount }, (_, index) =>
      world.addPlayer(`bench-p${index}`, `P${index}`, index),
    );
  for (const tile of world.map.values()) {
    tile.obstacle = false;
    tile.owner = null;
  }
  world.dirtyTiles.clear();
  world.rustDirtyTiles.clear();
  world.units.clear();
  world.rustDirtyUnits.clear();
  for (let index = 0; index < unitCount; index++) {
    const kind = index % 4 === 0 ? "robot" : index % 4 === 1 ? "soldier" : index % 4 === 2 ? "attacker" : "defender",
      created = unit(`bench-u${index}`, players[index % playerCount].id, kind, index);
    world.units.set(created.id, created);
    world.rustDirtyUnits.set(created.id, index + 1);
  }
  const buildingCount = Math.max(1, Math.floor(unitCount / 500));
  for (let index = 0; index < buildingCount; index++) {
    const owner = players[index % playerCount],
      created = unit(`bench-f${index}`, owner.id, "bastion", unitCount + index);
    created.bastionType = index % 2 ? "fortress" : "factory";
    created.nextProduce = 1_000_000;
    created.order = "guard";
    world.units.set(created.id, created);
    world.rustDirtyUnits.set(created.id, unitCount + index + 1);
    const tile = world.map.get(key(Math.floor(created.x), Math.floor(created.y)));
    if (tile) tile.owner = owner.id;
  }
  const samples: number[] = [],
    heapSamples: number[] = [];
  let now = 1_000_000;
  try {
    for (let tick = 0; tick < ticks; tick++) {
      const started = performance.now();
      await world.tickWithRust(engine, 0.05, now, false);
      const elapsed = performance.now() - started;
      if (tick >= warmupTicks) {
        samples.push(elapsed);
        heapSamples.push(process.memoryUsage().heapUsed);
      }
      now += 50;
    }
  } finally {
    engine.close();
  }
  return {
    unitsRequested: unitCount,
    unitsFinal: world.units.size,
    players: playerCount,
    averageMs: samples.reduce((sum, value) => sum + value, 0) / samples.length,
    p95Ms: percentile(samples, 0.95),
    p99Ms: percentile(samples, 0.99),
    maxMs: Math.max(...samples),
    heapPeakMb: Math.max(...heapSamples) / 1024 / 1024,
    rust: engine.lastMetrics,
    transport: engine.transportMetrics,
  };
}

const results = [];
for (const count of counts) {
  const result = await run(count);
  results.push(result);
  console.log(JSON.stringify(result));
}
console.table(results);
