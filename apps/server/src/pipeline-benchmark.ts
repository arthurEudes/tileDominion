import { decode, encode } from "@msgpack/msgpack";
import {
  compactSnapshot,
  expandSnapshot,
  POSITION_SCALE,
  type CompactSnapshot,
  type ServerUnitView,
  type Snapshot,
  type UnitView,
} from "@tile/protocol";
import { performance } from "node:perf_hooks";
import { DominionRoom } from "./room.js";

const counts = (process.env.BENCH_COUNTS ?? "1000,2000,4000,8000,16000,32000")
  .split(",")
  .map(Number)
  .filter((value) => Number.isFinite(value) && value > 0);
const iterations = Number(process.env.BENCH_ITERATIONS ?? 30);
const clientCount = Math.max(1, Number(process.env.BENCH_CLIENTS ?? 50));
const interestGroups = Math.max(
  1,
  Math.min(clientCount, Number(process.env.BENCH_INTEREST_GROUPS ?? 10)),
);

function percentile(values: number[], ratio: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}

function measure(run: () => void) {
  const samples: number[] = [];
  for (let index = 0; index < iterations + 5; index++) {
    const started = performance.now();
    run();
    if (index >= 5) samples.push(performance.now() - started);
  }
  return {
    averageMs: samples.reduce((sum, value) => sum + value, 0) / samples.length,
    p95Ms: percentile(samples, 0.95),
    maxMs: Math.max(...samples),
  };
}

function units(count: number): ServerUnitView[] {
  return Array.from({ length: count }, (_, id) => ({
    id: `u${id}`,
    ownerId: `p${id % 4}`,
    kind: id % 5 === 0 ? "soldier" : "robot",
    x: 80 + (id % 80) * 0.25,
    y: 80 + (Math.floor(id / 80) % 80) * 0.25,
    hp: id % 5 === 0 ? 70 : 45,
    maxHp: id % 5 === 0 ? 70 : 45,
    nextProduce: 0,
  }));
}

function baseSnapshot(allUnits: ServerUnitView[]): Snapshot {
  return {
    now: 1_000_000,
    endsAt: 2_000_000,
    width: 404,
    height: 404,
    players: [],
    units: allUnits,
    tiles: [],
    leaderboard: [],
    globalUnits: allUnits.length,
  };
}

function roomWithoutRuntime() {
  const room = Object.create(DominionRoom.prototype) as DominionRoom;
  room.unitChannels = new Map();
  return room;
}

const results = [];
for (const count of counts) {
  const allUnits = units(count),
    snapshot = baseSnapshot(allUnits),
    server = roomWithoutRuntime(),
    clientUnits = new Map<number, UnitView>(),
    initial = compactSnapshot(
      snapshot,
      server.unitDelta("client", allUnits, true),
    ),
    initialPayload = encode(initial),
    decodedInitial = decode(initialPayload) as CompactSnapshot;
  expandSnapshot(decodedInitial, clientUnits);

  const idleDelta = measure(() => server.unitDelta("client", allUnits));
  let movingWire: CompactSnapshot = initial,
    movingPayload = initialPayload;
  const movingDeltaAndEncode = measure(() => {
    for (const unit of allUnits) unit.x += 1 / POSITION_SCALE;
    movingWire = compactSnapshot(
      snapshot,
      server.unitDelta("client", allUnits),
    );
    movingPayload = encode(movingWire);
  });
  const clientDecodeAndApply = measure(() => {
    expandSnapshot(decode(movingPayload) as CompactSnapshot, clientUnits);
  });
  const fanoutServer = roomWithoutRuntime(),
    clientIds = Array.from({ length: clientCount }, (_, index) => `client-${index}`);
  for (const clientId of clientIds)
    fanoutServer.unitDelta(clientId, allUnits, true);
  let fanoutBytes = 0;
  const multiClientFanout = measure(() => {
    fanoutBytes = 0;
    for (const clientId of clientIds) {
      const wire = compactSnapshot(
        snapshot,
        fanoutServer.unitDelta(clientId, allUnits),
      );
      fanoutBytes += encode(wire).byteLength;
    }
    for (const unit of allUnits) unit.y += 1 / POSITION_SCALE;
  });
  const sharedServer = roomWithoutRuntime(),
    visiblePerCell = Math.ceil(allUnits.length / interestGroups),
    clientsPerCell = Math.ceil(clientCount / interestGroups);
  let sharedFanoutBytes = 0;
  const sharedSpatialFanout = measure(() => {
    sharedFanoutBytes = 0;
    for (let group = 0; group < interestGroups; group++) {
      const visible = allUnits.slice(
          group * visiblePerCell,
          Math.min(allUnits.length, (group + 1) * visiblePerCell),
        ),
        groupSnapshot = baseSnapshot(visible),
        wire = compactSnapshot(
          groupSnapshot,
          sharedServer.unitDelta(`interest:${group}`, visible),
        ),
        bytes = encode(wire).byteLength;
      sharedFanoutBytes += bytes * clientsPerCell;
    }
    for (const unit of allUnits) unit.x += 1 / POSITION_SCALE;
  });
  const result = {
    units: count,
    initialBytes: initialPayload.byteLength,
    movingBytes: movingPayload.byteLength,
    idleDeltaP95Ms: idleDelta.p95Ms,
    movingDeltaEncodeP95Ms: movingDeltaAndEncode.p95Ms,
    clientDecodeApplyP95Ms: clientDecodeAndApply.p95Ms,
    clients: clientCount,
    fanoutBytes,
    multiClientFanoutP95Ms: multiClientFanout.p95Ms,
    interestGroups,
    visiblePerCell,
    sharedFanoutBytes,
    sharedSpatialFanoutP95Ms: sharedSpatialFanout.p95Ms,
  };
  results.push(result);
  console.log(JSON.stringify(result));
}
console.table(results);
