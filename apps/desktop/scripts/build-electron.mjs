// Bundles the three Electron entry points with esbuild. Workspace packages (TypeScript source) are bundled in;
// native or ESM-only runtime libraries stay external and are resolved from node_modules.
import { build } from "esbuild";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const common = { bundle: true, platform: "node", target: "node24", sourcemap: true, logLevel: "info", absWorkingDir: root };
const banner = { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" };
const external = ["electron", "@duckdb/node-api", "@duckdb/node-bindings", "pdfjs-dist", "pdfjs-dist/*", "exceljs"];

await Promise.all([
  build({ ...common, entryPoints: ["electron/main.ts"], outfile: "dist-main/main.mjs", format: "esm", external, banner }),
  build({ ...common, entryPoints: ["electron/agent-process.ts"], outfile: "dist-main/agent-process.mjs", format: "esm", external, banner }),
  build({ ...common, entryPoints: ["electron/preload.ts"], outfile: "dist-main/preload.cjs", format: "cjs", external: ["electron"] }),
]);
