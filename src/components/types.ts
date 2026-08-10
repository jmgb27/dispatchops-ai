import type { CostedProposal } from "@/agent/cost";
import type { AutonomyDecision, EscalationReason } from "@/spend-policy";
import type { Load, AuditEntry } from "@/mock/loads";

export interface ApprovalPayload {
  type: "COST_APPROVAL";
  loadId: string;
  resourceId: string;
  resourceName: string;
  resourceKind: "COMPANY_DRIVER" | "THIRD_PARTY_CARRIER";
  justification: string;
  thresholdUsd: number;
  breakdown: CostedProposal;
  /** Which ceiling escalated this, and the running totals behind it. */
  autonomy?: AutonomyDecision;
  escalationReason?: string;
  /**
   * Context from the load record, so the card can show what the spend buys off
   * rather than only what it costs. Optional because the payload crosses the
   * wire as `unknown` and a checkpoint written by an older build won't have it.
   */
  customer?: string;
  cargo?: string;
  slaPenaltyUsd?: number;
  minutesUntilSlaDeadline?: number;
}

export type LogEvent =
  | { type: "run_started"; threadId: string; scenarioId: string; loadId: string }
  | { type: "agent_message"; text: string }
  | { type: "tool_call"; name: string; args: unknown }
  | { type: "tool_result"; name: string; result: unknown }
  | {
      type: "cost_gate";
      decision: "AUTONOMOUS" | "APPROVAL_REQUIRED" | "INFEASIBLE";
      /** The ceiling that decided the outcome — not always the per-action one. */
      thresholdUsd: number;
      escalationReason?: EscalationReason | null;
      refusal?: { code: string; reason: string } | null;
      costed: CostedProposal | null;
    }
  | { type: "approval_required"; payload: ApprovalPayload }
  | { type: "decision"; approved: boolean }
  | { type: "resume_failed"; message: string }
  | { type: "handover"; message: string }
  | { type: "executed"; detail: Record<string, unknown> }
  | { type: "summary"; text: string }
  | { type: "tms_snapshot"; loads: Load[]; audit: AuditEntry[] }
  | { type: "done"; status: string }
  | { type: "error"; message: string };
