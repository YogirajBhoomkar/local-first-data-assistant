// Ports: interfaces only. Adapters in other packages implement them.
// Real port definitions arrive phase by phase (engine: P1, models: P2, agent contract: P3, docs: P4).
export interface Clock {
  now(): Date;
}
