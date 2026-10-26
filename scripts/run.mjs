import { spawn } from "node:child_process";
import { resolve } from "node:path";
const mode = process.argv[2] ?? "production";
const root = resolve(import.meta.dirname, "..");
const children = new Set();
const restarts = new Map();
const timers = new Set();
let stopping = false;
function start(name, source, built) {
  const args = mode === "development" ? ["--import", "tsx", source] : [built];
  const child = spawn(process.execPath, args, {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
    env: { ...process.env, NODE_ENV: mode },
  });
  children.add(child);
  const started = Date.now();
  child.once("exit", code => {
    children.delete(child);
    if (!stopping) {
      const failures =
        Date.now() - started > 60000 ? 0 : (restarts.get(name) ?? 0) + 1;
      restarts.set(name, failures);
      const delay = Math.min(30000, 1000 * 2 ** Math.min(failures, 5));
      console.error(
        `${name} stopped (${code}); restarting in ${delay / 1000}s`
      );
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (!stopping) start(name, source, built);
      }, delay);
      timers.add(timer);
    }
  });
}
function stop() {
  stopping = true;
  for (const timer of timers) clearTimeout(timer);
  for (const child of children) child.kill("SIGTERM");
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
start("API", "server/_core/index.ts", "dist/index.js");
start("Worker", "server/worker.ts", "dist/worker.js");
