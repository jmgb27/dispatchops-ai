/**
 * The autonomy ceilings — the whole of the spend policy, in one leaf module.
 *
 * This file deliberately imports nothing. Two separate places evaluate it: the
 * graph's cost gate, which decides whether a run may continue on its own, and
 * the TMS write path, which refuses to commit an autonomous action that breaches
 * it. Neither can import the other without a cycle, so the policy lives below
 * both. That is what allows the same rule to be enforced twice.
 *
 * Three ceilings, because one is not enough:
 *
 *   - per action     — no single decision above this without a human
 *   - per load       — no shipment accumulates more than this autonomously
 *   - per day        — no board-wide total above this autonomously
 *
 * The per-action ceiling alone is the flaw this module exists to close: it
 * cannot see a sequence. Four separate $450 reroutes each pass a $500 per-action
 * test and together spend $1,800 nobody approved.
 */

export const DEFAULT_MAX_AUTONOMOUS_SPEND_USD = 500;
export const DEFAULT_MAX_LOAD_SPEND_USD = 2_000;
export const DEFAULT_MAX_DAILY_SPEND_USD = 5_000;

/**
 * Read at call time rather than module load, so tests can vary a ceiling and so
 * a redeploy picks up a changed env without a rebuild.
 */
function envUsd(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

export function maxAutonomousSpendUsd(): number {
  return envUsd("MAX_AUTONOMOUS_SPEND_USD", DEFAULT_MAX_AUTONOMOUS_SPEND_USD);
}

export function maxLoadSpendUsd(): number {
  return envUsd("MAX_LOAD_SPEND_USD", DEFAULT_MAX_LOAD_SPEND_USD);
}

export function maxDailySpendUsd(): number {
  return envUsd("MAX_DAILY_SPEND_USD", DEFAULT_MAX_DAILY_SPEND_USD);
}

/**
 * What the agent has already committed, derived from the TMS audit log rather
 * than tracked separately. A second counter is a second thing to get out of
 * step with the ledger it is supposed to describe.
 */
export interface SpendLedger {
  /** Already committed against this one load. */
  loadUsd: number;
  /** Already committed across every load on the board. */
  dailyUsd: number;
}

export type EscalationReason =
  | "PER_ACTION_CEILING"
  | "LOAD_CUMULATIVE_CEILING"
  | "DAILY_CUMULATIVE_CEILING";

export interface AutonomyDecision {
  requiresApproval: boolean;
  /** Which ceiling stopped it. Null when the action is within all three. */
  reason: EscalationReason | null;
  /** The ceiling that decided the outcome. */
  ceilingUsd: number;
  /** Committed before this action, on whichever scope decided the outcome. */
  alreadySpentUsd: number;
  /** What that scope reaches if this action commits. */
  wouldTotalUsd: number;
  ledger: SpendLedger;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * The per-action ceiling on its own.
 *
 * Kept as a standalone predicate because it is the one rule that needs no
 * history — it is a pure function of the number, and the boundary test reads
 * better for it. `evaluateAutonomy` is the complete decision.
 */
export function requiresHumanApproval(totalUsd: number): boolean {
  return totalUsd >= maxAutonomousSpendUsd();
}

/**
 * The full guardrail decision: this action, against all three ceilings.
 *
 * Every bound is closed from below — at the ceiling escalates, a hair under it
 * does not — so the demo's $500 boundary behaves identically at every scope.
 */
export function evaluateAutonomy(
  totalUsd: number,
  ledger: SpendLedger,
): AutonomyDecision {
  if (requiresHumanApproval(totalUsd)) {
    return {
      requiresApproval: true,
      reason: "PER_ACTION_CEILING",
      ceilingUsd: maxAutonomousSpendUsd(),
      alreadySpentUsd: 0,
      wouldTotalUsd: round2(totalUsd),
      ledger,
    };
  }

  const loadCeiling = maxLoadSpendUsd();
  const loadWouldTotal = round2(ledger.loadUsd + totalUsd);
  if (loadWouldTotal >= loadCeiling) {
    return {
      requiresApproval: true,
      reason: "LOAD_CUMULATIVE_CEILING",
      ceilingUsd: loadCeiling,
      alreadySpentUsd: ledger.loadUsd,
      wouldTotalUsd: loadWouldTotal,
      ledger,
    };
  }

  const dailyCeiling = maxDailySpendUsd();
  const dailyWouldTotal = round2(ledger.dailyUsd + totalUsd);
  if (dailyWouldTotal >= dailyCeiling) {
    return {
      requiresApproval: true,
      reason: "DAILY_CUMULATIVE_CEILING",
      ceilingUsd: dailyCeiling,
      alreadySpentUsd: ledger.dailyUsd,
      wouldTotalUsd: dailyWouldTotal,
      ledger,
    };
  }

  return {
    requiresApproval: false,
    reason: null,
    ceilingUsd: maxAutonomousSpendUsd(),
    alreadySpentUsd: ledger.loadUsd,
    wouldTotalUsd: loadWouldTotal,
    ledger,
  };
}

/** One line of plain English for the approval card and the agent trace. */
export function describeEscalation(decision: AutonomyDecision): string {
  const usd = (n: number) =>
    `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  switch (decision.reason) {
    case "PER_ACTION_CEILING":
      return `${usd(decision.wouldTotalUsd)} is at or above the ${usd(decision.ceilingUsd)} limit for a single action.`;
    case "LOAD_CUMULATIVE_CEILING":
      return `${usd(decision.alreadySpentUsd)} has already been spent on this load; this would take it to ${usd(decision.wouldTotalUsd)}, at or above the ${usd(decision.ceilingUsd)} limit for one load.`;
    case "DAILY_CUMULATIVE_CEILING":
      return `${usd(decision.alreadySpentUsd)} has already been spent today; this would take it to ${usd(decision.wouldTotalUsd)}, at or above the ${usd(decision.ceilingUsd)} daily limit.`;
    default:
      return "Within every spend ceiling.";
  }
}
