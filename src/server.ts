import { createServer } from "node:http";
import { resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { openDatabase, migrate } from "./db/database.ts";
import { createApp } from "./api/app.ts";

/**
 * Local-only server. Binds explicitly to 127.0.0.1 and picks an ephemeral
 * port (0) by default; the chosen port is written to data/server.json so
 * stop scripts can manage only this project's process.
 */
function main(): void {
  const dbPath = process.env.ODET_DB ?? resolve("data/odet.sqlite");
  const host = "127.0.0.1";
  const requestedPort = Number(process.env.ODET_PORT ?? "0");

  const db = openDatabase(dbPath);
  const info = migrate(db);
  if (info.applied.length > 0) {
    console.log(`[migrate] applied versions: ${info.applied.join(", ")}`);
  }

  const { handler } = createApp(db);
  const server = createServer(handler);

  server.listen(requestedPort, host, () => {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to acquire TCP address");
    }
    const port = address.port;
    mkdirSync(resolve("data"), { recursive: true });
    writeFileSync(
      resolve("data/server.json"),
      JSON.stringify({ host, port, pid: process.pid, startedAt: new Date().toISOString() }, null, 2),
    );
    console.log(`[server] listening on http://${host}:${port} (pid ${process.pid})`);
    console.log(`[server] db: ${dbPath}`);
  });

  const shutdown = () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
