import { describe, expect, it } from "vitest";
import { AccountService, MemoryAccountStore } from "./accounts.js";
import { scoreForTerritory } from "./room.js";

describe("accounts and global score", () => {
  it("registers, hashes the password and authenticates case-insensitively", async () => {
    const store = new MemoryAccountStore();
    const service = new AccountService(store);
    const registered = await service.register("Joueur_1", "mot-de-passe-solide");
    const stored = await store.findByUsername("joueur_1");

    expect(stored?.passwordHash).toMatch(/^scrypt\$/);
    expect(stored?.passwordHash).not.toContain("mot-de-passe-solide");
    expect((await service.login("JOUEUR_1", "mot-de-passe-solide")).account.id)
      .toBe(registered.account.id);
    await expect(service.login("Joueur_1", "incorrect!"))
      .rejects.toThrow("Identifiants incorrects");
  });

  it("awards a match only once and orders the leaderboard", async () => {
    const service = new AccountService(new MemoryAccountStore());
    const first = await service.register("Alpha", "mot-de-passe-a");
    const second = await service.register("Bravo", "mot-de-passe-b");

    await service.awardScore(first.account.id, "11111111-1111-4111-8111-111111111111", 250);
    await service.awardScore(first.account.id, "11111111-1111-4111-8111-111111111111", 250);
    await service.awardScore(second.account.id, "22222222-2222-4222-8222-222222222222", 400);

    expect(await service.leaderboard()).toEqual([
      { ...second.account, score: 400 },
      { ...first.account, score: 250 },
    ]);
  });

  it("converts captured territory to a 0–1000 score", () => {
    expect(scoreForTerritory(0, 400)).toBe(0);
    expect(scoreForTerritory(100, 400)).toBe(250);
    expect(scoreForTerritory(401, 400)).toBe(1000);
  });
});
