import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { Pool } from "pg";

const scrypt = promisify(scryptCallback);
const USERNAME_PATTERN = /^[\p{L}\p{N}_-]{3,16}$/u;
const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;

export type PublicAccount = {
  id: string;
  username: string;
  score: number;
  country: string;
  bestTerritory: number;
};

export type AccountRanking = { world: number; country: number | null };

type StoredAccount = PublicAccount & { passwordHash: string };

export interface AccountStore {
  initialize(): Promise<void>;
  create(username: string, passwordHash: string, country: string): Promise<PublicAccount>;
  findByUsername(username: string): Promise<StoredAccount | null>;
  awardScore(
    id: string,
    matchId: string,
    points: number,
    bestTerritory: number,
  ): Promise<PublicAccount | null>;
  leaderboard(limit: number): Promise<PublicAccount[]>;
  ranking(id: string): Promise<AccountRanking | null>;
  health(): Promise<boolean>;
  close(): Promise<void>;
}

export class MemoryAccountStore implements AccountStore {
  private accounts = new Map<string, StoredAccount>();
  private byUsername = new Map<string, string>();
  private awards = new Set<string>();

  async initialize() {}

  async create(username: string, passwordHash: string, country: string) {
    const normalized = normalizeUsername(username);
    if (this.byUsername.has(normalized)) throw duplicateUsernameError();
    const account: StoredAccount = {
      id: randomBytes(16).toString("hex"),
      username,
      passwordHash,
      score: 0,
      country,
      bestTerritory: 0,
    };
    this.accounts.set(account.id, account);
    this.byUsername.set(normalized, account.id);
    return publicAccount(account);
  }

  async findByUsername(username: string) {
    const id = this.byUsername.get(normalizeUsername(username));
    return id ? this.accounts.get(id) ?? null : null;
  }

  async awardScore(id: string, matchId: string, points: number, bestTerritory: number) {
    const account = this.accounts.get(id);
    if (!account) return null;
    const awardKey = `${matchId}:${id}`;
    if (!this.awards.has(awardKey)) {
      account.score += sanitizePoints(points);
      account.bestTerritory = Math.max(account.bestTerritory, sanitizeTerritory(bestTerritory));
      this.awards.add(awardKey);
    }
    return publicAccount(account);
  }

  async leaderboard(limit: number) {
    return [...this.accounts.values()]
      .sort((a, b) => b.score - a.score || a.username.localeCompare(b.username))
      .slice(0, limit)
      .map(publicAccount);
  }

  async ranking(id: string) {
    const account = this.accounts.get(id);
    if (!account) return null;
    const sorted = [...this.accounts.values()].sort(compareAccounts);
    const world = sorted.findIndex((candidate) => candidate.id === id) + 1;
    const country = account.country === "XX"
      ? null
      : sorted.filter((candidate) => candidate.country === account.country)
          .findIndex((candidate) => candidate.id === id) + 1;
    return { world, country };
  }

  async health() { return true; }

  async close() {}
}

export class PostgresAccountStore implements AccountStore {
  private pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async initialize() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS accounts (
        id UUID PRIMARY KEY,
        username VARCHAR(16) NOT NULL,
        username_normalized VARCHAR(16) NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        score BIGINT NOT NULL DEFAULT 0 CHECK (score >= 0),
        country CHAR(2) NOT NULL DEFAULT 'XX',
        best_territory INTEGER NOT NULL DEFAULT 0 CHECK (best_territory >= 0),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.pool.query("ALTER TABLE accounts ADD COLUMN IF NOT EXISTS country CHAR(2) NOT NULL DEFAULT 'XX'");
    await this.pool.query("ALTER TABLE accounts ADD COLUMN IF NOT EXISTS best_territory INTEGER NOT NULL DEFAULT 0 CHECK (best_territory >= 0)");
    await this.pool.query(
      "CREATE INDEX IF NOT EXISTS accounts_score_idx ON accounts (score DESC, username ASC)",
    );
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS match_scores (
        match_id UUID NOT NULL,
        account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        points INTEGER NOT NULL CHECK (points >= 0),
        awarded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (match_id, account_id)
      )
    `);
  }

  async create(username: string, passwordHash: string, country: string) {
    try {
      const result = await this.pool.query(
        `INSERT INTO accounts (id, username, username_normalized, password_hash, country)
         VALUES (gen_random_uuid(), $1, $2, $3, $4)
         RETURNING id::text, username, score::text, country, best_territory`,
        [username, normalizeUsername(username), passwordHash, country],
      );
      return rowToPublic(result.rows[0]);
    } catch (error: any) {
      if (error?.code === "23505") throw duplicateUsernameError();
      throw error;
    }
  }

  async findByUsername(username: string) {
    const result = await this.pool.query(
      `SELECT id::text, username, password_hash, score::text, country, best_territory
       FROM accounts WHERE username_normalized = $1`,
      [normalizeUsername(username)],
    );
    if (!result.rowCount) return null;
    const row = result.rows[0];
    return {
      ...rowToPublic(row),
      passwordHash: row.password_hash,
    };
  }

  async awardScore(id: string, matchId: string, points: number, bestTerritory: number) {
    const result = await this.pool.query(
      `WITH award AS (
         INSERT INTO match_scores (match_id, account_id, points)
         VALUES ($2, $1, $3)
         ON CONFLICT DO NOTHING
         RETURNING points
       )
       UPDATE accounts
       SET score = score + COALESCE((SELECT points FROM award), 0),
           best_territory = GREATEST(best_territory, $4),
           updated_at = CASE WHEN EXISTS (SELECT 1 FROM award) THEN NOW() ELSE updated_at END
       WHERE id = $1
       RETURNING id::text, username, score::text, country, best_territory`,
      [id, matchId, sanitizePoints(points), sanitizeTerritory(bestTerritory)],
    );
    return result.rowCount ? rowToPublic(result.rows[0]) : null;
  }

  async leaderboard(limit: number) {
    const result = await this.pool.query(
      `SELECT id::text, username, score::text, country, best_territory FROM accounts
       ORDER BY score DESC, username ASC LIMIT $1`,
      [limit],
    );
    return result.rows.map(rowToPublic);
  }

  async ranking(id: string) {
    const result = await this.pool.query(
      `WITH ranked AS (
         SELECT id, country,
                ROW_NUMBER() OVER (ORDER BY score DESC, username ASC)::int AS world_rank,
                CASE WHEN country = 'XX' THEN NULL ELSE
                  ROW_NUMBER() OVER (PARTITION BY country ORDER BY score DESC, username ASC)::int
                END AS country_rank
         FROM accounts
       )
       SELECT world_rank, country_rank FROM ranked WHERE id = $1`,
      [id],
    );
    if (!result.rowCount) return null;
    return {
      world: Number(result.rows[0].world_rank),
      country: result.rows[0].country_rank === null
        ? null
        : Number(result.rows[0].country_rank),
    };
  }

  async health() {
    const result = await this.pool.query("SELECT 1 AS ok");
    return result.rows[0]?.ok === 1;
  }

  async close() {
    await this.pool.end();
  }
}

type Session = { account: PublicAccount; expiresAt: number };

export class AccountService {
  private sessions = new Map<string, Session>();
  readonly ready: Promise<void>;

  constructor(readonly store: AccountStore) {
    this.ready = store.initialize();
  }

  async register(username: string, password: string, country: unknown = "XX") {
    validateCredentials(username, password);
    await this.ready;
    const account = await this.store.create(
      username.trim(),
      await hashPassword(password),
      sanitizeCountry(country),
    );
    return this.issueSession(account);
  }

  async login(username: string, password: string) {
    validateCredentials(username, password);
    await this.ready;
    const stored = await this.store.findByUsername(username);
    if (!stored || !(await verifyPassword(password, stored.passwordHash))) {
      const error = new Error("Identifiants incorrects");
      (error as any).status = 401;
      throw error;
    }
    return this.issueSession(publicAccount(stored));
  }

  resolve(token: unknown) {
    if (typeof token !== "string" || !token) return null;
    const session = this.sessions.get(token);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(token);
      return null;
    }
    return session.account;
  }

  async awardScore(
    accountId: string,
    matchId: string,
    points: number,
    bestTerritory = 0,
  ) {
    await this.ready;
    const account = await this.store.awardScore(
      accountId,
      matchId,
      points,
      bestTerritory,
    );
    if (account)
      for (const session of this.sessions.values())
        if (session.account.id === accountId) session.account = account;
    return account;
  }

  async leaderboard(limit = 50) {
    await this.ready;
    return this.store.leaderboard(Math.max(1, Math.min(100, limit)));
  }

  async ranking(accountId: string) {
    await this.ready;
    return this.store.ranking(accountId);
  }

  async health() {
    await this.ready;
    return this.store.health();
  }

  async close() {
    this.sessions.clear();
    await this.store.close();
  }

  private issueSession(account: PublicAccount) {
    const token = randomBytes(32).toString("base64url");
    this.sessions.set(token, { account, expiresAt: Date.now() + SESSION_TTL_MS });
    return { token, account };
  }
}

function createStore(): AccountStore {
  if ((process.env.STORAGE_DRIVER ?? "memory") !== "postgres")
    return new MemoryAccountStore();
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL est requis avec STORAGE_DRIVER=postgres");
  return new PostgresAccountStore(connectionString);
}

export const accounts = new AccountService(createStore());

function normalizeUsername(username: string) {
  return username.trim().toLocaleLowerCase("fr-FR");
}

function validateCredentials(username: unknown, password: unknown): asserts username is string {
  if (typeof username !== "string" || typeof password !== "string") {
    const error = new Error("Nom d’utilisateur et mot de passe requis");
    (error as any).status = 400;
    throw error;
  }
  if (!USERNAME_PATTERN.test(username.trim())) {
    const error = new Error("Le nom doit contenir 3 à 16 lettres, chiffres, _ ou -");
    (error as any).status = 400;
    throw error;
  }
  if (password.length < 8 || password.length > 128) {
    const error = new Error("Le mot de passe doit contenir entre 8 et 128 caractères");
    (error as any).status = 400;
    throw error;
  }
}

function sanitizePoints(points: number) {
  return Math.max(0, Math.min(1000, Math.round(Number.isFinite(points) ? points : 0)));
}

function sanitizeTerritory(value: number) {
  return Math.max(0, Math.round(Number.isFinite(value) ? value : 0));
}

function sanitizeCountry(value: unknown) {
  const country = typeof value === "string" ? value.trim().toUpperCase() : "XX";
  return /^[A-Z]{2}$/.test(country) ? country : "XX";
}

async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

async function verifyPassword(password: string, encoded: string) {
  const [algorithm, saltValue, hashValue] = encoded.split("$");
  if (algorithm !== "scrypt" || !saltValue || !hashValue) return false;
  const expected = Buffer.from(hashValue, "base64url");
  const actual = (await scrypt(password, Buffer.from(saltValue, "base64url"), expected.length)) as Buffer;
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function publicAccount(account: PublicAccount | StoredAccount): PublicAccount {
  return {
    id: account.id,
    username: account.username,
    score: account.score,
    country: account.country,
    bestTerritory: account.bestTerritory,
  };
}

function rowToPublic(row: any): PublicAccount {
  return {
    id: row.id,
    username: row.username,
    score: Number(row.score),
    country: sanitizeCountry(row.country),
    bestTerritory: Number(row.best_territory ?? 0),
  };
}

function compareAccounts(a: PublicAccount, b: PublicAccount) {
  return b.score - a.score || a.username.localeCompare(b.username);
}

function duplicateUsernameError() {
  const error = new Error("Ce nom d’utilisateur existe déjà");
  (error as any).status = 409;
  return error;
}
