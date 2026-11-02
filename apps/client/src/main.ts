import Phaser from "phaser";
import { Client, Room } from "colyseus.js";
import {
  expandSnapshot,
  type CompactSnapshot,
  type ClientSnapshot,
  type UnitView,
} from "@tile/protocol";
import { GAME } from "@tile/game-config";
import "./style.css";
let room: Room | null = null,
  myId = "",
  snap: ClientSnapshot | null = null,
  seq = 0,
  sceneRef: Dominion | null = null;
const clientUnits = new Map<number, UnitView>();
const $ = (s: string) => document.querySelector(s) as HTMLElement;
class Dominion extends Phaser.Scene {
  tileChunks = new Map<
    string,
    {
      texture: Phaser.Textures.CanvasTexture;
      image: Phaser.GameObjects.Image;
    }
  >();
  tileColors = new Map<string, number>();
  obstacles = new Set<string>();
  mapBase?: Phaser.GameObjects.Rectangle;
  actors = new Map<string, Phaser.GameObjects.Container>();
  unitBobs = new Map<number, Phaser.GameObjects.Bob>();
  unitOutlineBobs = new Map<number, Phaser.GameObjects.Bob>();
  unitRender = new Map<
    number,
    {
      kind: UnitView["kind"];
      hp: number;
      maxHp: number;
      nextProduce: number;
      size: number;
      bastionType?: UnitView["bastionType"];
      ownerId: string;
      homeX?: number;
      homeY?: number;
    }
  >();
  unitBlitters = new Map<UnitView["kind"], Phaser.GameObjects.Blitter>();
  unitOutlineBlitters = new Map<
    UnitView["kind"],
    Phaser.GameObjects.Blitter
  >();
  unitOverlay?: Phaser.GameObjects.Graphics;
  targets = new Map<string | number, { x: number; y: number }>();
  previousHp = new Map<string | number, number>();
  selected = new Set<number>();
  unitServerIds = new Map<number, string>();
  pendingAction:
    | "fortress"
    | "factory"
    | "relay"
    | "wall"
    | "turret"
    | "guard"
    | "attack"
    | null = null;
  selectionStart?: Phaser.Math.Vector2;
  selectionBox?: Phaser.GameObjects.Rectangle;
  cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  keys: any;
  stick = { x: 0, y: 0 };
  inputElapsed = 0;
  localInput = { x: 0, y: 0 };
  create() {
    sceneRef = this;
    this.cameras.main.setBackgroundColor(0x0a1827);
    this.cursors = this.input.keyboard!.createCursorKeys();
    this.keys = this.input.keyboard!.addKeys("W,A,S,D,Z,Q,SPACE");
    this.cameras.main.setZoom(1.15);
    this.createUnitBatches();
    this.setupTouch();
    this.input.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      const point = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
      if (this.pendingAction && room) {
        const x = Math.floor(point.x / 32),
          y = Math.floor(point.y / 32);
        if (
          this.pendingAction === "fortress" ||
          this.pendingAction === "factory" ||
          this.pendingAction === "relay" ||
          this.pendingAction === "wall" ||
          this.pendingAction === "turret"
        )
          room.send("build", { kind: this.pendingAction, x, y });
        else {
          room.send("order", {
            unitIds: [...this.selected].flatMap((id) => {
              const serverId = this.unitServerIds.get(id);
              return serverId ? [serverId] : [];
            }),
            mode: this.pendingAction,
            x: x + 0.5,
            y: y + 0.5,
          });
          this.showOrderZone(point.x, point.y, this.pendingAction);
        }
        this.pendingAction = null;
        $("#mode").textContent = "";
        return;
      }
      if (pointer.leftButtonDown()) {
        let clicked: UnitView | undefined,
          best = 18 * 18;
        for (const unit of clientUnits.values()) {
          if (
            (unit.kind !== "soldier" && unit.kind !== "attacker") ||
            unit.ownerId !== myId
          )
            continue;
          const dx = unit.x * 32 - point.x,
            dy = unit.y * 32 - point.y,
            distance = dx * dx + dy * dy;
          if (distance <= best) {
            best = distance;
            clicked = unit;
          }
        }
        if (clicked) {
          if (!pointer.event.shiftKey) this.selected.clear();
          if (this.selected.has(clicked.id)) this.selected.delete(clicked.id);
          else this.selected.add(clicked.id);
          $("#selectionCount").textContent = `${this.selected.size} attaquant(s)`;
          return;
        }
      }
      if (!pointer.leftButtonDown()) return;
      this.selectionStart = new Phaser.Math.Vector2(point.x, point.y);
      this.selectionBox?.destroy();
      this.selectionBox = this.add
        .rectangle(point.x, point.y, 1, 1, 0x39e6d0, 0.12)
        .setStrokeStyle(2, 0x39e6d0, 0.95)
        .setDepth(100);
    });
    this.input.on("pointermove", (pointer: Phaser.Input.Pointer) => {
      if (!this.selectionStart || !this.selectionBox || !pointer.isDown) return;
      const point = this.cameras.main.getWorldPoint(pointer.x, pointer.y),
        left = Math.min(this.selectionStart.x, point.x),
        top = Math.min(this.selectionStart.y, point.y);
      this.selectionBox.setPosition(
        left + Math.abs(point.x - this.selectionStart.x) / 2,
        top + Math.abs(point.y - this.selectionStart.y) / 2,
      );
      this.selectionBox.setSize(
        Math.max(1, Math.abs(point.x - this.selectionStart.x)),
        Math.max(1, Math.abs(point.y - this.selectionStart.y)),
      );
      this.selectionBox.setDisplaySize(
        this.selectionBox.width,
        this.selectionBox.height,
      );
    });
    this.input.on("pointerup", (pointer: Phaser.Input.Pointer) => {
      if (!this.selectionStart) return;
      const point = this.cameras.main.getWorldPoint(pointer.x, pointer.y),
        minX = Math.min(this.selectionStart.x, point.x),
        maxX = Math.max(this.selectionStart.x, point.x),
        minY = Math.min(this.selectionStart.y, point.y),
        maxY = Math.max(this.selectionStart.y, point.y),
        additive = !!pointer.event.shiftKey;
      if (!additive) this.selected.clear();
      for (const unit of snap?.units ?? [])
        if (
          (unit.kind === "soldier" || unit.kind === "attacker") &&
          unit.ownerId === myId &&
          unit.x * 32 >= minX &&
          unit.x * 32 <= maxX &&
          unit.y * 32 >= minY &&
          unit.y * 32 <= maxY
        )
          this.selected.add(unit.id);
      $("#selectionCount").textContent = `${this.selected.size} attaquant(s)`;
      this.selectionStart = undefined;
      this.selectionBox?.destroy();
      this.selectionBox = undefined;
    });
  }
  createUnitBatches() {
    const definitions: Array<[UnitView["kind"], number]> = [
      ["robot", 15],
      ["soldier", 16],
      ["attacker", 16],
      ["defender", 18],
      ["bastion", 28],
      ["headquarters", 38],
    ];
    const drawShape = (
      context: CanvasRenderingContext2D,
      kind: UnitView["kind"],
      size: number,
      inset: number,
    ) => {
      context.fillStyle = "#ffffff";
      if (kind === "soldier" || kind === "attacker") {
        context.beginPath();
        context.moveTo(size / 2, inset);
        context.lineTo(size - inset, size - inset);
        context.lineTo(inset, size - inset);
        context.closePath();
        context.fill();
      } else if (kind === "defender") {
        context.beginPath();
        context.arc(
          size / 2,
          size / 2,
          size / 2 - inset,
          0,
          Math.PI * 2,
        );
        context.fill();
      } else
        context.fillRect(inset, inset, size - inset * 2, size - inset * 2);
    };
    for (const [kind, size] of definitions) {
      const key = `unit-${kind}`,
        outlineKey = `unit-outline-${kind}`,
        texture = this.textures.createCanvas(key, size, size),
        outlineTexture = this.textures.createCanvas(outlineKey, size, size);
      if (!texture || !outlineTexture)
        throw new Error(`Impossible de créer les textures ${key}`);
      drawShape(outlineTexture.context, kind, size, 0);
      drawShape(texture.context, kind, size, 2);
      texture.refresh();
      outlineTexture.refresh();
      this.unitOutlineBlitters.set(
        kind,
        this.add.blitter(0, 0, outlineKey).setDepth(14),
      );
      this.unitBlitters.set(
        kind,
        this.add.blitter(0, 0, key).setDepth(15),
      );
    }
    this.unitOverlay = this.add.graphics().setDepth(16);
  }
  renderTiles(
    tiles: ClientSnapshot["tiles"],
    owners: Map<string, number>,
  ) {
    const chunkSize = 16,
      tileSize = 32,
      refreshed = new Set<Phaser.Textures.CanvasTexture>();
    for (const [x, y, ownerId, obstacle, supplyDecay] of tiles) {
      const key = `${x},${y}`,
        color = obstacle
          ? 0x52657a
          : ownerId
            ? (owners.get(ownerId) ?? 0x465565)
            : 0x10263a,
        visualState = color * 16 + supplyDecay;
      if (this.tileColors.get(key) === visualState) continue;
      this.tileColors.set(key, visualState);
      const chunkX = Math.floor(x / chunkSize),
        chunkY = Math.floor(y / chunkSize),
        chunkKey = `${chunkX},${chunkY}`;
      let chunk = this.tileChunks.get(chunkKey);
      if (!chunk) {
        if (!ownerId && !obstacle) continue;
        const textureKey = `tile-chunk-${chunkKey}`,
          texture = this.textures.createCanvas(
            textureKey,
            chunkSize * tileSize,
            chunkSize * tileSize,
          );
        if (!texture)
          throw new Error(`Impossible de créer le chunk ${chunkKey}`);
        texture.context.imageSmoothingEnabled = false;
        chunk = {
          texture,
          image: this.add
            .image(chunkX * chunkSize * tileSize, chunkY * chunkSize * tileSize, textureKey)
            .setOrigin(0)
            .setDepth(0),
        };
        this.tileChunks.set(chunkKey, chunk);
      }
      const localX = (x % chunkSize) * tileSize,
        localY = (y % chunkSize) * tileSize,
        context = chunk.texture.context;
      context.clearRect(localX, localY, tileSize, tileSize);
      if (ownerId || obstacle) {
        context.fillStyle = `#${color.toString(16).padStart(6, "0")}`;
        context.fillRect(localX + 1, localY + 1, tileSize - 2, tileSize - 2);
        context.strokeStyle = obstacle ? "#9fb3c8" : "#1c3b52";
        context.lineWidth = 1;
        context.strokeRect(
          localX + 1.5,
          localY + 1.5,
          tileSize - 3,
          tileSize - 3,
        );
        if (ownerId && supplyDecay > 0) {
          const progress = Phaser.Math.Clamp(
              supplyDecay / GAME.supply.decayStages,
              0,
              1,
            ),
            squareSize = 1 + progress * 9;
          context.fillStyle = "#10263a";
          for (const centerY of [6, 16, 26])
            for (const centerX of [6, 16, 26])
              context.fillRect(
                localX + centerX - squareSize / 2,
                localY + centerY - squareSize / 2,
                squareSize,
                squareSize,
              );
        }
      }
      refreshed.add(chunk.texture);
    }
    for (const texture of refreshed) texture.refresh();
  }
  update(_time: number, delta: number) {
    const blend = 1 - Math.exp(-delta / 70);
    for (const [id, a] of this.actors) {
      const t = this.targets.get(id);
      if (t) {
        a.x = Phaser.Math.Linear(a.x, t.x, blend);
        a.y = Phaser.Math.Linear(a.y, t.y, blend);
      }
    }
    const view = this.cameras.main.worldView,
      margin = 96,
      overlay = this.unitOverlay,
      defenderZones = new Set<string>();
    overlay?.clear();
    for (const [id, bob] of this.unitBobs) {
      const target = this.targets.get(id),
        state = this.unitRender.get(id),
        outline = this.unitOutlineBobs.get(id);
      if (!target || !state) continue;
      bob.x = Phaser.Math.Linear(bob.x, target.x - state.size / 2, blend);
      bob.y = Phaser.Math.Linear(bob.y, target.y - state.size / 2, blend);
      if (outline) {
        outline.x = bob.x;
        outline.y = bob.y;
      }
      const visible =
        target.x >= view.x - margin &&
        target.x <= view.right + margin &&
        target.y >= view.y - margin &&
        target.y <= view.bottom + margin;
      bob.setVisible(visible);
      outline?.setVisible(visible);
      if (!visible || !overlay) continue;
      const ratio = Phaser.Math.Clamp(state.hp / state.maxHp, 0, 1);
      if (ratio < 1) {
        overlay.fillStyle(0x160c16, 0.9).fillRect(target.x - 15, target.y - 20, 30, 5);
        overlay
          .fillStyle(
            ratio > 0.5 ? 0x43e38f : ratio > 0.25 ? 0xffd166 : 0xff5263,
            1,
          )
          .fillRect(target.x - 14, target.y - 21.5, 28 * ratio, 3);
      }
      if (this.selected.has(id))
        overlay
          .lineStyle(3, 0xffd166, 1)
          .strokeRect(
            target.x - state.size / 2 - 3,
            target.y - state.size / 2 - 3,
            state.size + 6,
            state.size + 6,
          );
      if (
        state.kind === "defender" &&
        state.ownerId === myId &&
        state.homeX !== undefined &&
        state.homeY !== undefined
      ) {
        const zoneKey = `${Math.round(state.homeX)},${Math.round(state.homeY)}`;
        if (!defenderZones.has(zoneKey)) {
          defenderZones.add(zoneKey);
        overlay
          .lineStyle(1, 0x39e6d0, 0.22)
          .strokeCircle(
            state.homeX * 32,
            state.homeY * 32,
            GAME.units.defender.guardRadius * 32,
          );
        }
      }
      if (
        state.kind === "bastion" &&
        (state.bastionType === "fortress" ||
          state.bastionType === "factory") &&
        snap
      ) {
        const productionMs =
          state.bastionType === "factory"
            ? GAME.units.bastion.factoryProductionMs
            : GAME.units.bastion.fortressProductionMs;
        const progress = Phaser.Math.Clamp(
          1 - (state.nextProduce - snap.now) / productionMs,
          0,
          1,
        );
        overlay.fillStyle(0x101a2b, 0.95).fillRect(target.x - 15, target.y - 28, 30, 5);
        overlay.fillStyle(0xffd166, 1).fillRect(target.x - 14, target.y - 29.5, 28 * progress, 3);
      }
      if (state.kind === "bastion" && state.bastionType === "relay")
        overlay
          .lineStyle(2, 0x39e6d0, 0.9)
          .strokeCircle(target.x, target.y, state.size / 2 + 4);
      else if (state.kind === "bastion" && state.bastionType === "fortress") {
        overlay.lineStyle(2, 0xffffff, 0.85);
        overlay.lineBetween(target.x - 6, target.y, target.x + 6, target.y);
        overlay.lineBetween(target.x, target.y - 6, target.x, target.y + 6);
      } else if (state.kind === "bastion" && state.bastionType === "factory")
        overlay
          .lineStyle(2, 0xffd166, 0.9)
          .strokeRect(target.x - 6, target.y - 6, 12, 12);
      else if (state.kind === "bastion" && state.bastionType === "wall") {
        overlay.lineStyle(3, 0xdfe8f2, 1);
        overlay.lineBetween(target.x - 8, target.y - 6, target.x + 8, target.y - 6);
        overlay.lineBetween(target.x - 8, target.y + 6, target.x + 8, target.y + 6);
      } else if (
        state.kind === "bastion" &&
        state.bastionType === "turret"
      ) {
        overlay
          .lineStyle(2, 0xffffff, 0.95)
          .strokeCircle(target.x, target.y, 7);
        overlay.lineBetween(target.x, target.y, target.x + 10, target.y);
      }
    }
    if (!room) return;
    let x =
        (this.cursors.right.isDown || this.keys.D.isDown ? 1 : 0) -
        (this.cursors.left.isDown || this.keys.A.isDown || this.keys.Q.isDown
          ? 1
          : 0) +
        this.stick.x,
      y =
        (this.cursors.down.isDown || this.keys.S.isDown ? 1 : 0) -
        (this.cursors.up.isDown || this.keys.W.isDown || this.keys.Z.isDown
          ? 1
          : 0) +
        this.stick.y;
    const len = Math.max(1, Math.hypot(x, y));
    x /= len;
    y /= len;
    this.localInput = { x, y };
    this.inputElapsed += delta;
    if (this.inputElapsed >= 50) {
      this.inputElapsed %= 50;
      room.send("input", {
        seq: ++seq,
        x,
        y,
        attack: this.keys.SPACE.isDown || attackDown,
      });
    }
    const own = this.actors.get(myId),
      target = this.targets.get(myId);
    if (own && target) {
      const speedLevel =
          snap?.players.find((p) => p.id === myId)?.upgrades.speed ?? 0,
        step =
          (GAME.player.speed *
            (1 + speedLevel * GAME.upgrades.speed.bonus) *
            32 *
            delta) /
          1000,
        nx = target.x + x * step,
        ny = target.y + y * step;
      if (
        !this.obstacles.has(
          `${Math.floor(nx / 32)},${Math.floor(target.y / 32)}`,
        )
      )
        target.x = nx;
      if (
        !this.obstacles.has(
          `${Math.floor(target.x / 32)},${Math.floor(ny / 32)}`,
        )
      )
        target.y = ny;
    }
  }
  showOrderZone(x: number, y: number, mode: "guard" | "attack") {
    const color = mode === "attack" ? 0xff5263 : 0x39e6d0,
      zone = this.add
        .circle(x, y, mode === "attack" ? 64 : 128, color, 0.12)
        .setStrokeStyle(3, color, 0.9)
        .setDepth(30);
    this.tweens.add({
      targets: zone,
      alpha: 0,
      duration: 1100,
      onComplete: () => zone.destroy(),
    });
  }
  impact(x: number, y: number) {
    const flash = this.add.circle(x, y, 8, 0xffd166, 0.95).setDepth(50);
    this.tweens.add({
      targets: flash,
      scale: 2.5,
      alpha: 0,
      duration: 260,
      onComplete: () => flash.destroy(),
    });
    for (let i = 0; i < 4; i++) {
      const spark = this.add
          .rectangle(x, y, 4, 4, i % 2 ? 0xff5263 : 0xffffff)
          .setDepth(51),
        a = Math.random() * Math.PI * 2;
      this.tweens.add({
        targets: spark,
        x: x + Math.cos(a) * 24,
        y: y + Math.sin(a) * 24,
        alpha: 0,
        duration: 280,
        onComplete: () => spark.destroy(),
      });
    }
  }
  setupTouch() {
    const el = $("#stick"),
      knob = el.firstElementChild as HTMLElement;
    const move = (e: PointerEvent) => {
      const r = el.getBoundingClientRect(),
        dx = e.clientX - (r.left + r.width / 2),
        dy = e.clientY - (r.top + r.height / 2),
        l = Math.max(1, Math.hypot(dx, dy)),
        m = Math.min(38, l);
      this.stick = { x: dx / l, y: dy / l };
      knob.style.transform = `translate(${(dx / l) * m}px,${(dy / l) * m}px)`;
    };
    el.addEventListener("pointerdown", (e) => {
      el.setPointerCapture(e.pointerId);
      move(e);
    });
    el.addEventListener("pointermove", (e) => {
      if (el.hasPointerCapture(e.pointerId)) move(e);
    });
    el.addEventListener("pointerup", () => {
      this.stick = { x: 0, y: 0 };
      knob.style.transform = "";
    });
  }
  render(s: ClientSnapshot) {
    snap = s;
    if (!this.mapBase)
      this.mapBase = this.add
        .rectangle(
          s.width * 16,
          s.height * 16,
          s.width * 32,
          s.height * 32,
          0x10263a,
        )
        .setStrokeStyle(8, 0x39e6d0)
        .setDepth(-2);
    const owners = new Map(s.players.map((p) => [p.id, p.color]));
    this.renderTiles(s.tiles, owners);
    const alivePlayers = new Set<string>();
    for (const p of s.players) {
      alivePlayers.add(p.id);
      let a = this.actors.get(p.id);
      if (!a) {
        const shadow = this.add.rectangle(2, 5, 20, 20, 0x000000, 0.3);
        const body = this.add
          .rectangle(0, 0, 20, 20, p.color)
          .setStrokeStyle(3, 0xffffff);
        const name = this.add
          .text(0, -22, p.name, {
            fontFamily: "Rajdhani",
            fontSize: "13px",
            color: "#fff",
            stroke: "#000",
            strokeThickness: 3,
          })
          .setOrigin(0.5);
        a = this.add
          .container(p.x * 32, p.y * 32, [shadow, body, name])
          .setDepth(20);
        this.actors.set(p.id, a);
        if (p.id === myId) this.cameras.main.startFollow(a, true, 0.1, 0.1);
      } else a.setDepth(20);
      const tx = p.x * 32,
        ty = p.y * 32,
        current = this.targets.get(p.id);
      if (
        p.id === myId &&
        current &&
        Math.hypot(current.x - tx, current.y - ty) < 64
      ) {
        current.x = Phaser.Math.Linear(current.x, tx, 0.28);
        current.y = Phaser.Math.Linear(current.y, ty, 0.28);
      } else this.targets.set(p.id, { x: tx, y: ty });
      a.setAlpha(p.alive ? 1 : 0.25);
      const oldHp = this.previousHp.get(p.id);
      if (oldHp !== undefined && p.hp < oldHp) this.impact(tx, ty);
      this.previousHp.set(p.id, p.hp);
      if (p.id === myId) updateHud(p, s);
    }
    for (const id of s.unitDelta.removed) this.removeActor(id);
    for (const id of [
      ...s.unitDelta.created,
      ...s.unitDelta.updated,
    ]) {
      const u = clientUnits.get(id);
      if (!u) continue;
      this.unitServerIds.set(u.id, u.serverId);
      const size =
        u.kind === "robot"
          ? 15
          : u.kind === "soldier" || u.kind === "attacker"
            ? 16
            : u.kind === "defender"
              ? 18
            : u.kind === "bastion"
              ? 28
              : 38;
      let bob = this.unitBobs.get(u.id);
      if (!bob) {
        const outline = this.unitOutlineBlitters
          .get(u.kind)!
          .create(u.x * 32 - size / 2, u.y * 32 - size / 2);
        bob = this.unitBlitters
          .get(u.kind)!
          .create(u.x * 32 - size / 2, u.y * 32 - size / 2)
          .setTint(owners.get(u.ownerId) ?? 0x8b96a5);
        this.unitBobs.set(u.id, bob);
        this.unitOutlineBobs.set(u.id, outline);
      }
      bob.setTint(owners.get(u.ownerId) ?? 0x8b96a5);
      this.targets.set(u.id, { x: u.x * 32, y: u.y * 32 });
      this.unitRender.set(u.id, {
        kind: u.kind,
        hp: u.hp,
        maxHp: u.maxHp,
        nextProduce: u.nextProduce,
        size,
        bastionType: u.bastionType,
        ownerId: u.ownerId,
        homeX: u.homeX,
        homeY: u.homeY,
      });
      const oldHp = this.previousHp.get(u.id);
      if (oldHp !== undefined && u.hp < oldHp) this.impact(u.x * 32, u.y * 32);
      this.previousHp.set(u.id, u.hp);
    }
    for (const id of this.actors.keys())
      if (typeof id === "string" && !alivePlayers.has(id))
        this.removeActor(id);
  }
  removeActor(id: string | number) {
    if (typeof id === "string") {
      this.actors.get(id)?.destroy();
      this.actors.delete(id);
    }
    this.targets.delete(id);
    this.previousHp.delete(id);
    if (typeof id === "number") {
      this.unitBobs.get(id)?.destroy();
      this.unitBobs.delete(id);
      this.unitOutlineBobs.get(id)?.destroy();
      this.unitOutlineBobs.delete(id);
      this.unitRender.delete(id);
      this.selected.delete(id);
      this.unitServerIds.delete(id);
    }
  }
}
const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: "game",
  width: innerWidth,
  height: innerHeight,
  pixelArt: true,
  scene: [Dominion],
  scale: { mode: Phaser.Scale.RESIZE },
});
let attackDown = false;
$("#attack").addEventListener("pointerdown", () => (attackDown = true));
$("#attack").addEventListener("pointerup", () => (attackDown = false));
$("#shopToggle").onclick = () => {
  const s = $("#shop");
  s.hidden = !s.hidden;
};
document
  .querySelectorAll("[data-buy]")
  .forEach((b) =>
    b.addEventListener("click", () =>
      room?.send("buy", { item: (b as HTMLElement).dataset.buy }),
    ),
  );
document.querySelectorAll("[data-build]").forEach((button) =>
  button.addEventListener("click", () => {
    if (!sceneRef) return;
    const kind = (button as HTMLElement).dataset.build as
      | "fortress"
      | "factory"
      | "relay"
      | "wall"
      | "turret";
    sceneRef.pendingAction = kind;
    $("#mode").textContent =
      `Clique sur une tuile alliée pour placer ${kind === "fortress" ? "la forteresse" : kind === "factory" ? "l’usine" : kind === "relay" ? "le relais" : kind === "wall" ? "le mur" : "la tourelle"}`;
  }),
);
document.querySelectorAll("[data-order]").forEach((button) =>
  button.addEventListener("click", () => {
    if (!sceneRef || !room || !sceneRef.selected.size) {
      showNotice("Sélectionne au moins un attaquant", false);
      return;
    }
    const mode = (button as HTMLElement).dataset.order as
      "follow" | "guard" | "attack";
    if (mode === "follow") {
      room.send("order", {
        unitIds: [...sceneRef.selected].flatMap((id) => {
          const serverId = sceneRef!.unitServerIds.get(id);
          return serverId ? [serverId] : [];
        }),
        mode,
      });
      $("#mode").textContent = "";
    } else {
      sceneRef.pendingAction = mode;
      $("#mode").textContent =
        `Clique sur le centre de la zone à ${mode === "guard" ? "garder" : "attaquer"}`;
    }
  }),
);
$("#play").onclick = async () => {
  const name =
    (document.querySelector("#name") as HTMLInputElement).value.trim() ||
    `Invité_${Math.floor(Math.random() * 9999)}`;
  $("#play").textContent = "CONNEXION…";
  try {
    room = await new Client(
      import.meta.env.VITE_SERVER_URL ?? "http://localhost:2567",
    ).joinOrCreate("dominion", { name });
    myId = room.sessionId;
    room.onMessage("state", (wire: CompactSnapshot) => {
      const s = expandSnapshot(wire, clientUnits);
      for (const [x, y, , ob] of s.tiles) {
        const k = `${x},${y}`;
        if (ob) sceneRef?.obstacles.add(k);
        else sceneRef?.obstacles.delete(k);
      }
      sceneRef?.render(s);
    });
    room.onMessage(
      "purchase",
      (r: {
        ok: boolean;
        money: number;
        message: string;
        robots: number;
        soldiers: number;
      }) => {
        $("#money").textContent = `◈ ${r.money}`;
        showNotice(r.message, r.ok);
        const units = document.querySelector("#units");
        if (units) units.textContent = `R ${r.robots} · S ${r.soldiers}`;
      },
    );
    room.onMessage("orderResult", (r: { ok: boolean; message: string }) =>
      showNotice(r.message, r.ok),
    );
    room.send("ready");
    room.onLeave(() => {
      $("#connection").style.color = "#ff5263";
    });
    $("#menu").style.display = "none";
    $("#hud").hidden = false;
  } catch (e) {
    console.error(e);
    $("#play").textContent = "SERVEUR INJOIGNABLE — RÉESSAYER";
  }
};
function showNotice(message: string, ok: boolean) {
  let n = document.querySelector("#notice") as HTMLElement | null;
  if (!n) {
    n = document.createElement("div");
    n.id = "notice";
    Object.assign(n.style, {
      position: "fixed",
      zIndex: "20",
      top: "62px",
      left: "50%",
      transform: "translateX(-50%)",
      padding: "9px 14px",
      background: "#081425ee",
      border: "2px solid #39e6d0",
      pointerEvents: "none",
    });
    document.body.appendChild(n);
  }
  n.textContent = message;
  n.style.borderColor = ok ? "#39e6d0" : "#ff5263";
  n.style.color = ok ? "#eaf2ff" : "#ff8792";
  n.style.opacity = "1";
  setTimeout(() => {
    if (n) n.style.opacity = "0";
  }, 1200);
}
function updateHud(
  p: ClientSnapshot["players"][number],
  s: ClientSnapshot,
) {
  $("#money").textContent = `◈ ${p.money}`;
  $("#hp").textContent = `♥ ${Math.ceil(p.hp)}/${p.maxHp}`;
  $("#tiles").textContent = `▦ ${p.tiles}`;
  $("#globalUnits").textContent = `♟ ${s.globalUnits}`;
  const sec = Math.max(0, Math.ceil((s.endsAt - s.now) / 1000));
  $("#time").textContent =
    `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
  $("#leader").innerHTML =
    `<b>CLASSEMENT</b><br>` +
    s.leaderboard
      .slice(0, 7)
      .map(
        (v, i) =>
          `${i + 1}. <span style="color:#${v.color.toString(16).padStart(6, "0")}">${escapeHtml(v.name)}</span> — ${v.tiles}`,
      )
      .join("<br>");
}
function escapeHtml(v: string) {
  return v.replace(
    /[&<>'"]/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[
        c
      ]!,
  );
}
