import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { decode, encode } from "@msgpack/msgpack";
import { GAME } from "@tile/game-config";
import type { Player, Unit } from "./model.js";

export const RUST_PROTOCOL_VERSION = 2;

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
};

export type RustMetrics = {
  decode_us: number;
  sync_us: number;
  schedule_us: number;
  movement_us: number;
};

type TileMap = ReadonlyMap<string, { obstacle: boolean; owner: string | null }>;

export class RustEngine {
  private child: ChildProcessWithoutNullStreams;
  private pending: Array<{
    resolve: (value: RustSchedule[]) => void;
    reject: (error: Error) => void;
  }> = [];
  private startError?: Error;
  private output = Buffer.alloc(0);
  private closed = false;
  private mapInitialized = false;
  private nextNumericId = 1;
  private idNumbers = new Map<string, number>();
  private stringIds = new Map<number, string>();
  private legacyUnits = new Set<string>();
  private legacyHumans = new Set<string>();
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
        const pending = this.pending.shift();
        if (!pending) continue;
        try {
          const [wireSchedules, wireMetrics] = decode(frame) as [
            Array<[
              number, number, number, number | null, number,
              number, number, number, number, number,
            ]>,
            [number, number, number, number] | null,
          ];
          this.lastMetrics = wireMetrics
            ? {
                decode_us: wireMetrics[0],
                sync_us: wireMetrics[1],
                schedule_us: wireMetrics[2],
                movement_us: wireMetrics[3],
              }
            : undefined;
          pending.resolve(
            wireSchedules.map((schedule) => ({
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
            })),
          );
        } catch (error) {
          pending.reject(error as Error);
        }
      }
    });
    this.child.on("exit", (code) => {
      this.closed = true;
      const error = new Error(`Le moteur Rust s'est arrêté (${code ?? "inconnu"})`);
      for (const pending of this.pending.splice(0)) pending.reject(error);
    });
    this.child.on("error", (error) => {
      this.closed = true;
      this.startError = error;
      for (const pending of this.pending.splice(0)) pending.reject(error);
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
    const request = [
      RUST_PROTOCOL_VERSION,
      now,
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
      ],
      [...unitUpserts].map((unit) => this.unitTuple(unit)),
      removedUnitIds.map((id) => this.idFor(id)),
      [...humanUpserts].map((player) => this.humanTuple(player)),
      removedHumanIds.map((id) => this.idFor(id)),
      mapInit,
      tileUpserts,
    ];
    if (map) this.mapInitialized = true;
    return this.send(request).then((schedules) => {
      for (const id of removedUnitIds) this.forgetId(id);
      return schedules;
    });
  }

  close() {
    this.child.kill();
  }

  invalidateMap() {
    this.mapInitialized = false;
  }

  private send(request: unknown) {
    return new Promise<RustSchedule[]>((resolve, reject) => {
      if (this.startError || this.closed) {
        reject(this.startError ?? new Error("Le moteur Rust est arrêté"));
        return;
      }
      this.pending.push({ resolve, reject });
      const payload = Buffer.from(encode(request)),
        header = Buffer.allocUnsafe(4);
      header.writeUInt32LE(payload.length);
      this.child.stdin.write(Buffer.concat([header, payload]), (error) => {
        if (!error) return;
        const index = this.pending.findIndex((entry) => entry.reject === reject);
        if (index >= 0) this.pending.splice(index, 1);
        reject(error);
      });
    });
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
    ];
  }

  private humanTuple(player: Player) {
    return [
      this.idFor(player.id), player.x, player.y,
      player.alive, player.isBot, player.invulnerableUntil,
    ];
  }

  private idFor(id: string) {
    const existing = this.idNumbers.get(id);
    if (existing) return existing;
    const numeric = this.nextNumericId++;
    this.idNumbers.set(id, numeric);
    this.stringIds.set(numeric, id);
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
