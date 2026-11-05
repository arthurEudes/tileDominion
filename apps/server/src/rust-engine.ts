import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { decode, encode } from "@msgpack/msgpack";
import { GAME } from "@tile/game-config";
import type { Player, Unit } from "./model.js";

export const RUST_PROTOCOL_VERSION = 7;
const DEFAULT_REQUEST_TIMEOUT_MS = 500;

export function rustExecutablePath(platform = process.platform) {
  const filename = `tile-dominion-simulation${platform === "win32" ? ".exe" : ""}`;
  return fileURLToPath(
    new URL(`../../simulation-rust/target/release/${filename}`, import.meta.url),
  );
}

export type RustSchedule = {
  id: string;
  dt: number;
  interval_ms: number;
  target_id: string | null;
  next_simulation_at: number;
  x: number;
  y: number;
  dir_x: number;
  dir_y: number;
  next_think: number;
  last_attack: number;
};

export type RustMetrics = {
  decode_us: number;
  sync_us: number;
  schedule_us: number;
  movement_us: number;
};

export type RustSimulationEvent = {
  kind: number;
  entityId: string | null;
  targetId: string | null;
  tileIndex: number;
  amount: number;
  ownerId: string | null;
};

export type RustTickResult = {
  schedules: RustSchedule[];
  events: RustSimulationEvent[];
  players: Array<{
    id: string; x: number; y: number; alive: boolean; hp: number;
    money: number; kills: number; invulnerableUntil: number;
    captureKey: string; captureSince: number;
  }>;
  networkZones: Array<{
    cell: string;
    frame: Uint8Array;
  }>;
};

export type RustTransportMetrics = {
  inFlight: number;
  peakInFlight: number;
  completed: number;
  timedOut: number;
  orphanedResponses: number;
  lastRoundTripMs: number;
};

type TileMap = ReadonlyMap<string, { obstacle: boolean; owner: string | null }>;

export class RustEngine {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<number, {
    resolve: (value: RustTickResult) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
    startedAt: number;
  }>();
  private startError?: Error;
  private output = Buffer.alloc(0);
  private closed = false;
  private mapInitialized = false;
  private nextNumericId = 1;
  private idNumbers = new Map<string, number>();
  private stringIds = new Map<number, string>();
  private newIdMappings: Array<[number, string]> = [];
  private legacyUnits = new Set<string>();
  private legacyHumans = new Set<string>();
  private nextRequestId = 1;
  private networkCells: Array<[number, number, boolean]> = [];
  readonly transportMetrics: RustTransportMetrics = {
    inFlight: 0,
    peakInFlight: 0,
    completed: 0,
    timedOut: 0,
    orphanedResponses: 0,
    lastRoundTripMs: 0,
  };
  lastMetrics?: RustMetrics;

  constructor() {
    this.child = spawn(rustExecutablePath(), [], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.output = Buffer.concat([this.output, chunk]);
      while (this.output.length >= 4) {
        const length = this.output.readUInt32LE(0);
        if (this.output.length < length + 4) return;
        const frame = this.output.subarray(4, length + 4);
        this.output = this.output.subarray(length + 4);
        try {
          const [requestId, wireSchedules, wireMetrics, , wireEvents, wirePlayers, wireZones] = decode(frame) as any[];
          const pending = this.pending.get(requestId);
          if (!pending) {
            this.transportMetrics.orphanedResponses++;
            continue;
          }
          this.pending.delete(requestId);
          clearTimeout(pending.timeout);
          this.updateInFlight();
          this.transportMetrics.completed++;
          this.transportMetrics.lastRoundTripMs = Date.now() - pending.startedAt;
          this.lastMetrics = wireMetrics
            ? {
                decode_us: wireMetrics[0],
                sync_us: wireMetrics[1],
                schedule_us: wireMetrics[2],
                movement_us: wireMetrics[3],
              }
            : undefined;
          pending.resolve({
            schedules: wireSchedules.map((schedule: any[]) => ({
              id: this.stringIds.get(schedule[0])!,
              dt: schedule[1],
              interval_ms: schedule[2],
              target_id:
                schedule[3] === null
                  ? null
                  : (this.stringIds.get(schedule[3]) ?? null),
              next_simulation_at: schedule[4],
              x: schedule[5],
              y: schedule[6],
              dir_x: schedule[7],
              dir_y: schedule[8],
              next_think: schedule[9],
              last_attack: schedule[10],
            })),
            events: (wireEvents ?? []).map((event: any[]) => ({
              kind: event[0],
              entityId: this.stringIds.get(event[1]) ?? null,
              targetId: this.stringIds.get(event[2]) ?? null,
              tileIndex: event[3],
              amount: event[4],
              ownerId: this.stringIds.get(event[5]) ?? null,
            })),
            players: (wirePlayers ?? []).map((player: any[]) => ({
              id: this.stringIds.get(player[0])!, x: player[1], y: player[2],
              alive: player[3], invulnerableUntil: player[5], hp: player[6],
              money: player[8], kills: player[9],
              captureKey: player[12] === null ? "" :
                `${player[12] % GAME.map.width},${Math.floor(player[12] / GAME.map.width)}`,
              captureSince: player[13],
            })),
            networkZones: (wireZones ?? []).map((zone: any[]) => ({
              cell: `${zone[0]},${zone[1]}`,
              frame: zone[2] as Uint8Array,
            })),
          });
        } catch (error) {
          this.failAll(error as Error);
        }
      }
    });
    this.child.on("exit", (code) => {
      this.closed = true;
      const error = new Error(`Le moteur Rust s'est arrêté (${code ?? "inconnu"})`);
      this.failAll(error);
    });
    this.child.on("error", (error) => {
      this.closed = true;
      this.startError = error;
      this.failAll(error);
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      console.error(`Moteur Rust: ${chunk.toString().trimEnd()}`);
    });
  }

  // Compatibility path for tests and standalone benchmarks. Production uses
  // scheduleDelta and never scans the full world.
  schedule(
    now: number,
    units: Iterable<Unit>,
    players: Iterable<Player>,
    map?: TileMap,
    dirtyTiles: Iterable<string> = [],
  ) {
    const unitUpserts = [...units],
      humanUpserts = [...players],
      unitIds = new Set(unitUpserts.map(({ id }) => id)),
      humanIds = new Set(humanUpserts.map(({ id }) => id)),
      unitRemovals = [...this.legacyUnits].filter((id) => !unitIds.has(id)),
      humanRemovals = [...this.legacyHumans].filter((id) => !humanIds.has(id));
    this.legacyUnits = unitIds;
    this.legacyHumans = humanIds;
    return this.scheduleDelta(
      now,
      unitUpserts,
      unitRemovals,
      humanUpserts,
      humanRemovals,
      map,
      dirtyTiles,
    );
  }

  scheduleDelta(
    now: number,
    unitUpserts: Iterable<Unit>,
    unitRemovals: Iterable<string>,
    humanUpserts: Iterable<Player>,
    humanRemovals: Iterable<string>,
    map?: TileMap,
    dirtyTiles: Iterable<string> = [],
  ) {
    return this.scheduleDeltaWithEvents(
      now, unitUpserts, unitRemovals, humanUpserts, humanRemovals, map, dirtyTiles,
    ).then(({ schedules }) => schedules);
  }

  scheduleDeltaWithEvents(
    now: number,
    unitUpserts: Iterable<Unit>,
    unitRemovals: Iterable<string>,
    humanUpserts: Iterable<Player>,
    humanRemovals: Iterable<string>,
    map?: TileMap,
    dirtyTiles: Iterable<string> = [],
    dt = 1 / GAME.room.tickRate,
    supplyAnchors?: ReadonlyMap<string, { x: number; y: number }>,
    returnSchedules = true,
  ) {
    const removedUnitIds = [...unitRemovals],
      removedHumanIds = [...humanRemovals];
    const mapInit =
      !this.mapInitialized && map
        ? [
            GAME.map.width,
            GAME.map.height,
            [...map.entries()]
              .filter(([, tile]) => tile.obstacle)
              .map(([tileKey]) => this.tileIndex(tileKey)),
            Array.from(
              { length: GAME.map.width * GAME.map.height },
              (_, index) => {
                const owner = map.get(
                  `${index % GAME.map.width},${Math.floor(index / GAME.map.width)}`,
                )?.owner;
                return owner ? this.idFor(owner) : 0;
              },
            ),
          ]
        : null;
    const tileUpserts =
      this.mapInitialized && map
        ? [...dirtyTiles].flatMap((tileKey) => {
            const tile = map.get(tileKey);
            return tile
              ? [[
                  this.tileIndex(tileKey),
                  tile.owner ? this.idFor(tile.owner) : 0,
                  tile.obstacle,
                ]]
              : [];
          })
        : [];
    const requestId = this.allocateRequestId();
    const request = [
      RUST_PROTOCOL_VERSION,
      requestId,
      now,
      dt,
      GAME.units.soldier.detectionRange,
      GAME.simulation.intermediateRadius,
      [
        GAME.simulation.combatIntervalMs,
        GAME.simulation.intermediateIntervalMs,
        GAME.simulation.distantIntervalMs,
        GAME.map.width,
        GAME.map.height,
        GAME.units.robot.speed,
        GAME.units.soldier.speed,
        GAME.simulation.targetCandidateLimit,
        GAME.simulation.targetAcquisitionIntervalMs,
        GAME.simulation.targetCacheMs,
        GAME.simulation.tickBudgetMs * 1000,
        GAME.units.defender.guardRadius,
        GAME.units.defender.sortieMargin,
        GAME.capture.holdMs * GAME.capture.robotMultiplier,
        GAME.capture.enemyMultiplier,
        GAME.units.soldier.damage,
        GAME.units.attacker.damage,
        GAME.units.defender.damage,
        GAME.units.soldier.range,
        GAME.units.attacker.range,
        GAME.units.defender.range,
        GAME.units.soldier.cooldownMs,
        GAME.units.attacker.cooldownMs,
        GAME.units.defender.cooldownMs,
        GAME.units.bastion.fortressProductionMs,
        GAME.units.bastion.factoryProductionMs,
        GAME.units.bastion.maxDefenders,
        GAME.units.bastion.turretDamage,
        GAME.units.bastion.turretRange,
        GAME.units.bastion.turretCooldownMs,
        GAME.player.speed,
        GAME.upgrades.speed.bonus,
        GAME.capture.holdMs,
        GAME.capture.improvedMultiplier,
        GAME.player.respawnInvulnerabilityMs,
        GAME.supply.updateIntervalMs,
        GAME.supply.decayMs,
        GAME.supply.decayStages,
        GAME.supply.anchorRadius,
        GAME.supply.relayRadius,
        GAME.economy.incomeIntervalMs,
        GAME.economy.baseIncome,
        GAME.economy.incomeTiers[0].upTo,
        GAME.economy.incomeTiers[0].perTile,
        GAME.economy.incomeTiers[1].upTo,
        GAME.economy.incomeTiers[1].perTile,
        GAME.economy.incomeTiers[2].perTile,
        GAME.supply.unsuppliedIncomeMultiplier,
      ],
      [...unitUpserts].map((unit) => this.unitTuple(unit)),
      removedUnitIds.map((id) => this.idFor(id)),
      [...humanUpserts].map((player) => this.humanTuple(player, supplyAnchors?.get(player.id))),
      removedHumanIds.map((id) => this.idFor(id)),
      mapInit,
      tileUpserts,
      this.networkCells,
      returnSchedules,
    ];
    if (map) this.mapInitialized = true;
    return this.send(requestId, request).then((result) => {
      for (const id of removedUnitIds) this.forgetId(id);
      for (const id of removedHumanIds) this.forgetId(id);
      return result;
    });
  }

  close() {
    this.child.kill();
  }

  invalidateMap() {
    this.mapInitialized = false;
  }

  setNetworkCells(cells: Array<[number, number, boolean]>) {
    this.networkCells = cells;
  }

  idMappings() {
    return [...this.stringIds.entries()];
  }

  drainNewIdMappings() {
    return this.newIdMappings.splice(0);
  }

  private send(requestId: number, request: unknown) {
    return new Promise<RustTickResult>((resolve, reject) => {
      if (this.startError || this.closed) {
        reject(this.startError ?? new Error("Le moteur Rust est arrêté"));
        return;
      }
      const timeout = setTimeout(() => {
        if (!this.pending.delete(requestId)) return;
        this.transportMetrics.timedOut++;
        this.updateInFlight();
        reject(new Error(`Délai Rust dépassé pour la requête ${requestId}`));
      }, DEFAULT_REQUEST_TIMEOUT_MS);
      this.pending.set(requestId, { resolve, reject, timeout, startedAt: Date.now() });
      this.updateInFlight();
      const payload = Buffer.from(encode(request)),
        header = Buffer.allocUnsafe(4);
      header.writeUInt32LE(payload.length);
      this.child.stdin.write(Buffer.concat([header, payload]), (error) => {
        if (!error) return;
        const pending = this.pending.get(requestId);
        if (pending) clearTimeout(pending.timeout);
        this.pending.delete(requestId);
        this.updateInFlight();
        reject(error);
      });
    });
  }

  private allocateRequestId() {
    const id = this.nextRequestId;
    this.nextRequestId = this.nextRequestId >= 0xffff_ffff ? 1 : this.nextRequestId + 1;
    return id;
  }

  private updateInFlight() {
    this.transportMetrics.inFlight = this.pending.size;
    this.transportMetrics.peakInFlight = Math.max(
      this.transportMetrics.peakInFlight,
      this.pending.size,
    );
  }

  private failAll(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    this.updateInFlight();
  }

  private unitTuple(unit: Unit) {
    return [
      this.idFor(unit.id), this.idFor(unit.ownerId), unit.kind,
      unit.x, unit.y, unit.hp, unit.dirX, unit.dirY, unit.order,
      unit.orderX, unit.orderY,
      Number.isFinite(unit.nextThink)
        ? Math.max(0, Math.floor(unit.nextThink))
        : Number.MAX_SAFE_INTEGER,
      unit.nextSimulationAt, unit.lastSimulatedAt,
      unit.cachedTargetId ? this.idFor(unit.cachedTargetId) : null,
      unit.cachedTargetUntil,
      unit.kind === "bastion" && unit.bastionType === "wall",
      unit.lastAttack ?? 0,
      unit.captureKey ? this.tileIndex(unit.captureKey) : null,
      unit.captureSince ?? 0,
      unit.bastionType === "fortress"
        ? 1
        : unit.bastionType === "factory"
          ? 2
          : unit.bastionType === "relay"
            ? 3
            : unit.bastionType === "wall"
              ? 4
              : unit.bastionType === "turret"
                ? 5
                : 0,
      unit.nextProduce ?? 0,
      unit.sourceBastionId ? this.idFor(unit.sourceBastionId) : null,
    ];
  }

  private humanTuple(player: Player, supplyAnchor?: { x: number; y: number }) {
    return [
      this.idFor(player.id), player.x, player.y,
      player.alive, player.isBot, player.invulnerableUntil,
      player.hp ?? GAME.player.maxHp, player.maxHp ?? GAME.player.maxHp,
      player.money ?? 0, player.kills ?? 0,
      player.input?.x ?? 0, player.input?.y ?? 0,
      player.captureKey ? this.tileIndex(player.captureKey) : null,
      player.captureSince ?? 0, player.upgrades?.speed ?? 0,
      player.upgrades?.capture ?? 0,
      supplyAnchor?.x ?? player.x, supplyAnchor?.y ?? player.y,
    ];
  }

  private idFor(id: string) {
    const existing = this.idNumbers.get(id);
    if (existing) return existing;
    const numeric = this.nextNumericId++;
    this.idNumbers.set(id, numeric);
    this.stringIds.set(numeric, id);
    this.newIdMappings.push([numeric, id]);
    return numeric;
  }

  private forgetId(id: string) {
    const numeric = this.idNumbers.get(id);
    if (numeric === undefined) return;
    this.idNumbers.delete(id);
    this.stringIds.delete(numeric);
  }

  private tileIndex(tileKey: string) {
    const comma = tileKey.indexOf(","),
      x = Number(tileKey.slice(0, comma)),
      y = Number(tileKey.slice(comma + 1));
    return y * GAME.map.width + x;
  }
}
