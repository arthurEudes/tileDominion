import { describe, expect, it } from "vitest";
import {
  expandSnapshot,
  POSITION_SCALE,
  type CompactSnapshot,
  type UnitView,
} from "@tile/protocol";

const base = (units: CompactSnapshot[5]): CompactSnapshot => [
  1000,
  2000,
  404,
  404,
  [],
  units,
  [],
  [],
  0,
];

describe("client unit delta protocol", () => {
  it("creates, updates and removes quantized numeric units in place", () => {
    const units = new Map<number, UnitView>();
    const created = expandSnapshot(
      base([[[7, "u7", "p1", 0, 269, 525, 45, 45, 0, 0, 0, 0]], [], [], 1]),
      units,
    );
    expect(created.units[0]).toMatchObject({
      id: 7,
      serverId: "u7",
      ownerId: "p1",
      x: 269 / POSITION_SCALE,
      y: 525 / POSITION_SCALE,
    });
    expect(created.unitDelta).toEqual({ created: [7], updated: [], removed: [] });
    const sameUnit = created.units[0];

    const updated = expandSnapshot(
      base([[], [[7, 512, 768, 30, 0]], [], 0]),
      units,
    );
    expect(updated.units[0]).toBe(sameUnit);
    expect(updated.units[0]).toMatchObject({ x: 4, y: 6, hp: 30 });
    expect(updated.unitDelta).toEqual({ created: [], updated: [7], removed: [] });

    expect(expandSnapshot(base([[], [], [7], 0]), units).units).toHaveLength(0);
  });

  it("preserves the bastion specialization", () => {
    const units = new Map<number, UnitView>();
    const snapshot = expandSnapshot(
      base([[[9, "u9", "p1", 2, 512, 512, 420, 420, 9000, 3, 0, 0]], [], [], 1]),
      units,
    );
    expect(snapshot.units[0]).toMatchObject({
      kind: "bastion",
      bastionType: "relay",
    });
  });

  it("preserves the defender role and its home circle", () => {
    const units = new Map<number, UnitView>();
    const snapshot = expandSnapshot(
      base([[[10, "u10", "p1", 5, 768, 768, 210, 210, 0, 0, 512, 640]], [], [], 1]),
      units,
    );
    expect(snapshot.units[0]).toMatchObject({
      kind: "defender",
      homeX: 4,
      homeY: 5,
    });
  });

  it("preserves wall and turret specializations", () => {
    const units = new Map<number, UnitView>();
    const snapshot = expandSnapshot(
      base([
        [
          [11, "wall", "p1", 2, 128, 128, 750, 750, 0, 4, 0, 0],
          [12, "turret", "p1", 2, 256, 128, 360, 360, 0, 5, 0, 0],
        ],
        [],
        [],
        1,
      ]),
      units,
    );
    expect(snapshot.units.map((unit) => unit.bastionType)).toEqual([
      "wall",
      "turret",
    ]);
  });
});
