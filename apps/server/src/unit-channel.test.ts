import { describe, expect, it } from "vitest";
import type { ServerUnitView } from "@tile/protocol";
import { DominionRoom } from "./room.js";

function roomWithoutRuntime() {
  const room = Object.create(DominionRoom.prototype) as DominionRoom;
  room.unitChannels = new Map();
  return room;
}

function unit(id: string): ServerUnitView {
  return {
    id,
    ownerId: "p1",
    kind: "robot",
    x: 10,
    y: 10,
    hp: 45,
    maxHp: 45,
    nextProduce: 0,
  };
}

describe("per-client unit channel lifecycle", () => {
  it("releases numeric mappings when units leave the interest area", () => {
    const room = roomWithoutRuntime(),
      created = room.unitDelta("client", [unit("u1")], true),
      firstNumericId = created[0][0][0];
    expect(room.unitChannels.get("client")?.ids.size).toBe(1);

    expect(room.unitDelta("client", [])[2]).toEqual([firstNumericId]);
    expect(room.unitChannels.get("client")?.ids.size).toBe(0);
    expect(room.unitChannels.get("client")?.previous.size).toBe(0);

    const reentered = room.unitDelta("client", [unit("u1")]);
    expect(reentered[0][0][0]).toBeGreaterThan(firstNumericId);
  });
});
