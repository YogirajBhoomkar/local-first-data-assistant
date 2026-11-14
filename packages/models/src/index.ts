// NOTE: the remote adapter is deliberately NOT exported here. Only the privacy gate imports it
// directly from ./remote/remote-adapter.js (enforced by ESLint).
export * from "./openai-compat.js";
export * from "./local.js";
export * from "./mock.js";
export * from "./tier.js";
