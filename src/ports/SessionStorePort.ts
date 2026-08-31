import type { SessionState } from "../domain/entities/SessionState.js";

/**
 * Port (interface) for persisting cross-run session state.
 * Implemented by adapters (e.g. a local file); used by the CLI. No implementation here.
 */
export interface SessionStorePort {
  load(): Promise<SessionState>;
  save(state: SessionState): Promise<void>;
}
