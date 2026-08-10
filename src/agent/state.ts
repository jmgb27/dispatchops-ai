import { Annotation, messagesStateReducer } from "@langchain/langgraph";
import type { BaseMessage } from "@langchain/core/messages";

import type { AutonomyDecision } from "@/spend-policy";
import type { CostedProposal } from "./cost";

export type RunStatus =
  | "RUNNING"
  | "PENDING_HUMAN_APPROVAL"
  | "RESOLVED_AUTONOMOUS"
  | "RESOLVED_AFTER_APPROVAL"
  | "REJECTED_BY_HUMAN"
  | "FAILED";

export interface RerouteProposal {
  loadId: string;
  resourceId: string;
  justification: string;
  /** The tool_call_id of the model's execute_reroute request, so we can reply to it. */
  toolCallId: string;
}

export const DispatchState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
  loadId: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => "",
  }),
  /** What the model asked to do, pending pricing. */
  proposal: Annotation<RerouteProposal | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  /** What the deterministic cost model said it would cost. */
  costed: Annotation<CostedProposal | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  /**
   * The guardrail verdict on the priced proposal — every ceiling, not just the
   * per-action one. Written by the cost gate and read by its routing function,
   * so the branch is a lookup rather than a second evaluation of the policy.
   */
  autonomy: Annotation<AutonomyDecision | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  /** Set by the approval node once a dispatcher resolves the interrupt. */
  humanDecision: Annotation<"APPROVED" | "REJECTED" | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  status: Annotation<RunStatus>({
    reducer: (_prev, next) => next,
    default: () => "RUNNING",
  }),
});

export type DispatchStateType = typeof DispatchState.State;
