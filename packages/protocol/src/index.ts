import { z } from "zod";
export const POSITION_SCALE = 128;
export const InputSchema = z.object({
  seq: z.number().int().nonnegative(),
  x: z.number().min(-1).max(1),
  y: z.number().min(-1).max(1),
  attack: z.boolean().optional(),
});
export const BuySchema = z.object({
  item: z.enum([
    "robot",
    "soldier",
    "attacker",
    "defender",
    "speed",
    "armor",
    "capture",
  ]),
});
export const BuildSchema = z.object({
  kind: z.enum(["fortress", "factory", "relay", "wall", "turret"]),
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
});
export const OrderSchema = z.object({
  unitIds: z.array(z.string()).min(1).max(100),
  mode: z.enum(["follow", "guard", "attack"]),
  x: z.number().optional(),
  y: z.number().optional(),
});
export const JoinSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2)
    .max(16)
    .regex(/^[\p{L}\p{N}_ -]+$/u)
    .default("Invité"),
  token: z.string().max(128).optional(),
});
export type Input = z.infer<typeof InputSchema>;
export type BuyItem = z.infer<typeof BuySchema>["item"];
export type SoldierOrder = z.infer<typeof OrderSchema>;
export type PlayerView = {
  id: string;
  name: string;
  x: number;
  y: number;
  color: number;
  hp: number;
  maxHp: number;
  money: number;
  tiles: number;
  kills: number;
  robots: number;
  soldiers: number;
  alive: boolean;
  invulnerableUntil: number;
  upgrades: { speed: number; armor: number; capture: number };
};
export type UnitView = {
  id: number;
  serverId: string;
  ownerId: string;
  kind:
    | "robot"
    | "soldier"
    | "attacker"
    | "defender"
    | "bastion";
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  nextProduce: number;
  bastionType?: "fortress" | "factory" | "relay" | "wall" | "turret";
  homeX?: number;
  homeY?: number;
};
export type ServerUnitView = Omit<UnitView, "id" | "serverId"> & {
  id: string;
};
export type SnapshotBase<TUnit> = {
  now: number;
  endsAt: number;
  width: number;
  height: number;
  players: PlayerView[];
  units: TUnit[];
  tiles: Array<[number, number, string | null, 0 | 1, number]>;
  leaderboard: Array<{
    id: string;
    name: string;
    color: number;
    tiles: number;
    kills: number;
  }>;
  globalUnits: number;
};
export type Snapshot = SnapshotBase<ServerUnitView>;
export type ClientSnapshot = SnapshotBase<UnitView> & {
  unitDelta: { created: number[]; updated: number[]; removed: number[] };
};
export type CompactUnitDelta = [
  Array<
    [
      number,
      string,
      string,
      0 | 1 | 2 | 3 | 4 | 5,
      number,
      number,
      number,
      number,
      number,
      0 | 1 | 2 | 3 | 4 | 5,
      number,
      number,
    ]
  >,
  Array<[number, number, number, number, number]>,
  number[],
  0 | 1,
];
export type CompactSnapshot = [
  number,
  number,
  number,
  number,
  Array<
    [
      string,
      string,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      0 | 1,
      number,
      number,
      number,
      number,
    ]
  >,
  CompactUnitDelta,
  Snapshot["tiles"],
  Array<[string, string, number, number, number]>,
  number,
];
export function compactSnapshot(
  s: Snapshot,
  unitDelta: CompactUnitDelta,
): CompactSnapshot {
  return [
    s.now,
    s.endsAt,
    s.width,
    s.height,
    s.players.map((p) => [
      p.id,
      p.name,
      p.x,
      p.y,
      p.color,
      p.hp,
      p.maxHp,
      p.money,
      p.tiles,
      p.kills,
      p.robots,
      p.soldiers,
      p.alive ? 1 : 0,
      p.invulnerableUntil,
      p.upgrades.speed,
      p.upgrades.armor,
      p.upgrades.capture,
    ]),
    unitDelta,
    s.tiles,
    s.leaderboard.map((v) => [v.id, v.name, v.color, v.tiles, v.kills]),
    s.globalUnits,
  ];
}
export function expandSnapshot(
  w: CompactSnapshot,
  units: Map<number, UnitView>,
): ClientSnapshot {
  const removed = w[5][3] ? [...units.keys()] : [...w[5][2]];
  if (w[5][3]) units.clear();
  for (const u of w[5][0])
    units.set(u[0], {
      id: u[0],
      serverId: u[1],
      ownerId: u[2],
      kind:
        u[3] === 0
          ? "robot"
          : u[3] === 1
            ? "soldier"
            : u[3] === 2
              ? "bastion"
              : u[3] === 4
                ? "attacker"
                : "defender",
      x: u[4] / POSITION_SCALE,
      y: u[5] / POSITION_SCALE,
      hp: u[6],
      maxHp: u[7],
      nextProduce: u[8],
      bastionType:
        u[9] === 1
          ? "fortress"
          : u[9] === 2
            ? "factory"
            : u[9] === 3
              ? "relay"
              : u[9] === 4
                ? "wall"
                : u[9] === 5
                  ? "turret"
              : undefined,
      homeX: u[3] === 5 ? u[10] / POSITION_SCALE : undefined,
      homeY: u[3] === 5 ? u[11] / POSITION_SCALE : undefined,
    });
  for (const u of w[5][1]) {
    const current = units.get(u[0]);
    if (!current) continue;
    current.x = u[1] / POSITION_SCALE;
    current.y = u[2] / POSITION_SCALE;
    current.hp = u[3];
    current.nextProduce = u[4];
  }
  for (const id of w[5][2]) units.delete(id);
  return {
    now: w[0],
    endsAt: w[1],
    width: w[2],
    height: w[3],
    players: w[4].map((p) => ({
      id: p[0],
      name: p[1],
      x: p[2],
      y: p[3],
      color: p[4],
      hp: p[5],
      maxHp: p[6],
      money: p[7],
      tiles: p[8],
      kills: p[9],
      robots: p[10],
      soldiers: p[11],
      alive: !!p[12],
      invulnerableUntil: p[13],
      upgrades: { speed: p[14], armor: p[15], capture: p[16] },
    })),
    units: [...units.values()],
    tiles: w[6],
    leaderboard: w[7].map((v) => ({
      id: v[0],
      name: v[1],
      color: v[2],
      tiles: v[3],
      kills: v[4],
    })),
    globalUnits: w[8],
    unitDelta: {
      created: w[5][0].map((unit) => unit[0]),
      updated: w[5][1].map((unit) => unit[0]),
      removed,
    },
  };
}
