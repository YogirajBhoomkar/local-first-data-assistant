// Starts the Laya decision-model service bound to loopback only (laya-serve defaults to 0.0.0.0, which we do not want).
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const exe = process.env.LAYA_SERVE ?? resolve(here, ".venv/Scripts/laya-serve.exe");
if (!existsSync(exe)) {
  console.error("laya-serve not found. Run: python -m venv services/laya/.venv && services/laya/.venv/Scripts/pip install \"laya[serve]\"");
  process.exit(1);
}
const env = { ...process.env, USE_TF: "0", LAYA_HOST: "127.0.0.1", LAYA_PORT: process.env.LAYA_PORT ?? "8765", LAYA_MAX_LOADED: "1", LAYA_PRELOAD: "0" };
const child = spawn(exe, [], { env, stdio: "inherit" });
child.on("exit", (c) => process.exit(c ?? 0));
