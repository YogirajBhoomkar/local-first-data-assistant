import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  buildPacket,
  remoteAvailable,
  type ChatModelPort,
  type Config,
  type EgressRecord,
  type EscalationRequest,
  type GenerateRequest,
  type GenerateResult,
  type TurnEvent,
} from "@lf/core";
// The ONLY place allowed to construct the remote adapter (see eslint.config.js).
import { RemoteAdapter } from "@lf/models/remote";
import { buildRemoteRequest } from "../prompts/remote.js";
import { EgressLog } from "./egress-log.js";

export type GateResult =
  | { status: "sent"; result: GenerateResult; unmask: (t: string) => string; summarized: boolean; egressId: string }
  | { status: "blocked"; reason: string }
  | { status: "cancelled"; egressId: string }
  | { status: "failed"; message: string; egressId: string };

export interface GateDeps {
  config: Config;
  log: EgressLog;
  maskKey: string;
  /** Resolves when the host answers a `confirm` event; false on cancel or timeout. */
  waitForConfirm: (egressId: string) => Promise<boolean>;
  /** Tests inject a mock here; production builds the RemoteAdapter from config. */
  remoteFactory?: (config: Config) => ChatModelPort;
  newId?: () => string;
  now?: () => Date;
}

/** Per-install random key used to HMAC-mask column values. It never leaves cacheDir. */
export async function loadMaskKey(cacheDir: string): Promise<string> {
  const file = join(cacheDir, "mask.key");
  try {
    return (await readFile(file, "utf8")).trim();
  } catch {
    const key = randomBytes(32).toString("hex");
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, key, { mode: 0o600 });
    return key;
  }
}

function defaultRemote(config: Config): ChatModelPort {
  const r = config.remoteModel;
  return new RemoteAdapter({
    provider: r.provider,
    baseUrl: r.baseUrl ?? "",
    model: r.model ?? "",
    apiKey: r.apiKey ?? "",
    apiVersion: r.apiVersion,
  });
}

/**
 * The privacy gate: the only code that builds anything sent to the remote model.
 * Order for every send: build packet -> write egress record -> emit `egress` -> (confirm) -> send.
 */
export class PrivacyGate {
  constructor(private readonly d: GateDeps) {}

  available(): boolean {
    return remoteAvailable(this.d.config);
  }

  async *send(
    req: EscalationRequest,
    turnId: string,
    buildRequest: (p: NonNullable<ReturnType<typeof buildPacket>["packet"]>) => GenerateRequest = buildRemoteRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<TurnEvent, GateResult> {
    const { config } = this.d;
    if (!this.available()) return { status: "blocked", reason: "no remote model is configured or it is disabled" };
    const built = buildPacket(req, config.privacy, this.d.maskKey);
    if (!built.packet) return { status: "blocked", reason: built.blockedReason ?? "nothing may be sent" };
    const packet = built.packet;
    if (built.summarized)
      yield { type: "trace", step: "privacy", status: "done", detail: "Result is too large to send as rows; sending a locally computed summary instead." };

    const request = buildRequest(packet);
    const exact = JSON.stringify({ system: request.system, messages: request.messages, responseSchema: request.responseSchema });
    const egressId = (this.d.newId ?? randomUUID)();
    const record: EgressRecord = {
      egressId,
      turnId,
      timestamp: (this.d.now ?? (() => new Date()))().toISOString(),
      destination: "remote-model",
      purpose: packet.purpose,
      privacyLevel: config.privacy.tabularLevel,
      tables: packet.tables,
      columns: packet.columns,
      rowCount: packet.rowCount,
      byteSize: Buffer.byteLength(exact, "utf8"),
      payloadSha256: createHash("sha256").update(exact).digest("hex"),
      approvedBy: "none",
      outcome: "pending",
      ...(config.privacy.logFullPayload ? { payload: JSON.parse(exact) as unknown } : {}),
    };
    // Written BEFORE anything is sent.
    await this.d.log.append(record);
    yield {
      type: "egress",
      egressId,
      destination: "remote-model",
      summary: `${packet.purpose}: ${packet.summary} (${record.byteSize} bytes)`,
      detail: {
        purpose: packet.purpose,
        privacyLevel: config.privacy.tabularLevel,
        bytes: record.byteSize,
        rows: packet.rowCount,
        tables: packet.tables,
        columns: packet.columns,
        summarized: built.summarized,
        preview: JSON.stringify(packet.payload, null, 2).slice(0, 8000),
      },
    };

    let approvedBy: EgressRecord["approvedBy"] = "auto";
    if (config.privacy.confirmBeforeSend) {
      // Register the waiter BEFORE emitting the event, so a host that replies immediately is not lost.
      const waiter = this.d.waitForConfirm(egressId);
      yield { type: "confirm", egressId, preview: JSON.stringify(packet.payload, null, 2) };
      const ok = await waiter;
      if (!ok) {
        await this.d.log.append({ ...record, approvedBy: "none", outcome: "cancelled" });
        return { status: "cancelled", egressId };
      }
      approvedBy = "user";
    }

    try {
      const model = (this.d.remoteFactory ?? defaultRemote)(config);
      const result = await model.generate({ ...request, ...(signal ? { signal } : {}) });
      await this.d.log.append({ ...record, approvedBy, outcome: "sent" });
      return { status: "sent", result, unmask: built.unmask, summarized: built.summarized, egressId };
    } catch (e) {
      await this.d.log.append({ ...record, approvedBy, outcome: "failed" });
      return { status: "failed", message: (e as Error).message, egressId };
    }
  }
}

/** One-line explanation for a send that did not complete. */
export function gateNote(g: GateResult): string {
  if (g.status === "cancelled") return "Sending to the remote model was cancelled, so the answer stays local.";
  if (g.status === "blocked") return `Not sent to the remote model: ${g.reason}.`;
  if (g.status === "failed") return `The remote model call failed: ${g.message}`;
  return "";
}
