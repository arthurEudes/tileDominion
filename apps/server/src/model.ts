import { GAME } from "@tile/game-config";
export type Tile = {
  owner: string | null;
  obstacle: boolean;
  unsuppliedSince: number;
  supplyDecay: number;
};
export type BastionType =
  | "fortress"
  | "factory"
  | "relay"
  | "wall"
  | "turret";
export type Player = {
  id: string;
  name: string;
  x: number;
  y: number;
  color: number;
  hp: number;
  maxHp: number;
  money: number;
  kills: number;
  alive: boolean;
  isBot: boolean;
  input: { x: number; y: number; attack: boolean; seq: number };
  captureKey: string;
  captureSince: number;
  lastAttack: number;
  invulnerableUntil: number;
  upgrades: { speed: number; armor: number; capture: number };
};
export type Unit = {
  id: string;
  ownerId: string;
  kind:
    | "robot"
    | "soldier"
    | "attacker"
    | "defender"
    | "bastion"
    | "headquarters";
  x: number;
  y: number;
  hp: number;
  dirX: number;
  dirY: number;
  nextThink: number;
  lastAttack: number;
  captureKey: string;
  captureSince: number;
  nextProduce: number;
  order: "wander" | "follow" | "guard" | "attack";
  orderX: number;
  orderY: number;
  nextSimulationAt: number;
  lastSimulatedAt: number;
  cachedTargetId: string;
  cachedTargetUntil: number;
  bastionType?: BastionType;
  homeX?: number;
  homeY?: number;
  sourceBastionId?: string;
};
export const key = (x: number, y: number) => `${x},${y}`;
export function makeMap(
  w = GAME.map.width,
  h = GAME.map.height,
  random = Math.random,
) {
  const m = new Map<string, Tile>();
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      m.set(key(x, y), {
        owner: null,
        obstacle: random() < GAME.map.obstacleRate,
        unsuppliedSince: 0,
        supplyDecay: 0,
      });
  return m;
}
export function tileCount(map: Map<string, Tile>, id: string) {
  let n = 0;
  for (const t of map.values()) if (t.owner === id) n++;
  return n;
}
export function clamp(v: number, a: number, b: number) {
  return Math.max(a, Math.min(b, v));
}
export function dist(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
