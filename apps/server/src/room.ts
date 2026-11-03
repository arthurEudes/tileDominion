import { Room, Client } from "colyseus";
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

export class DominionRoom extends Room {
  maxClients = GAME.room.maxPlayers;
  world = new World();
  rust = new RustEngine();
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
  globalUnitIds = new Map<string, number>();
  nextGlobalUnitId = 1;
  minimapOwners: Array<string | null> = [];
  onCreate() {
    for (let i = 0; i < GAME.bots.count; i++) this.addBot();
    this.setSimulationInterval(
      (dt) => void this.step(dt / 1000),
      1000 / GAME.room.tickRate,
    );
    this.onMessage("ready", (c) => {
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
      if (
        !ok &&
        (item === "robot" ||
          item === "soldier" ||
          item === "attacker" ||
          item === "defender")
      ) {
        const cfg = GAME.units[item];
        message =
          counts[item === "robot" ? "robots" : "soldiers"] >= cfg.max
            ? `Limite de ${cfg.max} ${item}s atteinte`
            : before < cfg.price
              ? `Il faut ${cfg.price} crédits`
              : message;
      } else if (!ok && p) {
        const cfg = GAME.upgrades[item as keyof typeof GAME.upgrades],
          level = p.upgrades[item as keyof typeof p.upgrades];
        message =
          level >= cfg.max ? "Niveau maximum atteint" : "Fonds insuffisants";
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
      const buildPrice =
          v.data.kind === "wall"
            ? GAME.units.bastion.wallPrice
            : v.data.kind === "turret"
              ? GAME.units.bastion.turretPrice
              : GAME.units.bastion.price,
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
          ? `${v.data.kind === "fortress" ? "Forteresse" : v.data.kind === "factory" ? "Usine" : v.data.kind === "relay" ? "Relais" : v.data.kind === "wall" ? "Mur" : "Tourelle"} construit`
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
  onJoin(c: Client, opts: unknown) {
    const v = JoinSchema.safeParse(opts);
    this.evictBotForHuman();
    this.world.addPlayer(
      c.sessionId,
      v.success ? v.data.name : `Invité-${c.sessionId.slice(0, 4)}`,
      COLORS[this.clients.length % COLORS.length],
    );
    this.rust.invalidateMap();
    c.send("welcome", { id: c.sessionId });
  }
  async onLeave(c: Client, consented: boolean) {
    if (consented) {
      this.replaceHumanWithBot(c.sessionId);
      this.cleanupClient(c.sessionId);
      return;
    }
    try {
      await this.allowReconnection(c, GAME.room.reconnectSeconds);
    } catch {
      this.replaceHumanWithBot(c.sessionId);
      this.cleanupClient(c.sessionId);
    }
  }
  onDispose() {
    this.rust.close();
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
    const now = Date.now();
    try {
      this.updateBots(now);
      await this.world.tickWithRust(this.rust, Math.min(dt, 0.1), now);
      this.elapsed += dt;
      if (this.elapsed >= 0.1) {
        this.elapsed = 0;
        const changed = [...this.world.dirtyTiles],
          counts = this.world.allCounts();
        this.broadcastInterestStates(changed, counts);
        this.world.dirtyTiles.clear();
      }
    } catch (error) {
      console.error(
        "Moteur Rust indisponible, tick TypeScript de secours",
        error,
      );
      this.world.tick(Math.min(dt, 0.1), now);
    } finally {
      this.simulationBusy = false;
    }
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
        if (unit.kind === "headquarters" || unit.kind === "bastion")
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
    if (p.money < GAME.units.bastion.wallPrice) return;
    const tiles = this.world.territoryCounts.get(p.id) ?? 0,
      relayGoal = Math.min(6, Math.max(1, Math.ceil(tiles / 100))),
      fortressGoal = Math.max(1, Math.ceil(tiles / 80)),
      factoryGoal = Math.max(1, Math.ceil(tiles / 120)),
      turretGoal = Math.max(1, Math.ceil(tiles / 100)),
      wallGoal = threatened ? Math.min(6, 2 + Math.floor(tiles / 80)) : 0,
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
    if (
      threatened &&
      army.turrets.length < turretGoal &&
      p.money >= GAME.units.bastion.turretPrice
    ) {
      const site = frontier ?? candidates[0];
      this.world.placeBastion(p.id, site.x, site.y, "turret", now);
      return;
    }
    if ((threatened || frontier) && army.fortresses.length < fortressGoal) {
      const site = frontier ?? candidates[0];
      this.world.placeBastion(p.id, site.x, site.y, "fortress", now);
      return;
    }
    if (
      threatened &&
      army.walls.length < wallGoal &&
      p.money >= GAME.units.bastion.wallPrice
    ) {
      const site = frontier ?? candidates[0];
      this.world.placeBastion(p.id, site.x, site.y, "wall", now);
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
              unit.kind === "bastion" || unit.kind === "headquarters",
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
      temporaryChannel = `__full:${cell}`;
    this.unitChannels.delete(temporaryChannel);
    const wire = compactSnapshot(
      snapshot,
      this.unitDelta(temporaryChannel, snapshot.units, true),
    );
    this.unitChannels.delete(temporaryChannel);
    client.sendBytes("state", encode(wire));
    this.clientInterestCells.set(client.sessionId, cell);
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
    const activeChannels = new Set<string>();
    for (const [cell, clients] of groups) {
      const channelId = `interest:${cell}`;
      activeChannels.add(channelId);
      const snapshot = this.interestSnapshot(cell, false, changedTiles, counts),
        delta = this.unitDelta(channelId, snapshot.units),
        deltaBytes = encode(compactSnapshot(snapshot, delta));
      const entrants = clients.filter(
        (client) => this.clientInterestCells.get(client.sessionId) !== cell,
      );
      let fullBytes: Uint8Array | undefined;
      if (entrants.length) {
        const fullSnapshot = this.interestSnapshot(cell, true, [], counts),
          temporaryChannel = `__full:${cell}`;
        this.unitChannels.delete(temporaryChannel);
        fullBytes = encode(
          compactSnapshot(
            fullSnapshot,
            this.unitDelta(temporaryChannel, fullSnapshot.units, true),
          ),
        );
        this.unitChannels.delete(temporaryChannel);
      }
      for (const client of clients) {
        client.sendBytes(
          "state",
          entrants.includes(client) ? fullBytes! : deltaBytes,
        );
        this.clientInterestCells.set(client.sessionId, cell);
      }
    }
    for (const channelId of [...this.unitChannels.keys()])
      if (channelId.startsWith("interest:") && !activeChannels.has(channelId))
        this.unitChannels.delete(channelId);
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
      units = nearbyUnits
        .map((unit) => this.unitView(unit)),
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
      visible = new Set<string>();
    for (const unit of units) {
      visible.add(unit.id);
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
                : unit.kind === "headquarters"
                  ? 3
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
