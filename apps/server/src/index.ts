import "dotenv/config";
import express from "express";
import cors from "cors";
import { Server } from "colyseus";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { createServer } from "node:http";
import { DominionRoom } from "./room.js";
import { accounts } from "./accounts.js";

const app = express();
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

app.get("/health", (_request, response) => response.json({ ok: true }));
app.get("/leaderboard", async (_request, response, next) => {
  try {
    response.json({ players: await accounts.leaderboard(50) });
  } catch (error) {
    next(error);
  }
});
app.post("/auth/register", limitAuth, async (request, response, next) => {
  try {
    response.status(201).json(await accounts.register(request.body?.username, request.body?.password));
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
app.use((error: any, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  console.error(error);
  response.status(Number(error?.status) || 500).json({
    error: Number(error?.status) ? error.message : "Erreur interne",
  });
});

await accounts.ready;
const http = createServer(app);
const gameServer = new Server({ transport: new WebSocketTransport({ server: http }) });
gameServer.define("dominion", DominionRoom).filterBy([]);
const port = Number(process.env.PORT ?? 2567);
gameServer.listen(port);
console.log(`Tile Dominion server on :${port}`);
