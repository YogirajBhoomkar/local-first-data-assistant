import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LayaClient } from "@lf/models";

/**
 * Starts the Laya decision-model service (a local Python HTTP server) next to the app and waits until it answers.
 * It is bound to loopback only. If the Python environment is not installed the app simply runs without it.
 */

export interface LayaStatus {
  available: boolean;
  reason: string;
}

const here = dirname(fileURLToPath(import.meta.url));

/** Where laya-serve lives: an explicit LAYA_SERVE, else the repo's services/laya virtual environment (development). */
export function findLayaServe(env: Record<string, string | undefined> = process.env): string | null {
  const candidates = [
    env.LAYA_SERVE,
    resolve(here, "../../../services/laya/.venv/Scripts/laya-serve.exe"),
    resolve(here, "../../../services/laya/.venv/bin/laya-serve"),
    join(process.cwd(), "services/laya/.venv/Scripts/laya-serve.exe"),
  ].filter((x): x is string => !!x);
  return candidates.find((c) => existsSync(c)) ?? null;
}

export class LayaSidecar {
  private child: ChildProcess | null = null;
  private status: LayaStatus = { available: false, reason: "not started" };

  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly env: Record<string, string | undefined> = process.env,
  ) {}

  getStatus(): LayaStatus {
    return this.status;
  }

  client(timeoutMs = 20_000): LayaClient {
    return new LayaClient({ baseUrl: this.baseUrl, model: this.model, timeoutMs });
  }

  /** Reuse a server that is already running, else start one. Resolves once it answers /health. */
  async start(onChange?: (s: LayaStatus) => void): Promise<LayaStatus> {
    const set = (s: LayaStatus) => {
      this.status = s;
      onChange?.(s);
    };
    const c = this.client();
    if (await c.health()) {
      set({ available: true, reason: "Laya is running" });
      void this.warmUp();
      return this.status;
    }
    const exe = findLayaServe(this.env);
    if (!exe) {
      set({ available: false, reason: "Laya is not installed (see docs/phases/phase-5.md); routing uses the built-in rules" });
      return this.status;
    }
    const port = new URL(this.baseUrl).port || "8765";
    set({ available: false, reason: "Starting Laya…" });
    this.child = spawn(exe, [], {
      env: { ...process.env, USE_TF: "0", LAYA_HOST: "127.0.0.1", LAYA_PORT: port, LAYA_MAX_LOADED: "1", LAYA_PRELOAD: "0" },
      stdio: "ignore",
      windowsHide: true,
    });
    this.child.on("exit", () => {
      this.child = null;
      set({ available: false, reason: "Laya stopped" });
    });
    for (let i = 0; i < 60; i++) {
      if (await c.health()) {
        set({ available: true, reason: "Laya is running" });
        void this.warmUp();
        return this.status;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    set({ available: false, reason: "Laya did not start in time" });
    return this.status;
  }

  /** The first request loads the model (up to a minute on CPU); do it now so the first question is not slow. */
  private async warmUp(): Promise<void> {
    try {
      await new LayaClient({ baseUrl: this.baseUrl, model: this.model, timeoutMs: 280_000 }).decide("warm up");
    } catch {
      /* the first real question will try again */
    }
  }

  stop(): void {
    this.child?.kill();
    this.child = null;
  }
}
