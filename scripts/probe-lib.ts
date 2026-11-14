import { execFile } from "node:child_process";
import { cpus, arch, platform, release, totalmem, freemem } from "node:os";
import { statfs, mkdir } from "node:fs/promises";
import { loadConfig, type Config } from "../packages/core/src/index.js";

/** The ONLY keys the probe may output. A test asserts this. */
export const ALLOWED_PROBE_KEYS = [
  "os",
  "cpu",
  "ram",
  "gpu",
  "appleSilicon",
  "freeDiskGb",
  "nodeVersion",
  "ollama",
  "recommendation",
] as const;

export interface ProbeResult {
  os: { platform: string; release: string; arch: string };
  cpu: { model: string; logicalCores: number };
  ram: { totalGb: number; freeGb: number };
  gpu: { name: string; vramGb: number | null }[] | "unknown";
  appleSilicon: boolean;
  freeDiskGb: number | "unknown";
  nodeVersion: string;
  ollama: { reachable: boolean; models: string[] };
  recommendation: { tier: string; model: string | null; reason: string };
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const GB = 1024 ** 3;

function run(cmd: string, args: string[], timeout = 5000): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 4_000_000 }, (err, out) =>
        resolve(err ? null : out),
      );
    } catch {
      resolve(null);
    }
  });
}

export async function detectGpu(): Promise<ProbeResult["gpu"]> {
  const p = platform();
  try {
    if (p === "win32") {
      const out = await run("powershell.exe", [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM | ConvertTo-Json -Compress",
      ]);
      if (!out) return "unknown";
      const j = JSON.parse(out) as { Name: string; AdapterRAM?: number } | { Name: string; AdapterRAM?: number }[];
      return (Array.isArray(j) ? j : [j]).map((g) => ({
        name: g.Name,
        // AdapterRAM is a uint32 and caps at 4 GB; treat as a hint only.
        vramGb: g.AdapterRAM ? round1(g.AdapterRAM / GB) : null,
      }));
    }
    if (p === "darwin") {
      const out = await run("system_profiler", ["SPDisplaysDataType", "-json"]);
      if (!out) return "unknown";
      const j = JSON.parse(out) as { SPDisplaysDataType?: { sppci_model?: string; spdisplays_vram?: string }[] };
      return (j.SPDisplaysDataType ?? []).map((g) => ({
        name: g.sppci_model ?? "unknown",
        vramGb: g.spdisplays_vram ? parseFloat(g.spdisplays_vram) || null : null,
      }));
    }
    const out = await run("sh", ["-c", 'lspci | grep -i -E "vga|3d"']);
    if (!out) return "unknown";
    return out
      .split("\n")
      .filter(Boolean)
      .map((l) => ({ name: l.replace(/^\S+\s+/, "").trim(), vramGb: null }));
  } catch {
    return "unknown";
  }
}

export async function detectOllama(
  baseUrl: string,
  timeoutMs = 2000,
): Promise<ProbeResult["ollama"]> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { reachable: false, models: [] };
    const j = (await res.json()) as { data?: { id: string }[] };
    return { reachable: true, models: (j.data ?? []).map((m) => m.id) };
  } catch {
    return { reachable: false, models: [] };
  }
}

export function recommendTier(
  totalRamGb: number,
  tiers: Config["localModel"]["tiers"],
): ProbeResult["recommendation"] {
  const sorted = [...tiers].sort((a, b) => a.minTotalRamGb - b.minTotalRamGb);
  let pick = sorted[0];
  for (const t of sorted) if (totalRamGb >= t.minTotalRamGb) pick = t;
  if (!pick) return { tier: "none", model: null, reason: "No tiers configured." };
  return {
    tier: pick.name,
    model: pick.model,
    reason: `${totalRamGb} GB total RAM meets the ${pick.name} tier (needs ${pick.minTotalRamGb} GB).`,
  };
}

export async function collectProbe(config: Config = loadConfig()): Promise<ProbeResult> {
  const totalGb = round1(totalmem() / GB);
  let freeDiskGb: number | "unknown" = "unknown";
  try {
    await mkdir(config.cacheDir, { recursive: true });
    const s = await statfs(config.cacheDir);
    freeDiskGb = round1((s.bavail * s.bsize) / GB);
  } catch {
    /* leave unknown */
  }
  const c = cpus();
  return {
    os: { platform: platform(), release: release(), arch: arch() },
    cpu: { model: c[0]?.model.trim() ?? "unknown", logicalCores: c.length },
    ram: { totalGb, freeGb: round1(freemem() / GB) },
    gpu: await detectGpu(),
    appleSilicon: platform() === "darwin" && arch() === "arm64",
    freeDiskGb,
    nodeVersion: process.version,
    ollama: await detectOllama(config.localModel.baseUrl),
    recommendation: recommendTier(totalGb, config.localModel.tiers),
  };
}

export function summarize(p: ProbeResult): string {
  const gpu = p.gpu === "unknown" ? "unknown" : p.gpu.map((g) => g.name).join(", ") || "none found";
  return [
    `System: ${p.os.platform} ${p.os.arch}, ${p.cpu.logicalCores} cores`,
    `RAM: ${p.ram.totalGb} GB total, ${p.ram.freeGb} GB free`,
    `GPU: ${gpu}${p.appleSilicon ? " (Apple Silicon, unified memory)" : ""}`,
    `Free disk (cache drive): ${p.freeDiskGb} GB`,
    `Ollama: ${p.ollama.reachable ? `running, ${p.ollama.models.length} model(s)` : "not reachable"}`,
    `Recommended tier: ${p.recommendation.tier}${p.recommendation.model ? ` (${p.recommendation.model})` : ""} - ${p.recommendation.reason}`,
  ].join("\n");
}
