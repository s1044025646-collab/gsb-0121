// Stops only the server previously started by this project, using the pid
// recorded in data/server.json. Never scans or kills unrelated processes.
import { readFileSync, existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const file = resolve("data/server.json");
if (!existsSync(file)) {
  console.log("no data/server.json found; nothing to stop.");
  process.exit(0);
}
const info = JSON.parse(readFileSync(file, "utf8"));
if (!Number.isInteger(info.pid)) {
  console.error("invalid data/server.json: missing pid");
  process.exit(1);
}
try {
  process.kill(info.pid, "SIGTERM");
  console.log(`sent SIGTERM to project server pid ${info.pid} (was http://${info.host}:${info.port}).`);
} catch (err) {
  if (err && typeof err === "object" && err.code === "ESRCH") {
    console.log(`pid ${info.pid} was not running; cleaning stale data/server.json.`);
  } else {
    console.error(`failed to signal pid ${info.pid}:`, err.message);
    process.exit(1);
  }
}
rmSync(file, { force: true });
