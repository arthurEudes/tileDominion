import { GAME } from "@tile/game-config";
import type { BuyItem, Input, SoldierOrder } from "@tile/protocol";
import {
  clamp,
  dist,
  key,
  makeMap,
  type BastionType,
  tileCount,
  type Player,
  type Tile,
  type Unit,
} from "./model.js";
import { SpatialIndex } from "./spatial.js";
import type { RustEngine, RustSimulationEvent } from "./rust-engine.js";
type CombatKind = "soldier" | "attacker" | "defender";
const isCombatKind = (kind: Unit["kind"]): kind is CombatKind =>
  kind === "soldier" || kind === "attacker" || kind === "defender";
const combatConfig = (kind: CombatKind) => GAME.units[kind];
export const NEUTRAL_OWNER_ID = "neutral";
export class World {
  readonly map = makeMap();
  readonly tileList = [...this.map.values()];
  readonly players = new Map<string, Player>();
  readonly units = new Map<string, Unit>();
  readonly dirtyTiles = new Set<string>();
  readonly rustDirtyTiles = new Set<string>();
  readonly rustDirtyUnits = new Map<string, number>();
  readonly rustRemovedUnits = new Map<string, number>();
  readonly rustDirtyPlayers = new Map<string, number>();
  readonly rustRemovedPlayers = new Map<string, number>();
  readonly territoryCounts = new Map<string, number>();
  readonly suppliedTerritoryCounts = new Map<string, number>();
  readonly unsuppliedTerritoryCounts = new Map<string, number>();
  readonly spatial = new SpatialIndex(16);
  readonly suppliedTiles = new Uint8Array(GAME.map.width * GAME.map.height);
  readonly wallTiles = new Set<string>();
  readonly capitals = new Map<string, { x: number; y: number }>();
  endsAt = Date.now() + GAME.room.durationMs;
  private serial = 0;
  private incomeElapsed = 0;
  private lastSupplyUpdate = 0;
  private rustVersion = 0;
  addPlayer(id: string, name: string, color: number, isBot = false) {
    const spot = this.findSpawn();
    const p: Player = {
      id,
      name,
      x: spot.x + 0.5,
      y: spot.y + 0.5,
      color,
      hp: GAME.player.maxHp,
      maxHp: GAME.player.maxHp,
      money: GAME.economy.startingMoney,
      kills: 0,
      alive: true,
      isBot,
      input: { x: 0, y: 0, attack: false, seq: 0 },
      captureKey: "",
      captureSince: 0,
      lastAttack: 0,
      invulnerableUntil: Date.now() + GAME.player.respawnInvulnerabilityMs,
      upgrades: { speed: 0, armor: 0, capture: 0 },
    };
    this.players.set(id, p);
    this.capitals.set(id, { x: spot.x, y: spot.y });
    this.markPlayer(id);
    this.territoryCounts.set(id, 0);
    for (
      let y = spot.y - GAME.map.spawnRadius;
      y <= spot.y + GAME.map.spawnRadius;
      y++
    )
      for (
        let x = spot.x - GAME.map.spawnRadius;
        x <= spot.x + GAME.map.spawnRadius;
        x++
      ) {
        const k = key(x, y),
          t = this.map.get(k);
        if (t) {
          t.obstacle = false;
          this.setOwner(k, t, id);
        }
      }
    return p;
  }
  findSpawn() {
    let best = { x: 4, y: 4, score: -1 };
    for (let i = 0; i < 120; i++) {
      const x = 3 + Math.floor(Math.random() * (GAME.map.width - 6)),
        y = 3 + Math.floor(Math.random() * (GAME.map.height - 6));
      let score = 999;
      for (const p of this.players.values())
        score = Math.min(score, Math.hypot(x - p.x, y - p.y));
      const t = this.map.get(key(x, y));
      if (t && !t.obstacle && score > best.score) best = { x, y, score };
    }
    return best;
  }
  findCaptureTarget(p: Player, radius = GAME.bots.searchRadius) {
    const centerX = Math.floor(p.x),
      centerY = Math.floor(p.y),
      minX = Math.max(0, centerX - radius),
      maxX = Math.min(GAME.map.width - 1, centerX + radius),
      minY = Math.max(0, centerY - radius),
      maxY = Math.min(GAME.map.height - 1, centerY + radius);
    let target: { x: number; y: number } | undefined,
      best = Number.POSITIVE_INFINITY;
    for (let y = minY; y <= maxY; y++)
      for (let x = minX; x <= maxX; x++) {
        const dx = x + 0.5 - p.x,
          dy = y + 0.5 - p.y,
          distanceSquared = dx * dx + dy * dy;
        if (distanceSquared > radius * radius || distanceSquared >= best)
          continue;
        const tile = this.map.get(key(x, y));
        if (!tile || tile.obstacle || tile.owner === p.id) continue;
        best = distanceSquared;
        target = { x: x + 0.5, y: y + 0.5 };
      }
    return target;
  }
  findNearestNonAlliedTile(x: number, y: number, ownerId: string) {
    return this.findNearestTiles(x, y, ownerId, false, 1)[0];
  }
  private findNearestTiles(
    x: number,
    y: number,
    ownerId: string,
    allied: boolean,
    limit: number,
  ) {
    const centerX = Math.floor(x),
      centerY = Math.floor(y),
      maxRadius = Math.max(GAME.map.width, GAME.map.height);
    const best: Array<{ x: number; y: number; distance: number }> = [];
    for (let radius = 0; radius <= maxRadius; radius++) {
      const visit = (tx: number, ty: number) => {
        if (tx < 0 || ty < 0 || tx >= GAME.map.width || ty >= GAME.map.height)
          return;
        const tile = this.map.get(key(tx, ty));
        if (!tile || tile.obstacle || (tile.owner === ownerId) !== allied) return;
        const distance = Math.hypot(tx + 0.5 - x, ty + 0.5 - y);
        best.push({ x: tx + 0.5, y: ty + 0.5, distance });
        best.sort((a, b) => a.distance - b.distance);
        best.length = Math.min(best.length, limit);
      };
      for (let offset = -radius; offset <= radius; offset++) {
        visit(centerX + offset, centerY - radius);
        if (radius) visit(centerX + offset, centerY + radius);
      }
      for (let offset = -radius + 1; offset < radius; offset++) {
        visit(centerX - radius, centerY + offset);
        if (radius) visit(centerX + radius, centerY + offset);
      }
      if (best.length === limit && best[best.length - 1].distance <= radius)
        return best;
    }
    return best;
  }
  setInput(id: string, input: Input) {
    const p = this.players.get(id);
    if (p && input.seq > p.input.seq)
      p.input = { ...input, attack: false };
  }
  buy(id: string, item: BuyItem) {
    const p = this.players.get(id);
    if (!p || !p.alive) return false;
    const level =
      item === "speed" || item === "armor" || item === "capture"
        ? p.upgrades[item]
        : 0;
    const isUnitPurchase =
        item === "robot" ||
        item === "soldier" ||
        item === "attacker" ||
        item === "defender",
      cfg: any = isUnitPurchase
        ? GAME.units[item]
        : (GAME.upgrades as any)[item];
    const price = cfg.price ?? cfg.basePrice * (level + 1);
    if (p.money < price) return false;
    if (isUnitPurchase) {
      const count = [...this.units.values()].filter(
        (u) => u.ownerId === id && u.kind === item,
      ).length;
      if (count >= cfg.max) return false;
      const unitId = `u${++this.serial}`;
      this.units.set(unitId, {
        id: unitId,
        ownerId: id,
        kind: item,
        x: p.x,
        y: p.y,
        hp: cfg.hp,
        dirX: 1,
        dirY: 0,
        nextThink: 0,
        lastAttack: 0,
        captureKey: "",
        captureSince: 0,
        nextProduce: 0,
        order: item === "defender" ? "guard" : "wander",
        orderX: p.x,
        orderY: p.y,
        nextSimulationAt: Date.now() + (this.serial % 10) * 5,
        lastSimulatedAt: Date.now(),
        cachedTargetId: "",
        cachedTargetUntil: 0,
        homeX: item === "defender" ? p.x : undefined,
        homeY: item === "defender" ? p.y : undefined,
      });
      this.markUnit(unitId);
    } else {
      if (level >= cfg.max) return false;
      p.upgrades[item]++;
      if (item === "armor") {
        p.maxHp += cfg.hp;
        p.hp += cfg.hp;
      }
    }
    p.money -= price;
    return true;
  }
  placeBastion(
    id: string,
    x: number,
    y: number,
    bastionType: BastionType,
    now = Date.now(),
  ) {
    const p = this.players.get(id),
      cfg = GAME.units.bastion,
      tileKey = key(x, y),
      t = this.map.get(tileKey),
      price =
        bastionType === "wall"
          ? cfg.wallPrice
          : bastionType === "turret"
            ? cfg.turretPrice
            : cfg.price,
      hp =
        bastionType === "wall"
          ? cfg.wallHp
          : bastionType === "turret"
            ? cfg.turretHp
            : cfg.hp;
    if (
      !p ||
      !p.alive ||
      !t ||
      t.obstacle ||
      t.owner !== id ||
      p.money < price ||
      Math.hypot(x + 0.5 - p.x, y + 0.5 - p.y) > cfg.placementRange ||
      [...this.units.values()].some(
        (u) =>
          u.kind === "bastion" &&
          Math.floor(u.x) === x &&
          Math.floor(u.y) === y,
      ) ||
      (bastionType === "wall" &&
        ([...this.players.values()].some(
          (player) =>
            Math.floor(player.x) === x && Math.floor(player.y) === y,
        ) ||
          [...this.units.values()].some(
            (unit) =>
              Math.floor(unit.x) === x && Math.floor(unit.y) === y,
          )))
    )
      return false;
    const unitId = `u${++this.serial}`;
    this.units.set(unitId, {
      id: unitId,
      ownerId: id,
      kind: "bastion",
      x: x + 0.5,
      y: y + 0.5,
      hp,
      dirX: 0,
      dirY: 0,
      nextThink: Number.POSITIVE_INFINITY,
      lastAttack: 0,
      captureKey: "",
      captureSince: 0,
      nextProduce:
        bastionType === "relay"
          ? 0
          : now +
            (bastionType === "factory"
              ? cfg.factoryProductionMs
              : cfg.fortressProductionMs),
      order: "guard",
      orderX: x + 0.5,
      orderY: y + 0.5,
      nextSimulationAt: now + (this.serial % 10) * 5,
      lastSimulatedAt: now,
      cachedTargetId: "",
      cachedTargetUntil: 0,
      bastionType,
    });
    if (bastionType === "wall") this.wallTiles.add(tileKey);
    this.markUnit(unitId);
    p.money -= price;
    return true;
  }
  isMovementBlocked(x: number, y: number) {
    const tileKey = key(Math.floor(x), Math.floor(y));
    return !!this.map.get(tileKey)?.obstacle || this.wallTiles.has(tileKey);
  }
  orderSoldiers(id: string, order: SoldierOrder) {
    const p = this.players.get(id);
    if (!p?.alive) return 0;
    if (
      order.mode !== "follow" &&
      (!Number.isFinite(order.x) || !Number.isFinite(order.y))
    )
      return 0;
    let changed = 0;
    for (const unitId of new Set(order.unitIds)) {
      const u = this.units.get(unitId);
      if (
        !u ||
        u.ownerId !== id ||
        (u.kind !== "soldier" && u.kind !== "attacker")
      )
        continue;
      u.order = order.mode;
      u.orderX =
        order.mode === "follow"
          ? p.x
          : clamp(order.x!, 0.5, GAME.map.width - 0.5);
      u.orderY =
        order.mode === "follow"
          ? p.y
          : clamp(order.y!, 0.5, GAME.map.height - 0.5);
      u.nextThink = 0;
      this.markUnit(u.id);
      changed++;
    }
    return changed;
  }
  spawnProducedUnit(
    ownerId: string,
    kind: "robot" | CombatKind,
    x: number,
    y: number,
    sourceBastionId?: string,
  ) {
    const cfg = GAME.units[kind],
      unitId = `u${++this.serial}`;
    this.units.set(unitId, {
      id: unitId,
      ownerId,
      kind,
      x,
      y,
      hp: cfg.hp,
      dirX: 1,
      dirY: 0,
      nextThink: 0,
      lastAttack: 0,
      captureKey: "",
      captureSince: 0,
      nextProduce: 0,
      order: kind === "defender" ? "guard" : "wander",
      orderX: x,
      orderY: y,
      nextSimulationAt: Date.now() + (this.serial % 10) * 5,
      lastSimulatedAt: Date.now(),
      cachedTargetId: "",
      cachedTargetUntil: 0,
      homeX: kind === "defender" ? x : undefined,
      homeY: kind === "defender" ? y : undefined,
      sourceBastionId,
    });
    this.markUnit(unitId);
  }
  tick(dt: number, now = Date.now()) {
    this.spatial.rebuild(this.players.values(), this.units.values());
    for (const p of this.players.values()) this.tickPlayer(p, dt, now);
    for (const u of [...this.units.values()]) {
      if (now < u.nextSimulationAt) continue;
      const interval = this.simulationInterval(u),
        elapsed = Math.min(0.6, Math.max(dt, (now - u.lastSimulatedAt) / 1000));
      u.lastSimulatedAt = now;
      u.nextSimulationAt = now + interval;
      this.tickUnit(u, elapsed, now);
      this.enforceUnitBounds(u);
    }
    this.updateSupply(now);
    this.applyIncome(dt);
  }
  async tickWithRust(engine: RustEngine, dt: number, now = Date.now()) {
    const rustTileChanges = [...this.rustDirtyTiles];
    const unitChanges = [...this.rustDirtyUnits],
      unitRemovals = [...this.rustRemovedUnits],
      playerChanges = [...this.rustDirtyPlayers],
      playerRemovals = [...this.rustRemovedPlayers];
    const usesEventJournal = typeof engine.scheduleDeltaWithEvents === "function";
    const tickResult = usesEventJournal
      ? await engine.scheduleDeltaWithEvents(
      now,
      unitChanges.flatMap(([id]) => {
        const unit = this.units.get(id);
        return unit ? [unit] : [];
      }),
      unitRemovals.map(([id]) => id),
      playerChanges.flatMap(([id]) => {
        const player = this.players.get(id);
        return player ? [player] : [];
      }),
      playerRemovals.map(([id]) => id),
      this.map,
      rustTileChanges,
        )
      : {
          schedules: await engine.scheduleDelta(
            now,
            unitChanges.flatMap(([id]) => {
              const unit = this.units.get(id);
              return unit ? [unit] : [];
            }),
            unitRemovals.map(([id]) => id),
            playerChanges.flatMap(([id]) => {
              const player = this.players.get(id);
              return player ? [player] : [];
            }),
            playerRemovals.map(([id]) => id),
            this.map,
            rustTileChanges,
          ),
          events: [],
        };
    const { schedules, events } = tickResult;
    for (const tileKey of rustTileChanges) this.rustDirtyTiles.delete(tileKey);
    this.ackVersions(this.rustDirtyUnits, unitChanges);
    this.ackVersions(this.rustRemovedUnits, unitRemovals);
    this.ackVersions(this.rustDirtyPlayers, playerChanges);
    this.ackVersions(this.rustRemovedPlayers, playerRemovals);
    // Keep the operation transactional until the subprocess has answered so
    // the caller can run exactly one fallback tick after a Rust failure.
    this.spatial.rebuild(this.players.values(), this.units.values());
    for (const p of this.players.values()) this.tickPlayer(p, dt, now);
    for (const p of this.players.values()) this.markPlayer(p.id);
    for (const schedule of schedules) {
      const u = this.units.get(schedule.id);
      if (!u) continue;
      u.lastSimulatedAt = now;
      u.nextSimulationAt = schedule.next_simulation_at;
      u.x = schedule.x;
      u.y = schedule.y;
      u.dirX = schedule.dir_x;
      u.dirY = schedule.dir_y;
      u.nextThink = schedule.next_think;
      u.lastAttack = schedule.last_attack;
      u.cachedTargetId = schedule.target_id ?? "";
      u.cachedTargetUntil = schedule.target_id
        ? now + GAME.simulation.targetCacheMs
        : now + GAME.simulation.intermediateIntervalMs;
      if (usesEventJournal) this.applyRustStructureEffects(u, now);
      else this.applyRustUnitEffectsLegacy(u, now);
      this.enforceUnitBounds(u);
    }
    for (const event of events) this.applyRustEvent(event);
    this.updateSupply(now);
    this.applyIncome(dt);
  }
  private applyRustStructureEffects(u: Unit, now: number) {
    if (u.ownerId === NEUTRAL_OWNER_ID) return;
    if (!this.players.has(u.ownerId)) {
      this.removeUnit(u.id);
      return;
    }
    if (u.kind === "headquarters") return;
  }
  private applyRustUnitEffectsLegacy(u: Unit, now: number) {
    if (u.ownerId === NEUTRAL_OWNER_ID) return;
    if (!this.players.has(u.ownerId)) {
      this.removeUnit(u.id);
      return;
    }
    if (u.kind === "headquarters") return;
    if (u.kind === "bastion") {
      this.produceFromBastion(u, now);
      return;
    }
    if (u.kind === "robot") {
      const tileKey = key(Math.floor(u.x), Math.floor(u.y)),
        tile = this.map.get(tileKey);
      if (tile && !tile.obstacle && tile.owner !== u.ownerId) {
        if (u.captureKey !== tileKey) {
          u.captureKey = tileKey;
          u.captureSince = now;
        }
        const duration = GAME.capture.holdMs * GAME.capture.robotMultiplier *
          (tile.owner ? GAME.capture.enemyMultiplier : 1);
        if (now - u.captureSince >= duration) {
          this.setOwner(tileKey, tile, u.ownerId);
          u.captureKey = "";
        }
      } else u.captureKey = "";
      return;
    }
    if (!isCombatKind(u.kind) || !u.cachedTargetId) return;
    const cfg = combatConfig(u.kind),
      target = this.units.get(u.cachedTargetId) ?? this.players.get(u.cachedTargetId);
    if (!target || target.id === u.id || dist(u, target) > cfg.range ||
        now - u.lastAttack < cfg.cooldownMs) return;
    const valid = "kind" in target
      ? target.ownerId !== u.ownerId
      : target.id !== u.ownerId && target.alive && now >= target.invulnerableUntil;
    if (!valid) return;
    u.lastAttack = now;
    if ("kind" in target) this.damageUnit(target, cfg.damage);
    else this.damagePlayer(target, cfg.damage, u.ownerId);
  }
  private applyRustEvent(event: RustSimulationEvent) {
    if (event.kind === 0) {
      if (!event.ownerId) return;
      const x = event.tileIndex % GAME.map.width,
        y = Math.floor(event.tileIndex / GAME.map.width),
        tileKey = key(x, y),
        tile = this.map.get(tileKey);
      if (tile && !tile.obstacle && tile.owner !== event.ownerId)
        this.setOwner(tileKey, tile, event.ownerId);
      return;
    }
    if (event.kind === 2) {
      if (!event.entityId || !event.ownerId) return;
      const source = this.units.get(event.entityId);
      if (!source || source.ownerId !== event.ownerId || source.kind !== "bastion")
        return;
      const kind = event.tileIndex === 0 ? "robot" : "defender";
      this.spawnProducedUnit(event.ownerId, kind, source.x, source.y, source.id);
      source.nextProduce = Date.now() + Math.max(0, event.amount);
      this.markUnit(source.id);
      return;
    }
    if (event.kind === 3) {
      if (event.targetId && this.units.has(event.targetId))
        this.removeUnit(event.targetId);
      return;
    }
    if (event.kind !== 1 || !event.targetId || !event.ownerId) return;
    const target = this.units.get(event.targetId) ?? this.players.get(event.targetId);
    if (!target || !Number.isFinite(event.amount) || event.amount <= 0) return;
    if ("kind" in target) {
      if (target.ownerId !== event.ownerId) {
        target.hp -= event.amount;
        this.markUnit(target.id);
      }
    } else if (
      target.id !== event.ownerId &&
      target.alive &&
      Date.now() >= target.invulnerableUntil
    ) {
      this.damagePlayer(target, event.amount, event.ownerId);
    }
  }
  private applyIncome(dt: number) {
    this.incomeElapsed += dt * 1000;
    if (this.incomeElapsed >= GAME.economy.incomeIntervalMs) {
      this.incomeElapsed %= GAME.economy.incomeIntervalMs;
      for (const p of this.players.values())
        if (p.alive) {
          p.money +=
            Math.floor(
              ((this.suppliedTerritoryCounts.get(p.id) ?? 0) +
                (this.unsuppliedTerritoryCounts.get(p.id) ?? 0) *
                  GAME.supply.unsuppliedIncomeMultiplier) *
                GAME.economy.incomePerTile,
            );
        }
    }
  }
  simulationInterval(u: Unit) {
    if (isCombatKind(u.kind)) {
      const cfg = combatConfig(u.kind);
      const inCombat = [
        ...this.spatial.query(u.x, u.y, cfg.detectionRange),
      ].some(
        (entity) =>
          entity.id !== u.id &&
          ("kind" in entity
            ? entity.ownerId !== u.ownerId
            : entity.id !== u.ownerId && entity.alive) &&
          dist(u, entity) <= cfg.detectionRange,
      );
      if (inCombat) return GAME.simulation.combatIntervalMs;
    }
    const nearHuman = [...this.players.values()].some(
      (p) =>
        !p.isBot &&
        p.alive &&
        Math.hypot(p.x - u.x, p.y - u.y) <= GAME.simulation.intermediateRadius,
    );
    return nearHuman
      ? GAME.simulation.intermediateIntervalMs
      : GAME.simulation.distantIntervalMs;
  }
  tickPlayer(p: Player, dt: number, now: number) {
    if (!p.alive) return;
    let { x, y } = p.input;
    const len = Math.hypot(x, y) || 1;
    x /= len;
    y /= len;
    const speed =
      GAME.player.speed * (1 + p.upgrades.speed * GAME.upgrades.speed.bonus);
    const nx = clamp(p.x + x * speed * dt, 0.1, GAME.map.width - 0.1),
      ny = clamp(p.y + y * speed * dt, 0.1, GAME.map.height - 0.1);
    if (!this.isMovementBlocked(nx, p.y)) p.x = nx;
    if (!this.isMovementBlocked(p.x, ny)) p.y = ny;
    const k = key(Math.floor(p.x), Math.floor(p.y)),
      t = this.map.get(k);
    if (t && !t.obstacle && t.owner !== p.id) {
      if (p.captureKey !== k) {
        p.captureKey = k;
        p.captureSince = now;
      } else if (
        now - p.captureSince >=
        GAME.capture.holdMs *
          (t.owner ? GAME.capture.enemyMultiplier : 1) *
          Math.pow(GAME.capture.improvedMultiplier, p.upgrades.capture)
      ) {
        this.setOwner(k, t, p.id);
        p.captureKey = "";
      }
    } else p.captureKey = "";
  }
  tickUnit(u: Unit, dt: number, now: number) {
    if (u.ownerId === NEUTRAL_OWNER_ID) return;
    const owner = this.players.get(u.ownerId);
    if (!owner) {
      this.removeUnit(u.id);
      return;
    }
    if (u.kind === "headquarters") return;
    if (u.kind === "bastion") {
      this.produceFromBastion(u, now);
      return;
    }
    let directed = false;
    if (u.kind === "robot") {
      const currentKey = key(Math.floor(u.x), Math.floor(u.y)),
        currentTile = this.map.get(currentKey);
      if (
        currentTile &&
        !currentTile.obstacle &&
        currentTile.owner !== u.ownerId
      ) {
        if (u.captureKey !== currentKey) {
          u.captureKey = currentKey;
          u.captureSince = now;
        }
        const duration =
          GAME.capture.holdMs *
          GAME.capture.robotMultiplier *
          (currentTile.owner ? GAME.capture.enemyMultiplier : 1);
        if (now - u.captureSince >= duration) {
          this.setOwner(currentKey, currentTile, u.ownerId);
          u.captureKey = "";
          u.nextThink = 0;
        }
        return;
      }
      u.captureKey = "";
      const targetTile = this.map.get(
        key(Math.floor(u.orderX), Math.floor(u.orderY)),
      );
      if (now >= u.nextThink || !targetTile || targetTile.owner === u.ownerId) {
        const candidates = this.findNearestTiles(u.x, u.y, u.ownerId, false, 3),
          target = candidates[Math.floor(Math.random() * candidates.length)];
        if (target) {
          u.orderX = target.x;
          u.orderY = target.y;
        }
        u.nextThink = now + 1000;
      }
      const distance = Math.hypot(u.orderX - u.x, u.orderY - u.y);
      if (distance > 0.1) {
        u.dirX = (u.orderX - u.x) / distance;
        u.dirY = (u.orderY - u.y) / distance;
        directed = true;
      }
    }
    const defenderStartedAllied = u.kind === "defender" &&
      this.map.get(key(Math.floor(u.x), Math.floor(u.y)))?.owner === u.ownerId;
    if (u.kind === "defender" && !defenderStartedAllied) {
      const target = this.findNearestTiles(u.x, u.y, u.ownerId, true, 1)[0];
      if (target) {
        const distance = Math.hypot(target.x - u.x, target.y - u.y) || 1;
        u.dirX = (target.x - u.x) / distance;
        u.dirY = (target.y - u.y) / distance;
        directed = true;
      }
    }
    if (isCombatKind(u.kind) && !(u.kind === "defender" && !defenderStartedAllied)) {
      const cfg = combatConfig(u.kind);
      let target: Unit | Player | undefined;
      if (
        u.cachedTargetId &&
        (u.kind === "attacker" || now < u.cachedTargetUntil)
      ) {
        target =
          this.units.get(u.cachedTargetId) ??
          this.players.get(u.cachedTargetId);
        const valid =
          target &&
          target.id !== u.id &&
          (u.kind === "attacker" ||
            dist(u, target) <= cfg.detectionRange * 1.25) &&
          ("kind" in target
            ? target.ownerId !== u.ownerId
            : target.id !== u.ownerId &&
              target.alive &&
              now >= target.invulnerableUntil);
        if (!valid) target = undefined;
      }
      if (!target) {
        const nearby = [
            ...this.spatial.query(u.x, u.y, cfg.detectionRange),
          ],
          enemyUnits = nearby
            .filter(
              (e): e is Unit =>
                "kind" in e &&
                e.id !== u.id &&
                e.ownerId !== u.ownerId &&
                dist(u, e) <= cfg.detectionRange,
            )
            .sort(
              (a, b) =>
                (u.kind === "attacker"
                  ? 0
                  : (a.kind === "robot" ? 0 : 1) -
                    (b.kind === "robot" ? 0 : 1)) || dist(u, a) - dist(u, b),
            ),
          enemyPlayers = nearby
            .filter(
              (p): p is Player =>
                !("kind" in p) &&
                p.id !== u.ownerId &&
                p.alive &&
                now >= p.invulnerableUntil &&
                dist(u, p) <= cfg.detectionRange,
            )
            .sort((a, b) => dist(u, a) - dist(u, b));
        target = enemyUnits[0] ?? enemyPlayers[0];
        u.cachedTargetId = target?.id ?? "";
        u.cachedTargetUntil = target
          ? now + GAME.simulation.targetCacheMs
          : now + GAME.simulation.intermediateIntervalMs;
      }
      if (target) {
        const d = dist(u, target);
        if (
          d <= cfg.range &&
          now - u.lastAttack >= cfg.cooldownMs
        ) {
          u.lastAttack = now;
          if ("kind" in target)
            this.damageUnit(target, cfg.damage);
          else this.damagePlayer(target, cfg.damage, u.ownerId);
          return;
        }
        if (d > cfg.range) {
          u.dirX = (target.x - u.x) / d;
          u.dirY = (target.y - u.y) / d;
          u.nextThink = now + 200;
          directed = true;
        }
      }
      if (!target) {
        const destination =
          u.order === "follow"
            ? { x: owner.x, y: owner.y, radius: 2.2 }
            : u.kind !== "defender" &&
                (u.order === "guard" || u.order === "attack")
              ? {
                  x: u.orderX,
                  y: u.orderY,
                  radius:
                    u.order === "guard"
                        ? 4
                        : 2,
                }
              : undefined;
        if (destination) {
          const d = Math.hypot(destination.x - u.x, destination.y - u.y);
          if (d > destination.radius) {
            u.dirX = (destination.x - u.x) / d;
            u.dirY = (destination.y - u.y) / d;
            u.nextThink = now + 200;
            directed = true;
          } else if (u.order === "follow") {
            u.dirX = u.dirY = 0;
            u.nextThink = now + 200;
            directed = true;
          }
        }
      }
    }
    if (!directed && now >= u.nextThink) {
      u.nextThink = now + 700 + Math.random() * 900;
      const a = Math.random() * Math.PI * 2;
      u.dirX = Math.cos(a);
      u.dirY = Math.sin(a);
    }
    const cfg = GAME.units[u.kind];
    this.moveMobileUnit(u, cfg.speed, dt, defenderStartedAllied);
  }
  moveMobileUnit(u: Unit, speed: number, dt: number, stayOnAlliedTerritory = false) {
    if (!dt || (!u.dirX && !u.dirY)) return;
    const base = Math.atan2(u.dirY, u.dirX),
      offsets = [0, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2];
    for (const offset of offsets) {
      const angle = base + offset,
        dx = Math.cos(angle),
        dy = Math.sin(angle),
        nx = clamp(u.x + dx * speed * dt, 0.1, GAME.map.width - 0.1),
        ny = clamp(u.y + dy * speed * dt, 0.1, GAME.map.height - 0.1);
      if (
        this.isMovementBlocked(nx, ny) ||
        (stayOnAlliedTerritory &&
          this.map.get(key(Math.floor(nx), Math.floor(ny)))?.owner !== u.ownerId)
      ) continue;
      u.x = nx;
      u.y = ny;
      u.dirX = dx;
      u.dirY = dy;
      return;
    }
    u.nextThink = 0;
  }
  damageUnit(u: Unit, n: number) {
    const tile = this.map.get(key(Math.floor(u.x), Math.floor(u.y))),
      reduction = tile?.owner === u.ownerId ? 0.5 : 1;
    u.hp -= n * reduction;
    if (u.hp <= 0) this.removeUnit(u.id);
    else this.markUnit(u.id);
  }
  damagePlayer(p: Player, n: number, attacker: string) {
    p.hp -= n;
    if (p.hp <= 0) {
      const a = this.players.get(attacker);
      if (a) a.kills++;
      this.die(p);
    }
    this.markPlayer(p.id);
  }
  die(p: Player) {
    p.hp = 0;
    const respawn = this.safestOwnedTile(p.id, true) ?? this.safestOwnedTile(p.id);
    if (!respawn) {
      p.alive = false;
      return;
    }
    p.x = respawn.x + 0.5;
    p.y = respawn.y + 0.5;
    p.hp = p.maxHp;
    p.invulnerableUntil = Date.now() + GAME.player.respawnInvulnerabilityMs;
  }
  enforceUnitBounds(u: Unit) {
    if (!Number.isFinite(u.x) || !Number.isFinite(u.y)) {
      const owner = this.players.get(u.ownerId);
      u.x = owner?.x ?? GAME.map.width / 2;
      u.y = owner?.y ?? GAME.map.height / 2;
    }
    if (u.x <= 0.15 || u.x >= GAME.map.width - 0.15) u.dirX *= -1;
    if (u.y <= 0.15 || u.y >= GAME.map.height - 0.15) u.dirY *= -1;
    u.x = clamp(u.x, 0.15, GAME.map.width - 0.15);
    u.y = clamp(u.y, 0.15, GAME.map.height - 0.15);
  }
  private produceFromBastion(u: Unit, now: number) {
    const bastionType = u.bastionType ?? "fortress";
    if (bastionType === "turret") {
      this.attackFromTurret(u, now);
      return;
    }
    if (
      bastionType === "relay" ||
      bastionType === "wall" ||
      now < u.nextProduce
    )
      return;
    if (
      bastionType === "fortress" &&
      [...this.units.values()].filter(
        (unit) =>
          unit.kind === "defender" && unit.sourceBastionId === u.id,
      ).length >= GAME.units.bastion.maxDefenders
    ) {
      u.nextProduce = now + GAME.units.bastion.fortressProductionMs;
      return;
    }
    const kind = bastionType === "factory" ? "robot" : "defender";
    this.spawnProducedUnit(u.ownerId, kind, u.x, u.y, u.id);
    u.nextProduce =
      now +
      (bastionType === "factory"
        ? GAME.units.bastion.factoryProductionMs
        : GAME.units.bastion.fortressProductionMs);
  }
  private attackFromTurret(turret: Unit, now: number) {
    const cfg = GAME.units.bastion;
    if (now - turret.lastAttack < cfg.turretCooldownMs) return;
    let target: Unit | Player | undefined,
      best = Number.POSITIVE_INFINITY;
    for (const entity of this.spatial.query(
      turret.x,
      turret.y,
      cfg.turretRange,
    )) {
      const valid =
        "kind" in entity
          ? entity.id !== turret.id && entity.ownerId !== turret.ownerId
          : entity.id !== turret.ownerId &&
            entity.alive &&
            now >= entity.invulnerableUntil;
      if (!valid) continue;
      const distance = dist(turret, entity);
      if (distance <= cfg.turretRange && distance < best) {
        target = entity;
        best = distance;
      }
    }
    if (!target) return;
    turret.lastAttack = now;
    if ("kind" in target) this.damageUnit(target, cfg.turretDamage);
    else this.damagePlayer(target, cfg.turretDamage, turret.ownerId);
  }
  private updateSupply(now: number) {
    if (now - this.lastSupplyUpdate < GAME.supply.updateIntervalMs) return;
    this.lastSupplyUpdate = now;
    this.suppliedTiles.fill(0);
    const sources = [
      ...[...this.capitals.entries()]
        .filter(([ownerId]) => this.players.get(ownerId)?.alive)
        .map(([ownerId, capital]) => ({ ...capital, ownerId, supplyRadius: GAME.supply.headquartersRadius })),
      ...[...this.units.values()]
        .filter((unit) => unit.kind === "bastion" && unit.bastionType === "relay")
        .map((unit) => ({ ...unit, supplyRadius: GAME.supply.relayRadius })),
    ];
    for (const source of sources) {
      const radius = source.supplyRadius;
      if (!radius) continue;
      const minX = Math.max(0, Math.floor(source.x - radius)),
        maxX = Math.min(GAME.map.width - 1, Math.floor(source.x + radius)),
        minY = Math.max(0, Math.floor(source.y - radius)),
        maxY = Math.min(GAME.map.height - 1, Math.floor(source.y + radius)),
        radiusSquared = radius * radius;
      for (let y = minY; y <= maxY; y++)
        for (let x = minX; x <= maxX; x++) {
          const dx = x + 0.5 - source.x,
            dy = y + 0.5 - source.y;
          if (dx * dx + dy * dy > radiusSquared) continue;
          const tileIndex = y * GAME.map.width + x,
            tile = this.tileList[tileIndex];
          if (tile?.owner === source.ownerId)
            this.suppliedTiles[tileIndex] = 1;
        }
    }
    const suppliedCounts = new Map<string, number>(),
      unsuppliedCounts = new Map<string, number>();
    for (let tileIndex = 0; tileIndex < this.tileList.length; tileIndex++) {
        const tile = this.tileList[tileIndex];
        if (!tile?.owner || tile.obstacle) {
          if (tile) {
            tile.unsuppliedSince = 0;
            tile.supplyDecay = 0;
          }
          continue;
        }
        if (this.suppliedTiles[tileIndex]) {
          suppliedCounts.set(
            tile.owner,
            (suppliedCounts.get(tile.owner) ?? 0) + 1,
          );
          if (tile.unsuppliedSince || tile.supplyDecay) {
            tile.unsuppliedSince = 0;
            tile.supplyDecay = 0;
            this.dirtyTiles.add(
              key(tileIndex % GAME.map.width, Math.floor(tileIndex / GAME.map.width)),
            );
          }
          continue;
        }
        if (!tile.unsuppliedSince) tile.unsuppliedSince = now;
        const elapsed = now - tile.unsuppliedSince;
        if (elapsed >= GAME.supply.decayMs) {
          const tileKey = key(
            tileIndex % GAME.map.width,
            Math.floor(tileIndex / GAME.map.width),
          );
          this.setOwner(tileKey, tile, null);
          continue;
        }
        unsuppliedCounts.set(
          tile.owner,
          (unsuppliedCounts.get(tile.owner) ?? 0) + 1,
        );
        const stage = Math.min(
          GAME.supply.decayStages,
          1 + Math.floor((elapsed / GAME.supply.decayMs) * GAME.supply.decayStages),
        );
        if (stage !== tile.supplyDecay) {
          tile.supplyDecay = stage;
          this.dirtyTiles.add(
            key(tileIndex % GAME.map.width, Math.floor(tileIndex / GAME.map.width)),
          );
        }
      }
    this.suppliedTerritoryCounts.clear();
    this.unsuppliedTerritoryCounts.clear();
    for (const [id, count] of suppliedCounts)
      this.suppliedTerritoryCounts.set(id, count);
    for (const [id, count] of unsuppliedCounts)
      this.unsuppliedTerritoryCounts.set(id, count);
  }
  setOwner(k: string, t: Tile, owner: string | null) {
    if (t.owner === owner) return;
    const previousOwner = t.owner;
    if (previousOwner)
      this.territoryCounts.set(
        previousOwner,
        Math.max(0, (this.territoryCounts.get(previousOwner) ?? 0) - 1),
      );
    t.owner = owner;
    t.unsuppliedSince = 0;
    t.supplyDecay = 0;
    if (owner)
      this.territoryCounts.set(
        owner,
        (this.territoryCounts.get(owner) ?? 0) + 1,
      );
    this.dirtyTiles.add(k);
    this.rustDirtyTiles.add(k);
    const previousCapital = previousOwner && this.capitals.get(previousOwner);
    if (previousCapital && key(previousCapital.x, previousCapital.y) === k)
      this.relocateCapital(previousOwner);
  }
  private relocateCapital(ownerId: string) {
    const replacement = this.safestOwnedTile(ownerId, true) ?? this.safestOwnedTile(ownerId);
    if (replacement) this.capitals.set(ownerId, replacement);
    else this.capitals.delete(ownerId);
  }
  private safestOwnedTile(ownerId: string, suppliedOnly = false) {
    const capital = this.capitals.get(ownerId);
    let best: { x: number; y: number } | undefined,
      bestScore = -1;
    for (let y = 0; y < GAME.map.height; y++)
      for (let x = 0; x < GAME.map.width; x++) {
        const tile = this.map.get(key(x, y));
        if (!tile || tile.owner !== ownerId || tile.obstacle) continue;
        const supplied = this.isTileSupplied(x, y) || (capital?.x === x && capital.y === y);
        if (suppliedOnly && !supplied) continue;
        let nearestEnemy = Number.POSITIVE_INFINITY;
        for (const player of this.players.values())
          if (player.id !== ownerId && player.alive)
            nearestEnemy = Math.min(
              nearestEnemy,
              Math.hypot(x + 0.5 - player.x, y + 0.5 - player.y),
            );
        if (nearestEnemy > bestScore) {
          bestScore = nearestEnemy;
          best = { x, y };
        }
      }
    return best;
  }
  counts(id: string) {
    return this.allCounts().get(id) ?? {
      tiles: this.territoryCounts.get(id) ?? 0,
      robots: 0,
      soldiers: 0,
      bastions: 0,
      headquarters: 0,
    };
  }
  allCounts() {
    const counts = new Map<
      string,
      {
        tiles: number;
        robots: number;
        soldiers: number;
        bastions: number;
        headquarters: number;
      }
    >();
    for (const player of this.players.values())
      counts.set(player.id, {
        tiles: this.territoryCounts.get(player.id) ?? 0,
        robots: 0,
        soldiers: 0,
        bastions: 0,
        headquarters: 0,
      });
    for (const unit of this.units.values()) {
      const owner = counts.get(unit.ownerId);
      if (!owner) continue;
      if (unit.kind === "robot") owner.robots++;
      else if (isCombatKind(unit.kind)) owner.soldiers++;
      else if (unit.kind === "bastion") owner.bastions++;
      else if (unit.kind === "headquarters") owner.headquarters++;
    }
    return counts;
  }
  isTileSupplied(x: number, y: number) {
    if (x < 0 || y < 0 || x >= GAME.map.width || y >= GAME.map.height)
      return false;
    return !!this.suppliedTiles[y * GAME.map.width + x];
  }
  convertPlayerToBot(id: string, name: string) {
    const player = this.players.get(id);
    if (!player) return false;
    player.isBot = true;
    player.name = name;
    player.input = { x: 0, y: 0, attack: false, seq: player.input.seq + 1 };
    this.markPlayer(id);
    return true;
  }
  neutralizePlayer(id: string) {
    const neutralizedUnits: string[] = [];
    this.capitals.delete(id);
    for (const [tileKey, tile] of this.map)
      if (tile.owner === id) this.setOwner(tileKey, tile, null);
    for (const unit of this.units.values())
      if (unit.ownerId === id) {
        unit.ownerId = NEUTRAL_OWNER_ID;
        unit.dirX = 0;
        unit.dirY = 0;
        unit.order = "guard";
        unit.cachedTargetId = "";
        unit.cachedTargetUntil = 0;
        unit.nextSimulationAt = Number.MAX_SAFE_INTEGER;
        this.markUnit(unit.id);
        neutralizedUnits.push(unit.id);
      }
    this.players.delete(id);
    this.territoryCounts.delete(id);
    this.suppliedTerritoryCounts.delete(id);
    this.unsuppliedTerritoryCounts.delete(id);
    this.rustDirtyPlayers.delete(id);
    this.rustRemovedPlayers.set(id, ++this.rustVersion);
    return neutralizedUnits;
  }
  removePlayer(id: string) {
    if (!this.players.delete(id)) return;
    this.capitals.delete(id);
    this.rustDirtyPlayers.delete(id);
    this.rustRemovedPlayers.set(id, ++this.rustVersion);
  }
  private markUnit(id: string) {
    this.rustRemovedUnits.delete(id);
    this.rustDirtyUnits.set(id, ++this.rustVersion);
  }
  private removeUnit(id: string) {
    const unit = this.units.get(id);
    if (!unit || !this.units.delete(id)) return;
    if (unit.kind === "bastion" && unit.bastionType === "wall")
      this.wallTiles.delete(key(Math.floor(unit.x), Math.floor(unit.y)));
    this.rustDirtyUnits.delete(id);
    this.rustRemovedUnits.set(id, ++this.rustVersion);
  }
  private markPlayer(id: string) {
    this.rustRemovedPlayers.delete(id);
    this.rustDirtyPlayers.set(id, ++this.rustVersion);
  }
  private ackVersions(
    pending: Map<string, number>,
    sent: Array<[string, number]>,
  ) {
    for (const [id, version] of sent)
      if (pending.get(id) === version) pending.delete(id);
  }
}
