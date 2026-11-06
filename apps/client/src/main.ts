import Phaser from "phaser";
import { Client, Room } from "colyseus.js";
import { decode } from "@msgpack/msgpack";
import {
  expandSnapshot,
  type CompactSnapshot,
  type ClientSnapshot,
  type UnitView,
} from "@tile/protocol";
import { GAME } from "@tile/game-config";
import { MenuBattle } from "./menu-battle";
import "./style.css";
const menuBattle = new MenuBattle(document.querySelector("#menuBattle") as HTMLCanvasElement);
let room: Room | null = null,
  myId = "",
  snap: ClientSnapshot | null = null,
  seq = 0,
  sceneRef: Dominion | null = null;
const serverUrl = import.meta.env.VITE_SERVER_URL ?? "http://localhost:2567";
const errorContext = { roomId: "", matchId: "" };
let lastReportedError = "";
function reportClientError(kind: "error" | "unhandledrejection", error: unknown, source?: string) {
  const value = error instanceof Error ? error : new Error(String(error));
  const fingerprint = `${kind}:${value.message}:${source ?? ""}`;
  if (fingerprint === lastReportedError) return;
  lastReportedError = fingerprint;
  void fetch(`${serverUrl}/client-errors`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind,
      message: value.message,
      stack: value.stack,
      source,
      ...errorContext,
    }),
    keepalive: true,
  }).catch(() => {});
}
window.addEventListener("error", (event) =>
  reportClientError("error", event.error ?? event.message, event.filename));
window.addEventListener("unhandledrejection", (event) =>
  reportClientError("unhandledrejection", event.reason));
type Account = {
  id: string;
  username: string;
  score: number;
  country: string;
  bestTerritory: number;
};
type RankChange = { before: number; after: number; gained: number } | null;
type MatchResult = {
  points: number;
  score: number;
  authenticated: boolean;
  country: string;
  placement: number;
  totalPlayers: number;
  winner: string;
  standings: Array<{
    id: string;
    name: string;
    tiles: number;
    kills: number;
    isBot: boolean;
  }>;
  rankings: { world: RankChange; country: RankChange } | null;
  stats: {
    maxTerritory: number;
    tilesCaptured: number;
    tilesLost: number;
    kills: number;
    unitsProduced: number;
    buildingsProduced: number;
    territoryHistory: Array<[number, number]>;
  };
  personalBest: { value: number; isNew: boolean };
};
let authToken = localStorage.getItem("tileDominionToken") ?? "";
let account: Account | null = (() => {
  try {
    return JSON.parse(localStorage.getItem("tileDominionAccount") ?? "null");
  } catch {
    return null;
  }
})();
const clientUnits = new Map<number, UnitView>();
const rustIds = new Map<number, string>();
let pendingRustUnitDelta = { created: [] as number[], updated: [] as number[], removed: [] as number[] };
type RustUnitFrame = [
  Array<[number, number, number, number, number, number, number, number, number, number]>,
  Array<[number, number, number, number, number]>,
  number[],
  boolean,
];
const maxHpFor = (kind: UnitView["kind"], bastionType?: UnitView["bastionType"]) =>
  kind === "bastion" && bastionType === "wall" ? GAME.units.bastion.wallHp
    : kind === "bastion" && bastionType === "turret" ? GAME.units.bastion.turretHp
      : GAME.units[kind].hp;
const $ = (s: string) => document.querySelector(s) as HTMLElement;
function setAccount(next: Account | null, token = "") {
  account = next;
  authToken = token;
  if (next) {
    localStorage.setItem("tileDominionToken", token);
    localStorage.setItem("tileDominionAccount", JSON.stringify(next));
    $("#accountStatus").textContent = `${next.username} · ${next.score} points`;
    $("#play").textContent = `JOUER AVEC ${next.username.toUpperCase()}`;
    (document.querySelector("#name") as HTMLInputElement).value = next.username;
    (document.querySelector("#country") as HTMLInputElement).value = next.country ?? "XX";
  } else {
    localStorage.removeItem("tileDominionToken");
    localStorage.removeItem("tileDominionAccount");
    $("#accountStatus").textContent = "Mode invité — le score ne sera pas enregistré.";
    $("#play").textContent = "JOUER EN INVITÉ";
  }
}

async function authenticate(path: "login" | "register") {
  const username = (document.querySelector("#name") as HTMLInputElement).value.trim();
  const password = (document.querySelector("#password") as HTMLInputElement).value;
  const country = (document.querySelector("#country") as HTMLInputElement).value;
  const status = $("#accountStatus");
  status.textContent = path === "register" ? "Création du compte…" : "Connexion…";
  try {
    const response = await fetch(`${serverUrl}/auth/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username,
        password,
        ...(path === "register" ? { country } : {}),
      }),
    });
    const body = await response.json() as { token?: string; account?: Account; error?: string };
    if (!response.ok || !body.token || !body.account)
      throw new Error(body.error ?? "Authentification impossible");
    setAccount(body.account, body.token);
    (document.querySelector("#password") as HTMLInputElement).value = "";
    await loadGlobalLeaderboard();
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : "Authentification impossible";
  }
}

async function loadGlobalLeaderboard() {
  const target = $("#globalLeaderboard").querySelector("span")!;
  try {
    const response = await fetch(`${serverUrl}/leaderboard`);
    if (!response.ok) throw new Error();
    const { players } = await response.json() as { players: Account[] };
    target.innerHTML = players.length
      ? players.slice(0, 10).map((player, index) =>
          `${index + 1}. ${escapeHtml(player.username)} — ${player.score} pts`,
        ).join("<br>")
      : "Aucun score pour le moment.";
  } catch {
    target.textContent = "Classement indisponible.";
  }
}

const COSMETICS = [
  { score: 0, name: "Étendard de recrue", icon: "◆" },
  { score: 50, name: "Bannière azur", icon: "◇" },
  { score: 150, name: "Bordure conquérant", icon: "⬡" },
  { score: 300, name: "Trace émeraude", icon: "✦" },
  { score: 500, name: "Forteresse royale", icon: "♜" },
  { score: 800, name: "Couronne du Dominion", icon: "♛" },
];

function rankLabel(change: RankChange, gainTarget: HTMLElement) {
  if (!change) {
    gainTarget.textContent = "Compte ou pays requis";
    return "—";
  }
  gainTarget.textContent = change.gained
    ? change.gained > 0
      ? `▲ ${change.gained} place${change.gained > 1 ? "s" : ""}`
      : `▼ ${Math.abs(change.gained)} place${change.gained < -1 ? "s" : ""}`
    : "Position maintenue";
  return `#${change.after}`;
}

function cosmeticFor(score: number) {
  let index = 0;
  while (index + 1 < COSMETICS.length && score >= COSMETICS[index + 1].score)
    index++;
  const current = COSMETICS[index];
  const next = COSMETICS[index + 1];
  const progress = next
    ? (score - current.score) / (next.score - current.score)
    : 1;
  return { current, next, progress: Math.max(0, Math.min(1, progress)) };
}

function showMatchEnd(result: MatchResult) {
  const won = result.placement === 1;
  $("#endTitle").textContent = won ? "VICTOIRE" : `TOP ${result.placement}`;
  $("#endWinner").textContent = won
    ? "Votre royaume domine la carte."
    : `${result.winner} remporte cette bataille.`;
  $("#endPlacement").innerHTML =
    `<strong>#${result.placement} / ${result.totalPlayers}</strong>` +
    `<span>${result.authenticated ? `+${result.points} points · ${result.score} au total` : "Partie invitée · score non enregistré"}</span>`;
  const countryGain = $("#countryRankGain");
  const worldGain = $("#worldRankGain");
  $("#countryRank").textContent = rankLabel(result.rankings?.country ?? null, countryGain);
  $("#worldRank").textContent = rankLabel(result.rankings?.world ?? null, worldGain);
  const countryLabel = result.country === "XX" ? "PAYS" : `PAYS · ${result.country}`;
  $("#countryRank").parentElement!.querySelector("span")!.textContent = `CLASSEMENT ${countryLabel}`;
  const stats = [
    ["Territoire maximal", result.stats.maxTerritory],
    ["Cases capturées", result.stats.tilesCaptured],
    ["Cases perdues", result.stats.tilesLost],
    ["Éliminations", result.stats.kills],
    ["Unités produites", result.stats.unitsProduced],
    ["Bâtiments produits", result.stats.buildingsProduced],
  ];
  $("#endStats").innerHTML = stats.map(([label, value]) =>
    `<article><span>${label}</span><strong>${value}</strong></article>`,
  ).join("") +
    `<article class="record"><span>${result.personalBest.isNew ? "NOUVEAU RECORD" : "Record personnel"}</span><strong>${result.personalBest.value}</strong></article>`;
  $("#territoryPeak").textContent = `PIC · ${result.stats.maxTerritory}`;
  const cosmetic = cosmeticFor(result.score);
  $("#cosmeticIcon").textContent = cosmetic.current.icon;
  $("#cosmeticName").textContent = cosmetic.current.name;
  $("#cosmeticNext").textContent = cosmetic.next
    ? `${result.score}/${cosmetic.next.score} points · prochain : ${cosmetic.next.name}`
    : "Collection actuelle terminée";
  ($("#cosmeticProgress") as HTMLElement).style.width = `${cosmetic.progress * 100}%`;
  $("#finalStandings").innerHTML = result.standings.map((entry, index) =>
    `<li class="${entry.id === myId ? "me" : ""} ${index === 0 ? "winner" : ""}">` +
    `<b>${index + 1}</b><span>${escapeHtml(entry.name)}${entry.isBot ? " <small>IA</small>" : ""}</span>` +
    `<em>${entry.tiles} ▦</em></li>`,
  ).join("");
  $("#matchEnd").hidden = false;
  requestAnimationFrame(() => drawTerritoryChart(result.stats.territoryHistory));
}

function drawTerritoryChart(points: Array<[number, number]>) {
  const canvas = document.querySelector("#territoryChart") as HTMLCanvasElement;
  const width = Math.max(320, Math.floor(canvas.clientWidth * devicePixelRatio));
  const height = Math.max(130, Math.floor(canvas.clientHeight * devicePixelRatio));
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return;
  context.clearRect(0, 0, width, height);
  const padding = 16 * devicePixelRatio;
  const values = points.length ? points : [[0, 0] as [number, number]];
  const maxTime = Math.max(1, ...values.map(([time]) => time));
  const maxTiles = Math.max(1, ...values.map(([, tiles]) => tiles));
  const position = ([time, tiles]: [number, number]) => ({
    x: padding + (time / maxTime) * (width - padding * 2),
    y: height - padding - (tiles / maxTiles) * (height - padding * 2),
  });
  context.strokeStyle = "#28445d";
  context.lineWidth = devicePixelRatio;
  for (let row = 0; row <= 3; row++) {
    const y = padding + (row / 3) * (height - padding * 2);
    context.beginPath(); context.moveTo(padding, y); context.lineTo(width - padding, y); context.stroke();
  }
  const gradient = context.createLinearGradient(0, padding, 0, height);
  gradient.addColorStop(0, "#39e6d088");
  gradient.addColorStop(1, "#39e6d005");
  context.beginPath();
  values.forEach((point, index) => {
    const { x, y } = position(point);
    if (index) context.lineTo(x, y); else context.moveTo(x, y);
  });
  const last = position(values.at(-1)!);
  context.lineTo(last.x, height - padding);
  context.lineTo(position(values[0]).x, height - padding);
  context.closePath(); context.fillStyle = gradient; context.fill();
  context.beginPath();
  values.forEach((point, index) => {
    const { x, y } = position(point);
    if (index) context.lineTo(x, y); else context.moveTo(x, y);
  });
  context.strokeStyle = "#39e6d0";
  context.lineWidth = 3 * devicePixelRatio;
  context.lineJoin = "round";
  context.stroke();
}
class Dominion extends Phaser.Scene {
  tileChunks = new Map<
    string,
    {
      texture: Phaser.Textures.CanvasTexture;
      image: Phaser.GameObjects.Image;
    }
  >();
  tileColors = new Map<string, number>();
  tileOwners = new Map<string, string | null>();
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
    | "guard"
    | "attack"
    | null = null;
  buildTile?: { x: number; y: number };
  selectionStart?: Phaser.Math.Vector2;
  selectionBox?: Phaser.GameObjects.Rectangle;
  cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  keys: any;
  stick = { x: 0, y: 0 };
  inputElapsed = 0;
  localInput = { x: 0, y: 0 };
  impactBudget = 0;
  resetMatch() {
    for (const { texture, image } of this.tileChunks.values()) {
      image.destroy();
      texture.destroy();
    }
    for (const actor of this.actors.values()) actor.destroy();
    for (const bob of this.unitBobs.values()) bob.destroy();
    for (const bob of this.unitOutlineBobs.values()) bob.destroy();
    this.tileChunks.clear();
    this.tileColors.clear();
    this.tileOwners.clear();
    this.obstacles.clear();
    this.actors.clear();
    this.unitBobs.clear();
    this.unitOutlineBobs.clear();
    this.unitRender.clear();
    this.targets.clear();
    this.previousHp.clear();
    this.selected.clear();
    this.unitServerIds.clear();
    this.pendingAction = null;
    this.buildTile = undefined;
    $("#buildMenu").hidden = true;
  }
  create() {
    sceneRef = this;
    this.cameras.main.setBackgroundColor(0x0a1827);
    this.cursors = this.input.keyboard!.createCursorKeys();
    this.keys = this.input.keyboard!.addKeys("W,A,S,D,Z,Q");
    this.input.mouse?.disableContextMenu();
    this.cameras.main.setZoom(1.15);
    this.createUnitBatches();
    this.setupTouch();
    this.input.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      const point = this.cameras.main.getWorldPoint(pointer.x, pointer.y),
        buildMenuWasOpen = !$("#buildMenu").hidden;
      $("#buildMenu").hidden = true;
      if (pointer.rightButtonDown()) {
        this.buildTile = undefined;
        return;
      }
      if (buildMenuWasOpen && pointer.leftButtonDown()) {
        this.buildTile = undefined;
        return;
      }
      if (this.pendingAction && room) {
        const x = Math.floor(point.x / 32),
          y = Math.floor(point.y / 32);
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
        wasClick = Phaser.Math.Distance.Between(
          this.selectionStart.x,
          this.selectionStart.y,
          point.x,
          point.y,
        ) < 8,
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
      if (wasClick) this.openBuildMenu(pointer.x, pointer.y, point.x, point.y);
    });
  }
  openBuildMenu(screenX: number, screenY: number, worldX: number, worldY: number) {
    const x = Math.floor(worldX / 32),
      y = Math.floor(worldY / 32),
      key = `${x},${y}`;
    if (this.tileOwners.get(key) !== myId || this.obstacles.has(key)) {
      this.buildTile = undefined;
      $("#buildMenu").hidden = true;
      return;
    }
    this.buildTile = { x, y };
    const menu = $("#buildMenu");
    menu.style.left = `${screenX}px`;
    menu.style.top = `${screenY}px`;
    menu.hidden = false;
  }
  buildAtSelectedTile(kind: "fortress" | "factory" | "relay") {
    if (!room || !this.buildTile) return;
    room.send("build", { kind, ...this.buildTile });
    this.buildTile = undefined;
    $("#buildMenu").hidden = true;
  }
  createUnitBatches() {
    const definitions: Array<[UnitView["kind"], number]> = [
      ["robot", 15],
      ["soldier", 16],
      ["attacker", 16],
      ["defender", 18],
      ["bastion", 28],
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
      this.tileOwners.set(key, ownerId);
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
  pruneTileCache(tiles: ClientSnapshot["tiles"]) {
    const chunkSize = 16,
      retainedChunks = new Set(
        tiles.map(([x, y]) =>
          `${Math.floor(x / chunkSize)},${Math.floor(y / chunkSize)}`,
        ),
      ),
      chunkForTile = (tileKey: string) => {
        const [x, y] = tileKey.split(",").map(Number);
        return `${Math.floor(x / chunkSize)},${Math.floor(y / chunkSize)}`;
      };
    for (const [chunkKey, chunk] of this.tileChunks) {
      if (retainedChunks.has(chunkKey)) continue;
      chunk.image.destroy();
      this.textures.remove(chunk.texture.key);
      this.tileChunks.delete(chunkKey);
    }
    for (const tileKey of this.tileColors.keys())
      if (!retainedChunks.has(chunkForTile(tileKey)))
        this.tileColors.delete(tileKey);
    for (const tileKey of this.tileOwners.keys())
      if (!retainedChunks.has(chunkForTile(tileKey)))
        this.tileOwners.delete(tileKey);
    for (const tileKey of this.obstacles)
      if (!retainedChunks.has(chunkForTile(tileKey)))
        this.obstacles.delete(tileKey);
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
      if (state.kind === "bastion" && state.bastionType === "relay") {
        if (state.ownerId === myId)
          overlay
            .lineStyle(1, 0x39e6d0, 0.16)
            .strokeCircle(target.x, target.y, GAME.supply.relayRadius * 32);
        overlay.lineStyle(2, 0x39e6d0, 0.95);
        overlay.strokeCircle(target.x, target.y, state.size / 2 + 5);
        overlay.strokeCircle(target.x, target.y, state.size / 2 + 10);
        overlay.beginPath();
        overlay.moveTo(target.x, target.y - 9);
        overlay.lineTo(target.x + 9, target.y);
        overlay.lineTo(target.x, target.y + 9);
        overlay.lineTo(target.x - 9, target.y);
        overlay.closePath();
        overlay.strokePath();
        overlay.fillStyle(0xffffff, 1).fillCircle(target.x, target.y, 3);
      }
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
        attack: false,
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
    const view = this.cameras.main.worldView,
      margin = 32;
    if (
      this.impactBudget <= 0 ||
      x < view.x - margin ||
      x > view.right + margin ||
      y < view.y - margin ||
      y > view.bottom + margin
    )
      return;
    this.impactBudget--;
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
  render(s: ClientSnapshot, fullState = false) {
    snap = s;
    this.impactBudget = 6;
    if (fullState) this.pruneTileCache(s.tiles);
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
    const owners = new Map(s.leaderboard.map((p) => [p.id, p.color]));
    for (const player of s.players) owners.set(player.id, player.color);
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
type MinimapMessage = [
  0 | 1,
  number,
  number,
  Array<[number, string | null]>,
];
class StrategicMinimap {
  private context: CanvasRenderingContext2D;
  private marker: HTMLElement;
  private owners: Array<string | null> = [];
  private colors = new Map<string, number>();
  private width = 0;
  private height = 0;
  constructor(private canvas: HTMLCanvasElement, root: HTMLElement) {
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas de mini-carte indisponible");
    this.context = context;
    this.marker = root.querySelector("i") as HTMLElement;
  }
  resetMatch() {
    this.owners = [];
    this.colors.clear();
    this.width = 0;
    this.height = 0;
    this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.marker.hidden = true;
  }
  apply([full, width, height, changes]: MinimapMessage) {
    if (full || width !== this.width || height !== this.height) {
      this.width = width;
      this.height = height;
      this.canvas.width = width;
      this.canvas.height = height;
      this.owners = new Array<string | null>(width * height).fill(null);
      this.context.fillStyle = "#10263a";
      this.context.fillRect(0, 0, width, height);
    }
    for (const [index, owner] of changes) {
      if (index < 0 || index >= this.owners.length) continue;
      this.owners[index] = owner;
      this.drawCell(index, owner);
    }
  }
  updateWorld(snapshot: ClientSnapshot, playerId: string) {
    let paletteChanged = false;
    for (const player of snapshot.leaderboard)
      if (this.colors.get(player.id) !== player.color) {
        this.colors.set(player.id, player.color);
        paletteChanged = true;
      }
    if (paletteChanged) this.redraw();
    const player = snapshot.players.find(({ id }) => id === playerId);
    if (!player) {
      this.marker.hidden = true;
      return;
    }
    this.marker.hidden = false;
    this.marker.style.left = `${(player.x / snapshot.width) * 100}%`;
    this.marker.style.top = `${(player.y / snapshot.height) * 100}%`;
  }
  private redraw() {
    if (!this.width || !this.height) return;
    this.context.fillStyle = "#10263a";
    this.context.fillRect(0, 0, this.width, this.height);
    for (let index = 0; index < this.owners.length; index++) {
      const owner = this.owners[index];
      if (owner) this.drawCell(index, owner);
    }
  }
  private drawCell(index: number, owner: string | null) {
    const color = owner ? (this.colors.get(owner) ?? 0x465565) : 0x10263a;
    this.context.fillStyle = `#${color.toString(16).padStart(6, "0")}`;
    this.context.fillRect(index % this.width, Math.floor(index / this.width), 1, 1);
  }
}
const minimapRoot = $("#minimap"),
  minimap = new StrategicMinimap(
    minimapRoot.querySelector("canvas") as HTMLCanvasElement,
    minimapRoot,
  );
const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: "game",
  width: innerWidth,
  height: innerHeight,
  pixelArt: true,
  scene: [Dominion],
  scale: { mode: Phaser.Scale.RESIZE },
});
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
document.querySelectorAll("[data-tile-build]").forEach((button) =>
  button.addEventListener("click", () => {
    const kind = (button as HTMLElement).dataset.tileBuild as
      | "fortress"
      | "factory"
      | "relay";
    sceneRef?.buildAtSelectedTile(kind);
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
$("#login").onclick = () => void authenticate("login");
$("#register").onclick = () => void authenticate("register");
const countryInput = document.querySelector("#country") as HTMLInputElement;
const localeCountry = navigator.language.split("-")[1]?.toUpperCase();
countryInput.value = /^[A-Z]{2}$/.test(localeCountry ?? "") ? localeCountry! : "FR";
if (account && authToken) setAccount(account, authToken);
void loadGlobalLeaderboard();

$("#play").onclick = async () => {
  const name =
    (document.querySelector("#name") as HTMLInputElement).value.trim() ||
    `Invité_${Math.floor(Math.random() * 9999)}`;
  $("#play").textContent = "CONNEXION…";
  try {
    room = await new Client(serverUrl).joinOrCreate("dominion", {
      name,
      ...(authToken ? { token: authToken } : {}),
    });
    myId = room.sessionId;
    room.onMessage("welcome", (payload: { roomId: string; matchId: string }) => {
      errorContext.roomId = payload.roomId;
      errorContext.matchId = payload.matchId;
    });
    room.onMessage("unitIds", (payload: Uint8Array | Array<[number, string]>) => {
      const mappings = payload instanceof Uint8Array
        ? decode(payload) as Array<[number, string]>
        : payload;
      for (const [id, value] of mappings) rustIds.set(id, value);
    });
    room.onMessage("units", (payload: Uint8Array) => {
      const [created, updated, removed, full] = decode(payload) as RustUnitFrame;
      const removedIds = full ? [...clientUnits.keys()] : [...removed];
      if (full) clientUnits.clear();
      for (const u of created) {
        const kind: UnitView["kind"] = u[2] === 0 ? "robot" : u[2] === 1 ? "soldier"
          : u[2] === 2 ? "bastion"
            : u[2] === 4 ? "attacker" : "defender";
        const bastionType: UnitView["bastionType"] = u[7] === 1 ? "fortress"
          : u[7] === 2 ? "factory" : u[7] === 3 ? "relay"
            : u[7] === 4 ? "wall" : u[7] === 5 ? "turret" : undefined;
        clientUnits.set(u[0], {
          id: u[0], serverId: rustIds.get(u[0]) ?? String(u[0]),
          ownerId: rustIds.get(u[1]) ?? "neutral", kind,
          x: u[3] / 128, y: u[4] / 128, hp: u[5], maxHp: maxHpFor(kind, bastionType),
          nextProduce: u[6], bastionType,
          homeX: kind === "defender" ? u[8] / 128 : undefined,
          homeY: kind === "defender" ? u[9] / 128 : undefined,
        });
      }
      for (const u of updated) {
        const current = clientUnits.get(u[0]);
        if (!current) continue;
        current.x = u[1] / 128; current.y = u[2] / 128;
        current.hp = u[3]; current.nextProduce = u[4];
      }
      for (const id of removed) clientUnits.delete(id);
      pendingRustUnitDelta = {
        created: created.map((u) => u[0]),
        updated: updated.map((u) => u[0]),
        removed: removedIds,
      };
    });
    room.onMessage("state", (payload: CompactSnapshot | Uint8Array) => {
      const wire = payload instanceof Uint8Array
        ? (decode(payload) as CompactSnapshot)
        : payload;
      const s = expandSnapshot(wire, clientUnits);
      s.unitDelta = pendingRustUnitDelta;
      pendingRustUnitDelta = { created: [], updated: [], removed: [] };
      for (const [x, y, , ob] of s.tiles) {
        const k = `${x},${y}`;
        if (ob) sceneRef?.obstacles.add(k);
        else sceneRef?.obstacles.delete(k);
      }
      minimap.updateWorld(s, myId);
      sceneRef?.render(s, !!wire[5][3]);
    });
    room.onMessage("minimap", (payload: MinimapMessage | Uint8Array) => {
      const wire = payload instanceof Uint8Array
        ? (decode(payload) as MinimapMessage)
        : payload;
      minimap.apply(wire);
      if (snap) minimap.updateWorld(snap, myId);
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
    room.onMessage("account", (updated: Account) => setAccount(updated, authToken));
    room.onMessage("matchResult", (result: MatchResult) => {
      if (account) setAccount({ ...account, score: result.score }, authToken);
      showMatchEnd(result);
      void loadGlobalLeaderboard();
    });
    room.onMessage("newMatch", (payload: { roomId: string; matchId: string }) => {
      errorContext.roomId = payload.roomId;
      errorContext.matchId = payload.matchId;
      clientUnits.clear();
      rustIds.clear();
      pendingRustUnitDelta = { created: [], updated: [], removed: [] };
      snap = null;
      sceneRef?.resetMatch();
      minimap.resetMatch();
      room?.send("ready");
      showNotice("Nouvelle partie lancée", true);
    });
    room.send("ready");
    room.onLeave(() => {
      $("#connection").style.color = "#ff5263";
    });
    $("#menu").style.display = "none";
    menuBattle.stop();
    $("#hud").hidden = false;
  } catch (e) {
    console.error(e);
    $("#play").textContent = "CONNEXION REFUSÉE — SE RECONNECTER";
  }
};

async function returnToMenu(focusMode = false) {
  $("#matchEnd").hidden = true;
  $("#hud").hidden = true;
  if (room) {
    const leaving = room;
    room = null;
    await leaving.leave(true).catch(() => {});
  }
  $("#menu").style.display = "grid";
  menuBattle.start();
  setAccount(account, authToken);
  if (focusMode) $("#modeChooser").scrollIntoView({ behavior: "smooth", block: "center" });
}

$("#replayMatch").onclick = () => {
  $("#matchEnd").hidden = true;
  showNotice("Nouvelle conquête lancée", true);
};
$("#changeMode").onclick = () => void returnToMenu(true);
$("#quitMatch").onclick = () => void returnToMenu(false);

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
