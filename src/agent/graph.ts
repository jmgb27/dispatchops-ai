/**
 * The DispatchOps agent graph.
 *
 * The important property of this file: the model never reaches a write. It can
 * *request* `execute_reroute`, but that request lands in `costGateNode`, which
 * prices it with deterministic code and decides — by comparing a number to a
 * threshold — whether the run continues autonomously or halts for a human.
 * No prompt can talk its way past that edge, because no prompt is consulted.
 */

// Must precede any LangChain import that could run a graph — see the module.
import "./async-context";

import {
  END,
  MemorySaver,
  START,
  StateGraph,
  interrupt,
} from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import {
  AIMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";

import { getLoad, reassignLoad, spendLedger, tenderLoad } from "@/mock/loads";
import { describeEscalation } from "@/spend-policy";
import {
  calculateActionCost,
  evaluateAutonomy,
  maxAutonomousSpendUsd,
} from "./cost";
import { SYSTEM_PROMPT, buildBoundModel, buildModel } from "./model";
import { buildMockBoundModel, buildMockSummaryModel } from "./mockModel";
import { DispatchState, type DispatchStateType } from "./state";
import { EXECUTE_REROUTE_NAME, READ_TOOLS } from "./tools";

function isMockAgent(): boolean {
  return process.env.MOCK_AGENT === "1";
}

// ── Nodes ────────────────────────────────────────────────────────────────────

async function agentNode(state: DispatchStateType) {
  const model = isMockAgent() ? buildMockBoundModel() : buildBoundModel();
  const response = await model.invoke([
    new SystemMessage(SYSTEM_PROMPT),
    ...state.messages,
  ]);
  return { messages: [response] };
}

const toolNode = new ToolNode(READ_TOOLS);

/**
 * README §4.1's pre-execution hook. Prices the model's proposal and records the
 * result on state; the routing function below turns that number into control flow.
 */
async function costGateNode(state: DispatchStateType) {
  const last = state.messages[state.messages.length - 1] as AIMessage;
  const call = last.tool_calls?.find((tc) => tc.name === EXECUTE_REROUTE_NAME);

  if (!call?.id) {
    return { costed: null, proposal: null, autonomy: null };
  }

  const args = call.args as {
    load_id?: string;
    resource_id?: string;
    justification?: string;
  };

  const proposal = {
    loadId: args.load_id ?? state.loadId,
    resourceId: args.resource_id ?? "",
    justification: args.justification ?? "",
    toolCallId: call.id,
  };

  // A human's "no" is a constraint, not a suggestion. Same shape as the HOS
  // refusal below: the option is removed from the space, and no amount of
  // re-arguing puts it back. Without this the run loops — the agent re-proposes
  // the only feasible option, gets approval-gated, is rejected, and starts over.
  if (state.declined.includes(proposal.resourceId)) {
    return {
      proposal,
      costed: null,
      autonomy: null,
      reproposals: state.reproposals + 1,
      messages: [
        new ToolMessage({
          tool_call_id: call.id,
          name: EXECUTE_REROUTE_NAME,
          content: JSON.stringify({
            executed: false,
            refused: "ALREADY_DECLINED",
            reason: `A dispatcher has already declined ${proposal.resourceId} for this load. That decision stands.`,
            hint: "Propose a different resource, or say plainly that no other option exists.",
          }),
        }),
      ],
    };
  }

  let costed;
  try {
    costed = calculateActionCost(proposal.loadId, proposal.resourceId);
  } catch (err) {
    return {
      proposal,
      costed: null,
      autonomy: null,
      messages: [
        new ToolMessage({
          tool_call_id: call.id,
          name: EXECUTE_REROUTE_NAME,
          content: JSON.stringify({
            executed: false,
            error: (err as Error).message,
          }),
        }),
      ],
    };
  }

  // Feasibility is also structural: an HOS-illegal or region-illegal assignment
  // is refused outright, whatever it costs and whatever the model argued.
  if (costed.infeasibleReason) {
    return {
      proposal,
      costed,
      autonomy: null,
      messages: [
        new ToolMessage({
          tool_call_id: call.id,
          name: EXECUTE_REROUTE_NAME,
          content: JSON.stringify({
            executed: false,
            refused: "INFEASIBLE",
            reason: costed.infeasibleReason,
            hint: "Choose a different resource that can legally run this load.",
          }),
        }),
      ],
    };
  }

  // Priced and feasible. The remaining question is authority, and it is not
  // answerable from this action alone — a $450 reroute is within the per-action
  // ceiling and still out of bounds if it is the fourth one today.
  const autonomy = evaluateAutonomy(
    costed.totalUsd,
    spendLedger(proposal.loadId),
  );

  return { proposal, costed, autonomy };
}

async function approvalNode(state: DispatchStateType) {
  const costed = state.costed!;
  const proposal = state.proposal!;

  // The load's own figures travel with the request. A dispatcher approving a
  // spend needs the exposure it buys off — the penalty, the customer and what
  // is on the trailer — not just the number being asked for.
  const load = getLoad(proposal.loadId);

  const decision = interrupt({
    type: "COST_APPROVAL",
    loadId: proposal.loadId,
    resourceId: proposal.resourceId,
    resourceName: costed.resourceName,
    resourceKind: costed.resourceKind,
    justification: proposal.justification,
    thresholdUsd: maxAutonomousSpendUsd(),
    // Which ceiling stopped it, and the running total behind that answer. A
    // dispatcher seeing a $420 request needs to know it is the fourth today,
    // or the card is asking them to approve something that looks routine.
    autonomy: state.autonomy ?? undefined,
    escalationReason: state.autonomy
      ? describeEscalation(state.autonomy)
      : undefined,
    breakdown: costed,
    customer: load?.customer,
    cargo: load?.cargo,
    slaPenaltyUsd: load?.slaPenaltyUsd,
    minutesUntilSlaDeadline: load?.minutesUntilSlaDeadline,
  }) as { approved?: boolean } | undefined;

  if (decision?.approved) {
    return { humanDecision: "APPROVED" as const };
  }

  return {
    humanDecision: "REJECTED" as const,
    status: "REJECTED_BY_HUMAN" as const,
    // Recorded on state, not just reported in the transcript.
    declined: [proposal.resourceId],
    messages: [
      new ToolMessage({
        tool_call_id: proposal.toolCallId,
        name: EXECUTE_REROUTE_NAME,
        content: JSON.stringify({
          executed: false,
          refused: "REJECTED_BY_DISPATCHER",
          reason: `A human dispatcher declined this $${costed.totalUsd} action.`,
          hint: "Propose a cheaper feasible option, or explain that none exists.",
        }),
      }),
    ],
  };
}

/** The only place in the codebase that mutates the TMS. */
async function executeNode(state: DispatchStateType) {
  const costed = state.costed!;
  const proposal = state.proposal!;
  const approvedBy =
    state.humanDecision === "APPROVED" ? "HUMAN_DISPATCHER" : "AGENT_AUTONOMOUS";

  const load =
    costed.resourceKind === "THIRD_PARTY_CARRIER"
      ? tenderLoad(proposal.loadId, proposal.resourceId, costed.totalUsd, approvedBy)
      : reassignLoad(proposal.loadId, proposal.resourceId, costed.totalUsd, approvedBy);

  return {
    status:
      approvedBy === "HUMAN_DISPATCHER"
        ? ("RESOLVED_AFTER_APPROVAL" as const)
        : ("RESOLVED_AUTONOMOUS" as const),
    messages: [
      new ToolMessage({
        tool_call_id: proposal.toolCallId,
        name: EXECUTE_REROUTE_NAME,
        content: JSON.stringify({
          executed: true,
          load_id: load.loadId,
          new_status: load.status,
          assigned_to: load.assignedDriverId,
          cost_usd: costed.totalUsd,
          approved_by: approvedBy,
        }),
      }),
    ],
  };
}

/**
 * The stop. Reached when the agent keeps re-proposing something already
 * declined, which is what it does when the declined option was the only
 * feasible one and it can see that clearly.
 *
 * Written by the graph rather than the model, because "I give up" is exactly
 * the sentence you do not want a model improvising — and because at this point
 * the useful output is a handover, not more reasoning.
 */
async function handoverNode(state: DispatchStateType) {
  const load = getLoad(state.loadId);
  const declined = state.declined.join(", ");

  return {
    status: "HANDED_TO_DISPATCHER" as const,
    handoverNote:
      `Out of options. You declined ${declined}, and there is nothing else ` +
      `this load can legally go to. ` +
      `${load ? `Load ${load.loadId.replace(/^LOAD-/, "")} is still with ${load.assignedDriverId} and still ${load.status.toLowerCase()}` : "The load is unchanged"}` +
      `, so the delivery window is now yours to protect. Nothing was changed.`,
  };
}

/**
 * Final dispatcher-facing summary. Runs on a model with no tools bound, so the
 * run cannot loop back into another write after the TMS has been mutated.
 */
async function summarizeNode(state: DispatchStateType) {
  const model = isMockAgent() ? buildMockSummaryModel() : buildModel();
  const response = await model.invoke([
    new SystemMessage(SYSTEM_PROMPT),
    ...state.messages,
    new SystemMessage(
      "The reroute is committed. Write a 2-3 sentence handover note for the " +
        "duty dispatcher: what happened, what you did, what it cost, and the " +
        "SLA outcome. Plain prose, no tool calls.",
    ),
  ]);
  return { messages: [response] };
}

// ── Routing ──────────────────────────────────────────────────────────────────

function routeFromAgent(state: DispatchStateType) {
  const last = state.messages[state.messages.length - 1] as AIMessage;
  const calls = last?.tool_calls ?? [];

  if (calls.length === 0) return END;
  if (calls.some((tc) => tc.name === EXECUTE_REROUTE_NAME)) return "costGate";
  return "tools";
}

/**
 * How many times the agent may re-propose something a human already declined
 * before the graph stops it. One re-proposal is a reasonable misunderstanding
 * and the refusal explains itself; a second means it is stuck.
 */
const MAX_REPROPOSALS = 2;

function routeFromCostGate(state: DispatchStateType) {
  if (state.reproposals >= MAX_REPROPOSALS) return "handover";

  const costed = state.costed;
  if (!costed || costed.infeasibleReason) return "agent";
  // Fail closed: a feasible proposal always carries a verdict, and a missing one
  // means something upstream is wrong. Ask a human rather than assume authority.
  if (!state.autonomy) return "approval";
  return state.autonomy.requiresApproval ? "approval" : "execute";
}

function routeFromApproval(state: DispatchStateType) {
  return state.humanDecision === "APPROVED" ? "execute" : "agent";
}

// ── Assembly ─────────────────────────────────────────────────────────────────

const workflow = new StateGraph(DispatchState)
  .addNode("agent", agentNode)
  .addNode("tools", toolNode)
  .addNode("costGate", costGateNode)
  .addNode("approval", approvalNode)
  .addNode("execute", executeNode)
  .addNode("handover", handoverNode)
  .addNode("summarize", summarizeNode)
  .addEdge(START, "agent")
  .addConditionalEdges("agent", routeFromAgent, ["tools", "costGate", END])
  .addEdge("tools", "agent")
  .addConditionalEdges("costGate", routeFromCostGate, [
    "approval",
    "execute",
    "agent",
    "handover",
  ])
  .addConditionalEdges("approval", routeFromApproval, ["execute", "agent"])
  .addEdge("execute", "summarize")
  .addEdge("summarize", END)
  .addEdge("handover", END);

/**
 * Compiles the graph against a caller-supplied checkpointer.
 *
 * On Cloudflare Workers there is no isolate affinity, so the request that
 * interrupts and the request that resumes are not guaranteed to share memory.
 * The Durable Object in `src/server/dispatch-room.ts` owns a persistent
 * checkpointer and compiles the graph against it.
 */
export function compileDispatchGraph(checkpointer: BaseCheckpointSaver) {
  return workflow.compile({ checkpointer });
}

export type DispatchGraph = ReturnType<typeof compileDispatchGraph>;

/**
 * The in-process graph, for `next dev`, `next start` and the test suite. A
 * single checkpointer instance must survive between the request that interrupts
 * and the request that resumes, so it is cached on globalThis — otherwise Next's
 * dev hot-reload silently strands in-flight approvals.
 */
const globalForGraph = globalThis as unknown as {
  __dispatchCheckpointer?: MemorySaver;
};

const checkpointer =
  globalForGraph.__dispatchCheckpointer ??
  (globalForGraph.__dispatchCheckpointer = new MemorySaver());

export const dispatchGraph = workflow.compile({ checkpointer });
