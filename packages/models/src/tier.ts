import type { Config } from "@lf/core";

/** The part of the probe result tier selection needs (ProbeResult satisfies this). */
export interface TierProbe {
  ram: { totalGb: number };
  ollama: { reachable: boolean; models: string[] };
}

export interface TierChoice {
  tier: string;
  model: string | null;
  reason: string;
  /** true when the app should run remote-only (files still stay local) */
  remoteOnly: boolean;
  installHint?: string;
  warning?: string;
}

const norm = (s: string) => (s.includes(":") ? s : `${s}:latest`);

export function selectLocalModel(probe: TierProbe, config: Config): TierChoice {
  const none = (reason: string, installHint?: string): TierChoice => ({
    tier: "none",
    model: null,
    reason,
    remoteOnly: true,
    ...(installHint ? { installHint } : {}),
  });
  if (!config.localModel.enabled) return none("Local model is turned off in settings.");

  const tiers = [...config.localModel.tiers].sort((a, b) => a.minTotalRamGb - b.minTotalRamGb);
  let tier = tiers[0];
  for (const t of tiers) if (probe.ram.totalGb >= t.minTotalRamGb) tier = t;

  const forced = config.localModel.name;
  let model: string | null;
  let name: string;
  let warning: string | undefined;
  if (forced) {
    model = forced;
    name = tier?.name ?? "custom";
    const needed = tiers.find((t) => t.model === forced);
    if (needed && probe.ram.totalGb < needed.minTotalRamGb)
      warning = `${forced} normally needs ${needed.minTotalRamGb} GB RAM; this machine has ${probe.ram.totalGb} GB.`;
  } else {
    model = tier?.model ?? null;
    name = tier?.name ?? "none";
  }
  if (!model) return none(`${probe.ram.totalGb} GB RAM is below the smallest local tier.`);

  if (!probe.ollama.reachable)
    return none("The local model server (Ollama) is not reachable.", `Install Ollama, start it, then run: ollama pull ${model}`);
  const installed = new Set(probe.ollama.models.map(norm));
  if (!installed.has(norm(model)))
    return none(`Model ${model} is not installed.`, `ollama pull ${model}`);

  return {
    tier: name,
    model,
    remoteOnly: false,
    reason: forced
      ? `Model chosen in settings (${forced}).`
      : `${probe.ram.totalGb} GB RAM meets the ${name} tier.`,
    ...(warning ? { warning } : {}),
  };
}
