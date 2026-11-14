// Development: Vite dev server for the window + a fresh Electron bundle, then launch Electron pointed at Vite.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

await new Promise((ok, fail) => {
  const p = spawn(process.execPath, [resolve(root, "scripts/build-electron.mjs")], { cwd: root, stdio: "inherit" });
  p.on("exit", (c) => (c === 0 ? ok() : fail(new Error(`electron build failed (${c})`))));
});

const server = await createServer({ configFile: resolve(root, "vite.config.ts") });
await server.listen();
const url = server.resolvedUrls?.local?.[0] ?? "http://localhost:5173/";

const electron = require("electron"); // path to the electron binary
// Some hosts (VS Code, for example) set ELECTRON_RUN_AS_NODE, which would make Electron behave like plain Node.
const env = { ...process.env, VITE_DEV_SERVER_URL: url };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [root], { cwd: root, stdio: "inherit", env });
child.on("exit", async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
