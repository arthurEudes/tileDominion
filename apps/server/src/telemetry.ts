import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from "prom-client";

export const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: "tile_process_" });

export const roomsGauge = new Gauge({
  name: "tile_rooms_active",
  help: "Number of active Colyseus rooms",
  registers: [registry],
});
export const playersGauge = new Gauge({
  name: "tile_players_connected",
  help: "Number of connected human players",
  registers: [registry],
});
export const websocketGauge = new Gauge({
  name: "tile_websocket_connections",
  help: "Number of active game WebSocket connections",
  registers: [registry],
});
export const tickDuration = new Histogram({
  name: "tile_tick_duration_seconds",
  help: "End-to-end room tick duration",
  buckets: [0.005, 0.01, 0.02, 0.03, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [registry],
});
export const tickOverruns = new Counter({
  name: "tile_tick_overruns_total",
  help: "Ticks exceeding the configured room tick budget",
  registers: [registry],
});
export const rustRoundTrip = new Histogram({
  name: "tile_rust_roundtrip_seconds",
  help: "Rust IPC request round-trip duration",
  buckets: [0.001, 0.0025, 0.005, 0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [registry],
});
export const rustTimeouts = new Counter({
  name: "tile_rust_timeouts_total",
  help: "Rust IPC requests that exceeded their deadline",
  registers: [registry],
});
export const rustCrashes = new Counter({
  name: "tile_rust_process_crashes_total",
  help: "Unexpected Rust child process exits",
  registers: [registry],
});
export const rustEnginesGauge = new Gauge({
  name: "tile_rust_engines_active",
  help: "Number of live Rust child processes",
  registers: [registry],
});
export const clientErrors = new Counter({
  name: "tile_client_errors_total",
  help: "Browser errors reported by clients",
  labelNames: ["kind"] as const,
  registers: [registry],
});
export const httpErrors = new Counter({
  name: "tile_http_errors_total",
  help: "HTTP responses with an error status",
  labelNames: ["status"] as const,
  registers: [registry],
});

export async function metricsText() {
  return registry.metrics();
}
