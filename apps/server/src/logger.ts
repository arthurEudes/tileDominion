type LogLevel = "debug" | "info" | "warn" | "error";
type Fields = Record<string, unknown>;

function normalize(value: unknown): unknown {
  if (value instanceof Error)
    return { name: value.name, message: value.message, stack: value.stack };
  return value;
}

export function log(level: LogLevel, message: string, fields: Fields = {}) {
  const entry: Fields = {
    timestamp: new Date().toISOString(),
    level,
    service: "tile-dominion-server",
    message,
  };
  for (const [key, value] of Object.entries(fields)) entry[key] = normalize(value);
  const line = JSON.stringify(entry);
  if (level === "error") process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export const logger = {
  debug: (message: string, fields?: Fields) => log("debug", message, fields),
  info: (message: string, fields?: Fields) => log("info", message, fields),
  warn: (message: string, fields?: Fields) => log("warn", message, fields),
  error: (message: string, fields?: Fields) => log("error", message, fields),
};
