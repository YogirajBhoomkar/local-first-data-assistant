// Runs the built app (dist-main + dist-renderer) without a dev server.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const electron = createRequire(import.meta.url)("electron");
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.VITE_DEV_SERVER_URL;
const child = spawn(electron, [root, ...process.argv.slice(2)], { cwd: root, stdio: "inherit", env });
child.on("exit", (c) => process.exit(c ?? 0));
