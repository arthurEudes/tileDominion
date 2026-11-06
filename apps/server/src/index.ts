import "dotenv/config";
import express from "express";
import cors from "cors";
import { Server } from "colyseus";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { createServer } from "node:http";
import { DominionRoom } from "./room.js";
import { accounts } from "./accounts.js";
import { logger } from "./logger.js";
import { RustEngine } from "./rust-engine.js";
import {
  clientErrors,
  httpErrors,
  metricsText,
  registry,
} from "./telemetry.js";

const app = express();
app.disable("x-powered-by");
app.use(cors({ origin: process.env.CLIENT_URL ?? "http://localhost:5173" }));
app.use(express.json({ limit: "8kb" }));

const authAttempts = new Map<string, { startedAt: number; count: number }>();
const limitAuth: express.RequestHandler = (request, response, next) => {
  const now = Date.now();
  const key = request.ip ?? "unknown";
  const attempt = authAttempts.get(key);
  if (!attempt || now - attempt.startedAt >= 60_000) {
    authAttempts.set(key, { startedAt: now, count: 1 });
    next();
    return;
  }
  attempt.count++;
  if (attempt.count > 10) {
    response.status(429).json({ error: "Trop de tentatives, réessaie dans une minute" });
    return;
  }
  next();
};

const rustProbe = new RustEngine(() => ({ component: "health_probe" }));
let shuttingDown = false;
let healthCache: { at: number; value: Awaited<ReturnType<typeof deepHealth>> } | null = null;

async function deepHealth() {
  const startedAt = performance.now();
  const [database, rust] = await Promise.allSettled([
    accounts.health(),
    rustProbe.healthcheck(),
  ]);
  const checks = {
    postgres: database.status === "fulfilled" && database.value,
    rust: rust.status === "fulfilled" && rust.value,
  };
  return {
    ok: !shuttingDown && checks.postgres && checks.rust,
    checks,
    latencyMs: Math.round((performance.now() - startedAt) * 100) / 100,
  };
}

app.get("/health", async (_request, response) => {
  try {
    if (!healthCache || Date.now() - healthCache.at > 5_000)
      healthCache = { at: Date.now(), value: await deepHealth() };
    response.status(healthCache.value.ok ? 200 : 503).json(healthCache.value);
  } catch (error) {
    logger.error("healthcheck_failed", { error });
    response.status(503).json({ ok: false, checks: { postgres: false, rust: false } });
  }
});

app.get("/metrics", async (_request, response, next) => {
  try {
    response.set("content-type", registry.contentType).send(await metricsText());
  } catch (error) {
    next(error);
  }
});

app.post("/client-errors", (request, response) => {
  const body = request.body as Record<string, unknown> | undefined;
  const kind = body?.kind === "unhandledrejection" ? "unhandledrejection" : "error";
  const message = typeof body?.message === "string" ? body.message.slice(0, 1000) : "Unknown client error";
  clientErrors.inc({ kind });
  logger.error("client_error", {
    kind,
    clientMessage: message,
    stack: typeof body?.stack === "string" ? body.stack.slice(0, 4000) : undefined,
    source: typeof body?.source === "string" ? body.source.slice(0, 500) : undefined,
    roomId: typeof body?.roomId === "string" ? body.roomId.slice(0, 100) : undefined,
    matchId: typeof body?.matchId === "string" ? body.matchId.slice(0, 100) : undefined,
    userAgent: request.get("user-agent")?.slice(0, 500),
  });
  response.status(202).end();
});

app.get("/leaderboard", async (_request, response, next) => {
  try {
    response.json({ players: await accounts.leaderboard(50) });
  } catch (error) {
    next(error);
  }
});
app.post("/auth/register", limitAuth, async (request, response, next) => {
  try {
    response.status(201).json(await accounts.register(
      request.body?.username,
      request.body?.password,
      request.body?.country,
    ));
  } catch (error) {
    next(error);
  }
});
app.post("/auth/login", limitAuth, async (request, response, next) => {
  try {
    response.json(await accounts.login(request.body?.username, request.body?.password));
  } catch (error) {
    next(error);
  }
});
app.use((error: any, request: express.Request, response: express.Response, _next: express.NextFunction) => {
  const status = Number(error?.status) || 500;
  httpErrors.inc({ status: String(status) });
  const fields = { error, method: request.method, path: request.path, status };
  if (status >= 500) logger.error("http_request_failed", fields);
  else logger.warn("http_request_rejected", fields);
  response.status(status).json({
    error: status < 500 ? error.message : "Erreur interne",
  });
});

await accounts.ready;
await rustProbe.healthcheck();
const http = createServer(app);
const gameServer = new Server({
  transport: new WebSocketTransport({ server: http }),
  gracefullyShutdown: false,
  greet: process.env.NODE_ENV !== "production",
  logger: {
    debug: (message: string) => logger.debug(message),
    info: (message: string) => logger.info(message),
    warn: (message: string) => logger.warn(message),
    error: (message: string) => logger.error(message),
  },
});
gameServer.define("dominion", DominionRoom).filterBy([]);
gameServer.onShutdown(async () => {
  rustProbe.close();
  await accounts.close();
});

const port = Number(process.env.PORT ?? 2567);
await gameServer.listen(port);
logger.info("server_started", { port, pid: process.pid });

async function shutdown(signal: string, error?: unknown) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.warn("server_shutdown_started", { signal, error });
  const forced = setTimeout(() => {
    logger.error("server_shutdown_forced", { signal });
    process.exit(1);
  }, 15_000).unref();
  try {
    await gameServer.gracefullyShutdown(false, error instanceof Error ? error : undefined);
    clearTimeout(forced);
    logger.info("server_shutdown_complete", { signal });
    process.exit(error ? 1 : 0);
  } catch (shutdownError) {
    logger.error("server_shutdown_failed", { signal, error: shutdownError });
    process.exit(1);
  }
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("uncaughtException", (error) => void shutdown("uncaughtException", error));
process.once("unhandledRejection", (error) => void shutdown("unhandledRejection", error));
