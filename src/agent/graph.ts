/**
 * The DispatchOps agent graph.
 *
 * The important property of this file: the model never reaches a write. It can
 * *request* `execute_reroute`, but that request lands in `costGateNode`, which
 * prices it with deterministic code and decides — by comparing a number to a
 * threshold — whether the run continues autonomously or halts for a human.
 * No prompt can talk its way past that edge, because no prompt is consulted.
 */

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

import { reassignLoad, tenderLoad } from "@/mock/loads";
import {
  calculateActionCost,
  maxAutonomousSpendUsd,
  requiresHumanApproval,
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
    return { costed: null, proposal: null };
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

  let costed;
  try {
    costed = calculateActionCost(proposal.loadId, proposal.resourceId);
  } catch (err) {
    return {
      proposal,
      costed: null,
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

  return { proposal, costed };
}

async function approvalNode(state: DispatchStateType) {
  const costed = state.costed!;
  const proposal = state.proposal!;

  const decision = interrupt({
    type: "COST_APPROVAL",
    loadId: proposal.loadId,
    resourceId: proposal.resourceId,
    resourceName: costed.resourceName,
    resourceKind: costed.resourceKind,
    justification: proposal.justification,
    thresholdUsd: maxAutonomousSpendUsd(),
    breakdown: costed,
  }) as { approved?: boolean } | undefined;

  if (decision?.approved) {
    return { humanDecision: "APPROVED" as const };
  }

  return {
    humanDecision: "REJECTED" as const,
    status: "REJECTED_BY_HUMAN" as const,
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

function routeFromCostGate(state: DispatchStateType) {
  const costed = state.costed;
  if (!costed || costed.infeasibleReason) return "agent";
  return requiresHumanApproval(costed.totalUsd) ? "approval" : "execute";
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
  .addNode("summarize", summarizeNode)
  .addEdge(START, "agent")
  .addConditionalEdges("agent", routeFromAgent, ["tools", "costGate", END])
  .addEdge("tools", "agent")
  .addConditionalEdges("costGate", routeFromCostGate, [
    "approval",
    "execute",
    "agent",
  ])
  .addConditionalEdges("approval", routeFromApproval, ["execute", "agent"])
  .addEdge("execute", "summarize")
  .addEdge("summarize", END);

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
