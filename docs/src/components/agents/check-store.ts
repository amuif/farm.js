import { useSyncExternalStore } from "react";
import type { StoredAgentCheck } from "../../lib/agents-check";

/**
 * The check page's state, shared by the form in the hero and the report that replaces the
 * intro once a scan comes back, so a check runs and reads on one page.
 */
export interface AgentCheckState {
  /** The address in the form. A rescan or "Check another site" sets it. */
  url: string;
  pending: boolean;
  /** Error code from the last run, for agentCheckErrorMessage. */
  error?: string;
  /** How many checks this page has started; the form only shows a `?error=` before the first. */
  runs: number;
  scan: StoredAgentCheck | null;
}

const initial: AgentCheckState = { url: "", pending: false, runs: 0, scan: null };
let state = initial;
const listeners = new Set<() => void>();

function update(next: Partial<AgentCheckState>) {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAgentCheck(): AgentCheckState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => initial,
  );
}

/**
 * Run a check and keep its report on this page. Resolves with the report's id when the scan
 * started but its report didn't come back, so the caller can open /agents/check/[id] instead.
 */
export async function runAgentCheck(url: string): Promise<string | undefined> {
  if (state.pending) return undefined;
  // A rescan keeps the current report on screen until the new one arrives.
  update({ url, pending: true, error: undefined, runs: state.runs + 1 });
  try {
    const response = await fetch("/api/agents/check", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ url }),
    });
    const result = (await response.json().catch(() => ({}))) as {
      id?: unknown;
      scan?: StoredAgentCheck;
      error?: unknown;
    };
    if (response.ok && typeof result.id === "string") {
      update({ pending: false, scan: result.scan ?? state.scan });
      return result.scan ? undefined : result.id;
    }
    const code =
      typeof result.error === "string"
        ? result.error
        : response.status === 429
          ? "rate_limited"
          : "failed";
    update({ pending: false, error: code });
  } catch {
    update({ pending: false, error: "unavailable" });
  }
  return undefined;
}

/** Back to the form, optionally prefilled. */
export function resetAgentCheck(url = "") {
  update({ url, error: undefined, scan: null });
}
