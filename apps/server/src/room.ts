import { Room, Client } from "colyseus";
import { randomUUID } from "node:crypto";
import { encode } from "@msgpack/msgpack";
import { COLORS, GAME } from "@tile/game-config";
import {
  BuySchema,
  BuildSchema,
  InputSchema,
  JoinSchema,
  OrderSchema,
  compactSnapshot,
  POSITION_SCALE,
  type CompactUnitDelta,
  type ServerUnitView,
  type Snapshot,
} from "@tile/protocol";
import { World } from "./world.js";
import { RustEngine } from "./rust-engine.js";
import { key, type Player, type Unit } from "./model.js";
import { accounts, type PublicAccount } from "./accounts.js";
import { logger } from "./logger.js";
import {
  playersGauge,
  roomsGauge,
  tickDuration,
  tickOverruns,
  websocketGauge,
} from "./telemetry.js";

type BotForces = {
  robots: Unit[];
  attackers: Unit[];
  defenders: Unit[];
  fortresses: Unit[];
  factories: Unit[];
  relays: Unit[];
  walls: Unit[];
  turrets: Unit[];
};

const INTEREST_CELL_SIZE = 16;
const MINIMAP_SCALE = 4;
const MINIMAP_WIDTH = Math.ceil(GAME.map.width / MINIMAP_SCALE);
const MINIMAP_HEIGHT = Math.ceil(GAME.map.height / MINIMAP_SCALE);
type MinimapWire = [
  0 | 1,
  number,
  number,
  Array<[number, string | null]>,
];

type MatchStats = {
  maxTerritory: number;
  tilesCaptured: number;
  tilesLost: number;
  unitsProduced: number;
  buildingsProduced: number;
  territoryHistory: Array<[number, number]>;
  lastHistoryAt: number;
};

const emptyMatchStats = (tiles: number, now: number): MatchStats => ({
  maxTerritory: tiles,
  tilesCaptured: 0,
  tilesLost: 0,
  unitsProduced: 0,
  buildingsProduced: 0,
  territoryHistory: [[0, tiles]],
  lastHistoryAt: now,
});

export class DominionRoom extends Room {
  maxClients = GAME.room.maxPlayers;
  world = new World();
  rust = new RustEngine(() => this.logContext());
  simulationBusy = false;
  elapsed = 0;
  rates = new Map<string, { at: number; n: number }>();
  botThink = new Map<string, number>();
  botBuildThink = new Map<string, number>();
  botSerial = 0;
  unitChannels = new Map<
    string,
    {
      nextId: number;
      ids: Map<string, number>;
      previous: Map<string, [number, number, number, number]>;
    }
  >();
  clientInterestCells = new Map<string, string>();
  fullNetworkCells = new Set<string>();
  globalUnitIds = new Map<string, number>();
  nextGlobalUnitId = 1;
  matchId = randomUUID();
  readonly playerAccounts = new Map<string, PublicAccount>();
  matchFinished = false;
  matchFinishing = false;
  matchStats = new Map<string, MatchStats>();
  minimapOwners: Array<string | null> = [];
  connectedSessions = new Set<string>();
  lastTickWarning = 0;
  onCreate() {
    roomsGauge.inc();
    logger.info("room_created", this.logContext());
    for (let i = 0; i < GAME.bots.count; i++) this.addBot();
    this.setSimulationInterval(
      (dt) => void this.step(dt / 1000),
      1000 / GAME.room.tickRate,
    );
    this.onMessage("ready", (c) => {
      this.fullNetworkCells.add(this.interestCellFor(c.sessionId));
      this.sendFullInterestState(c);
      this.sendFullMinimap(c);
    });
    this.onMessage("input", (c, m) => {
      if (!this.allow(c)) return;
      const v = InputSchema.safeParse(m);
      if (v.success) this.world.setInput(c.sessionId, v.data);
    });
    this.onMessage("buy", (c, m) => {
      const v = BuySchema.safeParse(m);
      if (!v.success) return;
      const item = v.data.item,
        p = this.world.players.get(c.sessionId),
        before = p?.money ?? 0,
        ok = this.world.buy(c.sessionId, item),
        counts = this.world.counts(c.sessionId);
      let message = ok ? "Achat confirmé" : "Achat refusé";
      if (!ok) {
        const cfg = GAME.units[item];
        message =
          counts[item === "robot" ? "robots" : "soldiers"] >= cfg.max
            ? `Limite de ${cfg.max} ${item}s atteinte`
            : before < cfg.price
              ? `Il faut ${cfg.price} crédits`
              : message;
      }
      c.send("purchase", {
        ok,
        item,
        money: p?.money ?? 0,
        message,
        ...counts,
      });
    });
    this.onMessage("build", (c, m) => {
      if (!this.allow(c)) return;
      const v = BuildSchema.safeParse(m);
      if (!v.success) return;
      const buildPrice = GAME.units.bastion.price,
        ok = this.world.placeBastion(
          c.sessionId,
          v.data.x,
          v.data.y,
          v.data.kind,
        ),
        p = this.world.players.get(c.sessionId),
        counts = this.world.counts(c.sessionId);
      c.send("purchase", {
        ok,
        item: v.data.kind,
        money: p?.money ?? 0,
        message: ok
          ? `${v.data.kind === "fortress" ? "Forteresse" : v.data.kind === "factory" ? "Usine" : "Relais"} construit`
          : `Placement impossible (territoire, distance ou ${buildPrice} crédits)`,
        ...counts,
      });
    });
    this.onMessage("order", (c, m) => {
      if (!this.allow(c)) return;
      const v = OrderSchema.safeParse(m);
      if (!v.success) return;
      const changed = this.world.orderSoldiers(c.sessionId, v.data);
      c.send("orderResult", {
        ok: changed > 0,
        message: changed
          ? `Ordre transmis à ${changed} soldat(s)`
          : "Aucun soldat valide sélectionné",
      });
    });
  }
  onAuth(_client: Client, opts: unknown) {
    const token = typeof opts === "object" && opts !== null
      ? (opts as { token?: unknown }).token
      : undefined;
    if (token === undefined) return { guest: true };
    const account = accounts.resolve(token);
    if (!account) return false;
    if ([...this.playerAccounts.values()].some(({ id }) => id === account.id)) return false;
    return { account };
  }
  onJoin(c: Client, opts: unknown, auth?: { guest?: true; account?: PublicAccount }) {
    const v = JoinSchema.safeParse(opts);
    const account = auth?.account;
    this.evictBotForHuman();
    this.world.addPlayer(
      c.sessionId,
      account?.username ?? (v.success ? v.data.name : `Invité-${c.sessionId.slice(0, 4)}`),
      COLORS[this.clients.length % COLORS.length],
    );
    this.matchStats.set(
      c.sessionId,
      emptyMatchStats(this.world.territoryCounts.get(c.sessionId) ?? 0, Date.now()),
    );
    if (account) {
      this.playerAccounts.set(c.sessionId, account);
      c.send("account", account);
    }
    this.connectedSessions.add(c.sessionId);
    playersGauge.inc();
    websocketGauge.inc();
    logger.info("player_joined", {
      ...this.logContext(), sessionId: c.sessionId, authenticated: !!account,
      connections: this.connectedSessions.size,
    });
    this.rust.invalidateMap();
    c.send("welcome", { id: c.sessionId, roomId: this.roomId, matchId: this.matchId });
  }
  async onLeave(c: Client, consented: boolean) {
    if (consented) {
      this.replaceHumanWithBot(c.sessionId);
      this.cleanupClient(c.sessionId);
      this.recordDisconnect(c.sessionId, "consented");
      return;
    }
    try {
      await this.allowReconnection(c, GAME.room.reconnectSeconds);
    } catch {
      this.replaceHumanWithBot(c.sessionId);
      this.cleanupClient(c.sessionId);
      this.recordDisconnect(c.sessionId, "reconnect_timeout");
    }
  }
  onDispose() {
    this.rust.close();
    if (this.connectedSessions.size) {
      playersGauge.dec(this.connectedSessions.size);
      websocketGauge.dec(this.connectedSessions.size);
      this.connectedSessions.clear();
    }
    roomsGauge.dec();
    logger.info("room_disposed", this.logContext());
  }
  allow(c: Client) {
    const now = Date.now(),
      r = this.rates.get(c.sessionId) ?? { at: now, n: 0 };
    if (now - r.at > 1000) {
      r.at = now;
      r.n = 0;
    }
    r.n++;
    this.rates.set(c.sessionId, r);
    return r.n <= 35;
  }
  async step(dt: number) {
    if (this.simulationBusy) return;
    this.simulationBusy = true;
    const tickStartedAt = performance.now();
    const now = Date.now();
    if (now >= this.world.endsAt) {
      try {
        await this.finishMatch();
      } catch (error) {
        logger.error("match_score_award_failed", { ...this.logContext(), error });
      }
    }
    try {
      this.updateBots(now);
      const networkDue = this.elapsed + dt >= 0.1;
      const cells = networkDue
        ? new Set(this.clients.map((client) => this.interestCellFor(client.sessionId)))
        : new Set<string>();
      this.rust.setNetworkCells([...cells].map((cell) => {
        const [x, y] = cell.split(",").map(Number);
        const entrant = this.clients.some((client) =>
          this.interestCellFor(client.sessionId) === cell &&
          this.clientInterestCells.get(client.sessionId) !== cell);
        return [x, y, this.fullNetworkCells.has(cell) || entrant] as [number, number, boolean];
      }));
      await this.world.tickWithRust(this.rust, Math.min(dt, 0.1), now, false);
      this.collectMatchStats(now);
      this.elapsed += dt;
      if (this.elapsed >= 0.1) {
        this.elapsed = 0;
        const changed = [...this.world.dirtyTiles],
          counts = this.world.allCounts();
        this.broadcastInterestStates(changed, counts);
        this.fullNetworkCells.clear();
        this.world.dirtyTiles.clear();
      }
    } catch (error) {
      logger.error("rust_tick_fallback", { ...this.logContext(), error });
      this.world.tick(Math.min(dt, 0.1), now);
    } finally {
      const durationSeconds = (performance.now() - tickStartedAt) / 1000;
      tickDuration.observe(durationSeconds);
      const budgetSeconds = 1 / GAME.room.tickRate;
      if (durationSeconds > budgetSeconds) {
        tickOverruns.inc();
        if (now - this.lastTickWarning >= 5_000) {
          this.lastTickWarning = now;
          logger.warn("tick_budget_exceeded", {
            ...this.logContext(), durationMs: durationSeconds * 1000,
            budgetMs: budgetSeconds * 1000,
            units: this.world.units.size,
            players: this.connectedSessions.size,
          });
        }
      }
      this.simulationBusy = false;
    }
  }
  async finishMatch() {
    if (this.matchFinished || this.matchFinishing) return;
    this.matchFinishing = true;
    try {
      const capturableTiles = this.world.tileList.reduce(
        (total, tile) => total + (tile.obstacle ? 0 : 1),
        0,
      );
      this.collectMatchStats(Date.now(), true);
      const standings = [...this.world.players.values()]
        .map((player) => ({
          id: player.id,
          name: player.name,
          tiles: this.world.territoryCounts.get(player.id) ?? 0,
          kills: player.kills,
          isBot: player.isBot,
        }))
        .sort((a, b) => b.tiles - a.tiles || b.kills - a.kills || a.name.localeCompare(b.name));
      const beforeRanks = new Map<string, Awaited<ReturnType<typeof accounts.ranking>>>();
      await Promise.all([...this.playerAccounts].map(async ([sessionId, account]) => {
        beforeRanks.set(sessionId, await accounts.ranking(account.id));
      }));
      const awarded = new Map<string, PublicAccount>();
      await Promise.all([...this.playerAccounts].map(async ([sessionId, account]) => {
        const tiles = this.world.territoryCounts.get(sessionId) ?? 0;
        const stats = this.matchStats.get(sessionId) ?? emptyMatchStats(tiles, Date.now());
        const updated = await accounts.awardScore(
          account.id,
          this.matchId,
          scoreForTerritory(tiles, capturableTiles),
          stats.maxTerritory,
        );
        if (updated) awarded.set(sessionId, updated);
      }));
      const afterRanks = new Map<string, Awaited<ReturnType<typeof accounts.ranking>>>();
      await Promise.all([...this.playerAccounts].map(async ([sessionId, account]) => {
        afterRanks.set(sessionId, await accounts.ranking(account.id));
      }));
      this.matchFinished = true;
      logger.info("match_finished", {
        ...this.logContext(), authenticatedPlayers: awarded.size,
      });
      for (const client of this.clients) {
        const sessionId = client.sessionId;
        const account = this.playerAccounts.get(sessionId);
        const updated = awarded.get(sessionId);
        const stats = this.matchStats.get(sessionId) ?? emptyMatchStats(0, Date.now());
        const player = this.world.players.get(sessionId);
        const placement = Math.max(1, standings.findIndex(({ id }) => id === sessionId) + 1);
        const tiles = this.world.territoryCounts.get(sessionId) ?? 0;
        const before = beforeRanks.get(sessionId);
        const after = afterRanks.get(sessionId);
        client.send("matchResult", {
          points: account ? scoreForTerritory(tiles, capturableTiles) : 0,
          score: updated?.score ?? account?.score ?? 0,
          authenticated: !!account,
          country: updated?.country ?? account?.country ?? "XX",
          placement,
          totalPlayers: standings.length,
          winner: standings[0]?.name ?? "—",
          standings: standings.slice(0, 10),
          rankings: account ? {
            world: rankChange(before?.world, after?.world),
            country: rankChange(before?.country, after?.country),
          } : null,
          stats: {
            maxTerritory: stats.maxTerritory,
            tilesCaptured: stats.tilesCaptured,
            tilesLost: stats.tilesLost,
            kills: player?.kills ?? 0,
            unitsProduced: stats.unitsProduced,
            buildingsProduced: stats.buildingsProduced,
            territoryHistory: stats.territoryHistory,
          },
          personalBest: {
            value: updated?.bestTerritory ?? stats.maxTerritory,
            isNew: !!account && stats.maxTerritory > account.bestTerritory,
          },
        });
      }
      this.startNextMatch();
    } finally {
      this.matchFinishing = false;
    }
  }
  startNextMatch() {
    const humans = this.clients.map((client) => ({
      sessionId: client.sessionId,
      name:
        this.playerAccounts.get(client.sessionId)?.username ??
        this.world.players.get(client.sessionId)?.name ??
        `Invité-${client.sessionId.slice(0, 4)}`,
    }));

    this.rust.close();
    this.world = new World();
    this.rust = new RustEngine(() => this.logContext());
    this.matchId = randomUUID();
    this.matchFinished = false;
    this.matchStats.clear();
    this.elapsed = 0;
    this.botThink.clear();
    this.botBuildThink.clear();
    this.botSerial = 0;
    this.unitChannels.clear();
    this.clientInterestCells.clear();
    this.fullNetworkCells.clear();
    this.globalUnitIds.clear();
    this.nextGlobalUnitId = 1;
    this.minimapOwners = [];

    for (let index = 0; index < GAME.bots.count; index++) this.addBot();
    for (const [index, human] of humans.entries()) {
      this.evictBotForHuman();
      this.world.addPlayer(
        human.sessionId,
        human.name,
        COLORS[(index + 1) % COLORS.length],
      );
      this.matchStats.set(
        human.sessionId,
        emptyMatchStats(this.world.territoryCounts.get(human.sessionId) ?? 0, Date.now()),
      );
      this.fullNetworkCells.add(this.interestCellFor(human.sessionId));
    }
    this.rust.invalidateMap();
    logger.info("match_started", this.logContext());
    this.broadcast("newMatch", {
      endsAt: this.world.endsAt,
      roomId: this.roomId,
      matchId: this.matchId,
    });
  }

  private logContext() {
    return { roomId: this.roomId, matchId: this.matchId };
  }

  private collectMatchStats(now: number, forceHistory = false) {
    const events = this.world.drainMatchEvents();
    for (const event of events.ownership) {
      if (event.owner) {
        const stats = this.matchStats.get(event.owner);
        if (stats) stats.tilesCaptured++;
      }
      if (event.previousOwner) {
        const stats = this.matchStats.get(event.previousOwner);
        if (stats) stats.tilesLost++;
      }
    }
    for (const event of events.creations) {
      const stats = this.matchStats.get(event.ownerId);
      if (!stats) continue;
      if (event.kind === "building") stats.buildingsProduced++;
      else stats.unitsProduced++;
    }
    const elapsedSeconds = Math.max(
      0,
      Math.round((now - (this.world.endsAt - GAME.room.durationMs)) / 1000),
    );
    for (const [sessionId, stats] of this.matchStats) {
      const tiles = this.world.territoryCounts.get(sessionId) ?? 0;
      stats.maxTerritory = Math.max(stats.maxTerritory, tiles);
      if (forceHistory || now - stats.lastHistoryAt >= 10_000) {
        const previous = stats.territoryHistory.at(-1);
        if (!previous || previous[0] !== elapsedSeconds)
          stats.territoryHistory.push([elapsedSeconds, tiles]);
        stats.lastHistoryAt = now;
      }
    }
  }

  private recordDisconnect(sessionId: string, reason: string) {
    if (!this.connectedSessions.delete(sessionId)) return;
    playersGauge.dec();
    websocketGauge.dec();
    logger.info("player_left", {
      ...this.logContext(), sessionId, reason,
      connections: this.connectedSessions.size,
    });
  }
  updateBots(now: number) {
    const due = [...this.world.players.values()].filter(
      (p) =>
        p.isBot && p.alive && now >= (this.botThink.get(p.id) ?? 0),
    );
    if (!due.length) return;
    const forces = new Map<string, BotForces>();
    for (const p of due)
      forces.set(p.id, {
        robots: [],
        attackers: [],
        defenders: [],
        fortresses: [],
        factories: [],
        relays: [],
        walls: [],
        turrets: [],
      });
    const structures: Unit[] = [];
    for (const unit of this.world.units.values()) {
      if (unit.kind === "bastion")
        structures.push(unit);
      const army = forces.get(unit.ownerId);
      if (!army) continue;
      if (unit.kind === "robot") army.robots.push(unit);
      else if (unit.kind === "defender") army.defenders.push(unit);
      else if (unit.kind === "soldier" || unit.kind === "attacker")
        army.attackers.push(unit);
      else if (unit.bastionType === "factory") army.factories.push(unit);
      else if (unit.bastionType === "relay") army.relays.push(unit);
      else if (unit.bastionType === "wall") army.walls.push(unit);
      else if (unit.bastionType === "turret") army.turrets.push(unit);
      else army.fortresses.push(unit);
    }
    for (const p of due) {
      this.botThink.set(
        p.id,
        now + GAME.bots.thinkIntervalMs + Math.random() * 400,
      );
      const army = forces.get(p.id)!;
      const threatened = this.findBotThreat(p);
      const strategicTarget = this.findEnemyStructure(p, structures);
      const target = threatened
        ? { x: threatened.x, y: threatened.y }
        : strategicTarget
          ? { x: strategicTarget.x, y: strategicTarget.y }
          : this.world.findCaptureTarget(p);
      const a = target
        ? Math.atan2(target.y - p.y, target.x - p.x)
        : Math.random() * Math.PI * 2;
      p.input = {
        x: Math.cos(a),
        y: Math.sin(a),
        attack: false,
        seq: p.input.seq + 1,
      };
      if (strategicTarget && army.attackers.length)
        this.world.orderSoldiers(p.id, {
          unitIds: army.attackers.slice(0, 100).map((unit) => unit.id),
          mode: "attack",
          x: strategicTarget.x,
          y: strategicTarget.y,
        });
      if (now >= (this.botBuildThink.get(p.id) ?? 0)) {
        this.botBuildThink.set(
          p.id,
          now + GAME.bots.buildThinkIntervalMs + Math.random() * 1000,
        );
        this.planBotBuilding(p, army, !!threatened, now);
      }
      this.planBotPurchase(p, army, !!threatened);
    }
  }
  addBot() {
    const serial = ++this.botSerial,
      id = `bot-${serial}`;
    this.world.addPlayer(
      id,
      `IA ${serial}`,
      COLORS[(serial + 2) % COLORS.length],
      true,
    );
    this.botThink.set(id, 0);
    this.botBuildThink.set(id, 0);
    return id;
  }
  evictBotForHuman() {
    const bots = [...this.world.players.values()].filter((p) => p.isBot);
    if (!bots.length) return false;
    const victim = bots.reduce((weakest, candidate) =>
      this.botStrength(candidate.id) < this.botStrength(weakest.id)
        ? candidate
        : weakest,
    );
    const neutralized = this.world.neutralizePlayer(victim.id);
    this.botThink.delete(victim.id);
    this.botBuildThink.delete(victim.id);
    for (const channel of this.unitChannels.values())
      for (const unitId of neutralized) channel.previous.delete(unitId);
    return true;
  }
  replaceHumanWithBot(id: string) {
    const serial = ++this.botSerial;
    if (!this.world.convertPlayerToBot(id, `IA ${serial}`)) return false;
    this.botThink.set(id, 0);
    this.botBuildThink.set(id, 0);
    return true;
  }
  private cleanupClient(id: string) {
    this.unitChannels.delete(id);
    this.clientInterestCells.delete(id);
    this.rates.delete(id);
  }
  private botStrength(id: string) {
    let units = 0,
      structures = 0;
    for (const unit of this.world.units.values())
      if (unit.ownerId === id) {
        units++;
        if (unit.kind === "bastion")
          structures++;
      }
    return (this.world.territoryCounts.get(id) ?? 0) * 2 + units + structures * 8;
  }
  private findBotThreat(p: Player) {
    const origin = p,
      radius = 12;
    let nearest: Player | Unit | undefined,
      best = Number.POSITIVE_INFINITY;
    for (const entity of this.world.spatial.query(origin.x, origin.y, radius)) {
      const enemy =
        entity.id !== p.id &&
        ("kind" in entity ? entity.ownerId !== p.id : entity.id !== p.id);
      if (!enemy) continue;
      const distance = Math.hypot(entity.x - origin.x, entity.y - origin.y);
      if (distance < best) {
        nearest = entity;
        best = distance;
      }
    }
    return nearest;
  }
  private findEnemyStructure(p: Player, structures: Unit[]) {
    let nearest: Unit | undefined,
      best = GAME.bots.structureAttackRadius ** 2;
    for (const structure of structures) {
      if (structure.ownerId === p.id) continue;
      const dx = structure.x - p.x,
        dy = structure.y - p.y,
        distanceSquared = dx * dx + dy * dy;
      if (distanceSquared < best) {
        nearest = structure;
        best = distanceSquared;
      }
    }
    return nearest;
  }
  private planBotPurchase(p: Player, army: BotForces, threatened: boolean) {
    const tiles = this.world.territoryCounts.get(p.id) ?? 0,
      robotGoal = Math.min(30, 6 + Math.floor(tiles / 20)),
      defenderGoal = 2 + army.fortresses.length * 3 + (threatened ? 4 : 0),
      attackerGoal = Math.min(40, 6 + Math.floor(tiles / 12));
    if (
      threatened &&
      army.defenders.length < defenderGoal &&
      p.money >= GAME.units.defender.price
    )
      this.world.buy(p.id, "defender");
    else if (
      army.robots.length < robotGoal &&
      p.money >= GAME.units.robot.price
    )
      this.world.buy(p.id, "robot");
    else if (
      army.defenders.length < defenderGoal &&
      p.money >= GAME.units.defender.price
    )
      this.world.buy(p.id, "defender");
    else if (
      army.attackers.length < attackerGoal &&
      p.money >= GAME.units.attacker.price
    )
      this.world.buy(p.id, "attacker");
  }
  private planBotBuilding(
    p: Player,
    army: BotForces,
    threatened: boolean,
    now: number,
  ) {
    if (p.money < GAME.units.bastion.price) return;
    const tiles = this.world.territoryCounts.get(p.id) ?? 0,
      relayGoal = Math.min(6, Math.max(1, Math.ceil(tiles / 100))),
      fortressGoal = Math.max(1, Math.ceil(tiles / 80)),
      factoryGoal = Math.max(1, Math.ceil(tiles / 120)),
      candidates = this.botBuildCandidates(p);
    if (!candidates.length) return;
    const unsupplied = candidates.find(
      ({ x, y }) =>
        !this.world.isTileSupplied(x, y) &&
        !army.relays.some(
          (relay) =>
            Math.hypot(relay.x - x - 0.5, relay.y - y - 0.5) <
            GAME.supply.relayRadius,
        ),
    );
    if (unsupplied && army.relays.length < relayGoal) {
      this.world.placeBastion(p.id, unsupplied.x, unsupplied.y, "relay", now);
      return;
    }
    const frontier = candidates.find(({ x, y }) =>
      [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ].some(([dx, dy]) => this.world.map.get(key(x + dx, y + dy))?.owner !== p.id),
    );
    if ((threatened || frontier) && army.fortresses.length < fortressGoal) {
      const site = frontier ?? candidates[0];
      this.world.placeBastion(p.id, site.x, site.y, "fortress", now);
      return;
    }
    if (army.factories.length < factoryGoal) {
      const supplied = candidates.find(({ x, y }) =>
        this.world.isTileSupplied(x, y),
      );
      const site = supplied ?? candidates[0];
      this.world.placeBastion(p.id, site.x, site.y, "factory", now);
    }
  }
  private botBuildCandidates(p: Player) {
    const radius = Math.floor(GAME.units.bastion.placementRange),
      occupied = new Set(
        [...this.world.units.values()]
          .filter(
            (unit) =>
              unit.kind === "bastion",
          )
          .map((unit) => key(Math.floor(unit.x), Math.floor(unit.y))),
      ),
      candidates: Array<{ x: number; y: number; score: number }> = [];
    for (let y = Math.max(0, Math.floor(p.y) - radius); y <= Math.min(GAME.map.height - 1, Math.floor(p.y) + radius); y++)
      for (let x = Math.max(0, Math.floor(p.x) - radius); x <= Math.min(GAME.map.width - 1, Math.floor(p.x) + radius); x++) {
        if (Math.hypot(x + 0.5 - p.x, y + 0.5 - p.y) > radius) continue;
        const tile = this.world.map.get(key(x, y));
        if (!tile || tile.obstacle || tile.owner !== p.id) continue;
        if (occupied.has(key(x, y))) continue;
        candidates.push({ x, y, score: Math.hypot(x + 0.5 - p.x, y + 0.5 - p.y) });
      }
    return candidates.sort((a, b) => a.score - b.score);
  }
  private interestCellFor(clientId: string) {
    const player = this.world.players.get(clientId);
    if (!player) return "0,0";
    return `${Math.floor(player.x / INTEREST_CELL_SIZE)},${Math.floor(player.y / INTEREST_CELL_SIZE)}`;
  }
  private sendFullInterestState(client: Client) {
    const cell = this.interestCellFor(client.sessionId),
      counts = this.world.allCounts(),
      snapshot = this.interestSnapshot(cell, true, [], counts),
      wire = compactSnapshot(snapshot, [[], [], [], 0]);
    client.sendBytes("unitIds", encode(this.rust.idMappings()));
    client.sendBytes("state", encode(wire));
  }
  private broadcastInterestStates(
    changedTiles: string[],
    counts = this.world.allCounts(),
  ) {
    const groups = new Map<string, Client[]>();
    for (const client of this.clients) {
      const cell = this.interestCellFor(client.sessionId),
        clients = groups.get(cell) ?? [];
      clients.push(client);
      groups.set(cell, clients);
    }
    const mappings = this.rust?.drainNewIdMappings?.() ?? [];
    if (mappings.length) {
      const bytes = encode(mappings);
      for (const client of this.clients) client.sendBytes("unitIds", bytes);
    }
    for (const [cell, clients] of groups) {
      const unitFrame = this.world.rustNetworkZones.get(cell),
        snapshot = this.interestSnapshot(cell, false, changedTiles, counts),
        stateBytes = encode(compactSnapshot(snapshot, [[], [], [], 0]));
      const entrants = clients.filter(
        (client) => this.clientInterestCells.get(client.sessionId) !== cell,
      );
      for (const client of clients) {
        if (unitFrame) client.sendBytes("units", unitFrame);
        const clientSnapshot = entrants.includes(client)
          ? this.interestSnapshot(cell, true, [], counts)
          : snapshot;
        client.sendBytes("state", entrants.includes(client)
          ? encode(compactSnapshot(clientSnapshot, [[], [], [], 0]))
          : stateBytes);
        this.clientInterestCells.set(client.sessionId, cell);
      }
    }
    // Numeric IDs only have to remain stable while the unit exists. Keeping
    // every produced and destroyed unit here made long matches grow forever.
    for (const unitId of this.world.networkRemovedUnits)
      this.globalUnitIds.delete(unitId);
    this.world.networkRemovedUnits.clear();
    const minimapChanges = this.updateMinimap(changedTiles);
    if (minimapChanges.length) {
      const bytes = encode([
        0,
        MINIMAP_WIDTH,
        MINIMAP_HEIGHT,
        minimapChanges,
      ] satisfies MinimapWire);
      for (const client of this.clients)
        client.sendBytes("minimap", bytes);
    }
  }
  private ensureMinimap() {
    if (this.minimapOwners?.length === MINIMAP_WIDTH * MINIMAP_HEIGHT)
      return;
    this.minimapOwners = Array.from(
      { length: MINIMAP_WIDTH * MINIMAP_HEIGHT },
      (_, index) => this.minimapOwner(index),
    );
  }
  private minimapOwner(index: number) {
    const cellX = index % MINIMAP_WIDTH,
      cellY = Math.floor(index / MINIMAP_WIDTH),
      startX = cellX * MINIMAP_SCALE,
      startY = cellY * MINIMAP_SCALE,
      owners = new Map<string, number>();
    for (
      let y = startY;
      y < Math.min(startY + MINIMAP_SCALE, GAME.map.height);
      y++
    )
      for (
        let x = startX;
        x < Math.min(startX + MINIMAP_SCALE, GAME.map.width);
        x++
      ) {
        const owner = this.world.map.get(key(x, y))?.owner;
        if (owner) owners.set(owner, (owners.get(owner) ?? 0) + 1);
      }
    let dominant: string | null = null,
      best = 0;
    for (const [owner, count] of owners)
      if (count > best) {
        dominant = owner;
        best = count;
      }
    return dominant;
  }
  private sendFullMinimap(client: Client) {
    this.ensureMinimap();
    const owned = this.minimapOwners.flatMap((owner, index) =>
      owner ? [[index, owner] as [number, string]] : [],
    );
    client.sendBytes(
      "minimap",
      encode([
        1,
        MINIMAP_WIDTH,
        MINIMAP_HEIGHT,
        owned,
      ] satisfies MinimapWire),
    );
  }
  private updateMinimap(changedTiles: string[]) {
    this.ensureMinimap();
    const affected = new Set<number>();
    for (const tileKey of changedTiles) {
      const [x, y] = tileKey.split(",").map(Number);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      affected.add(
        Math.floor(y / MINIMAP_SCALE) * MINIMAP_WIDTH +
          Math.floor(x / MINIMAP_SCALE),
      );
    }
    const changed: Array<[number, string | null]> = [];
    for (const index of affected) {
      const owner = this.minimapOwner(index);
      if (this.minimapOwners[index] === owner) continue;
      this.minimapOwners[index] = owner;
      changed.push([index, owner]);
    }
    return changed;
  }
  private interestSnapshot(
    cell: string,
    full: boolean,
    tileKeys: string[],
    counts = this.world.allCounts(),
  ): Snapshot {
    const [cellX, cellY] = cell.split(",").map(Number),
      centerX = (cellX + 0.5) * INTEREST_CELL_SIZE,
      centerY = (cellY + 0.5) * INTEREST_CELL_SIZE,
      radius = GAME.map.unitInterestRadius + Math.SQRT2 * INTEREST_CELL_SIZE * 0.5,
      nearbyUnits = [...this.world.spatial.query(centerX, centerY, radius)].filter(
          (entity): entity is Unit =>
            "kind" in entity &&
            Math.hypot(entity.x - centerX, entity.y - centerY) <= radius,
        ),
      units: ServerUnitView[] = [],
      allPlayers = [...this.world.players.values()],
      visibleOwnerIds = new Set(nearbyUnits.map((unit) => unit.ownerId)),
      nearbyPlayers = allPlayers.filter(
        (player) =>
          player.alive &&
          (visibleOwnerIds.has(player.id) ||
            Math.hypot(player.x - centerX, player.y - centerY) <= radius),
      ),
      leaderboard = allPlayers
        .map((player) => ({ ...player, ...counts.get(player.id)! }))
        .sort((a, b) => b.tiles - a.tiles)
        .map((player) => ({
          id: player.id,
          name: player.name,
          color: player.color,
          tiles: player.tiles,
          kills: player.kills,
        })),
      tiles: Snapshot["tiles"] = [];
    if (full) {
      const minX = Math.max(0, Math.floor(centerX - radius)),
        maxX = Math.min(GAME.map.width - 1, Math.ceil(centerX + radius)),
        minY = Math.max(0, Math.floor(centerY - radius)),
        maxY = Math.min(GAME.map.height - 1, Math.ceil(centerY + radius));
      for (let y = minY; y <= maxY; y++)
        for (let x = minX; x <= maxX; x++) {
          const tile = this.world.map.get(key(x, y));
          if (!tile) continue;
          tiles.push([x, y, tile.owner, tile.obstacle ? 1 : 0, tile.supplyDecay]);
        }
    } else {
      for (const tileKey of tileKeys) {
        const [x, y] = tileKey.split(",").map(Number);
        if (Math.abs(x + 0.5 - centerX) > radius || Math.abs(y + 0.5 - centerY) > radius)
          continue;
        const tile = this.world.map.get(tileKey);
        if (tile)
          tiles.push([x, y, tile.owner, tile.obstacle ? 1 : 0, tile.supplyDecay]);
      }
    }
    return {
      now: Date.now(),
      endsAt: this.world.endsAt,
      width: GAME.map.width,
      height: GAME.map.height,
      players: nearbyPlayers.map((player) => ({
        ...player,
        ...(counts.get(player.id) ?? this.world.counts(player.id)),
      })),
      units,
      tiles,
      leaderboard,
      globalUnits: this.world.units.size,
    };
  }
  private unitView(unit: Unit): ServerUnitView {
    return {
      id: unit.id,
      ownerId: unit.ownerId,
      kind: unit.kind,
      x: unit.x,
      y: unit.y,
      hp: unit.hp,
      maxHp:
        unit.kind === "bastion" && unit.bastionType === "wall"
          ? GAME.units.bastion.wallHp
          : unit.kind === "bastion" && unit.bastionType === "turret"
            ? GAME.units.bastion.turretHp
            : GAME.units[unit.kind].hp,
      nextProduce: unit.nextProduce,
      bastionType: unit.bastionType,
      homeX: unit.homeX,
      homeY: unit.homeY,
    };
  }
  wireSnapshot(
    clientId: string,
    full = false,
    tileKeys: string[] = [],
    counts = this.world.allCounts(),
  ) {
    const snapshot = this.snapshot(clientId, full, tileKeys, counts);
    return compactSnapshot(
      snapshot,
      this.unitDelta(clientId, snapshot.units, full),
    );
  }
  unitDelta(
    clientId: string,
    units: ServerUnitView[],
    full = false,
    rustDelta?: { created: Unit[]; updated: Unit[]; removed: string[] },
  ): CompactUnitDelta {
    let channel = this.unitChannels.get(clientId);
    if (!channel) {
      channel = { nextId: 1, ids: new Map(), previous: new Map() };
      this.unitChannels.set(clientId, channel);
    }
    if (full) channel.previous.clear();
    const created: CompactUnitDelta[0] = [],
      updated: CompactUnitDelta[1] = [],
      removed: number[] = [],
      visible = new Set(units.map((unit) => unit.id)),
      candidates = !full && rustDelta
        ? [...rustDelta.created, ...rustDelta.updated].map((unit) => this.unitView(unit))
        : units;
    for (const unit of candidates) {
      let numericId = channel.ids.get(unit.id);
      if (!numericId) {
        numericId = this.globalUnitId(unit.id);
        channel.ids.set(unit.id, numericId);
      }
      const x = Math.max(
          0,
          Math.min(65535, Math.round(unit.x * POSITION_SCALE)),
        ),
        y = Math.max(
          0,
          Math.min(65535, Math.round(unit.y * POSITION_SCALE)),
        ),
        current: [number, number, number, number] = [
          x,
          y,
          unit.hp,
          unit.nextProduce,
        ],
        previous = channel.previous.get(unit.id);
      if (!previous) {
        created.push([
          numericId,
          unit.id,
          unit.ownerId,
          unit.kind === "robot"
            ? 0
            : unit.kind === "soldier"
              ? 1
              : unit.kind === "bastion"
                ? 2
                : unit.kind === "attacker"
                  ? 4
                  : 5,
          x,
          y,
          unit.hp,
          unit.maxHp,
          unit.nextProduce,
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
          Math.max(
            0,
            Math.min(
              65535,
              Math.round((unit.homeX ?? 0) * POSITION_SCALE),
            ),
          ),
          Math.max(
            0,
            Math.min(
              65535,
              Math.round((unit.homeY ?? 0) * POSITION_SCALE),
            ),
          ),
        ]);
      } else if (
        previous[0] !== current[0] ||
        previous[1] !== current[1] ||
        previous[2] !== current[2] ||
        previous[3] !== current[3]
      )
        updated.push([numericId, ...current]);
      channel.previous.set(unit.id, current);
    }
    for (const unitId of [...channel.previous.keys()])
      if (!visible.has(unitId)) {
        channel.previous.delete(unitId);
        const numericId = channel.ids.get(unitId);
        if (numericId) removed.push(numericId);
        channel.ids.delete(unitId);
      }
    return [created, updated, removed, full ? 1 : 0];
  }
  private globalUnitId(unitId: string) {
    this.globalUnitIds ??= new Map();
    this.nextGlobalUnitId ??= 1;
    const existing = this.globalUnitIds.get(unitId);
    if (existing) return existing;
    const numericId = this.nextGlobalUnitId++;
    this.globalUnitIds.set(unitId, numericId);
    return numericId;
  }
  snapshot(
    clientId?: string,
    full = false,
    tileKeys: string[] = [],
    counts = this.world.allCounts(),
  ): Snapshot {
    const ps = [...this.world.players.values()];
    const leaderboard = ps
      .map((p) => ({ ...p, ...counts.get(p.id)! }))
      .sort((a, b) => b.tiles - a.tiles)
      .map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        tiles: p.tiles,
        kills: p.kills,
      }));
    const focus = this.world.players.get(clientId ?? "") ?? ps[0],
      radius = GAME.map.unitInterestRadius;
    const nearby = focus
      ? [...this.world.spatial.query(focus.x, focus.y, radius)]
      : [];
    const tiles: Snapshot["tiles"] = [];
    const source = full ? [...this.world.map.keys()] : tileKeys;
    for (const k of source) {
      const t = this.world.map.get(k);
      if (!t) continue;
      if (full && !t.owner && !t.obstacle) continue;
      const [x, y] = k.split(",").map(Number);
      tiles.push([x, y, t.owner, t.obstacle ? 1 : 0, t.supplyDecay]);
    }
    const units = nearby
      .filter((e): e is import("./model.js").Unit => "kind" in e)
      .map(
        ({
          id,
          ownerId,
          kind,
          x,
          y,
          hp,
          nextProduce,
          bastionType,
          homeX,
          homeY,
        }) => ({
        id,
        ownerId,
        kind,
        x,
        y,
        hp,
        maxHp:
          kind === "bastion" && bastionType === "wall"
            ? GAME.units.bastion.wallHp
            : kind === "bastion" && bastionType === "turret"
              ? GAME.units.bastion.turretHp
              : GAME.units[kind].hp,
        nextProduce,
        bastionType,
        homeX,
        homeY,
      }),
      );
    return {
      now: Date.now(),
      endsAt: this.world.endsAt,
      width: GAME.map.width,
      height: GAME.map.height,
      players: ps.map((p) => ({ ...p, ...counts.get(p.id)! })),
      units,
      tiles,
      leaderboard,
      globalUnits: this.world.units.size,
    };
  }
}

export function scoreForTerritory(ownedTiles: number, capturableTiles: number) {
  if (capturableTiles <= 0) return 0;
  return Math.max(0, Math.min(1000, Math.round((ownedTiles / capturableTiles) * 1000)));
}

function rankChange(before?: number | null, after?: number | null) {
  if (before == null || after == null) return null;
  return { before, after, gained: before - after };
}
