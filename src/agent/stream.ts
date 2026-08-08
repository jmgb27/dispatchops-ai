/**
 * Translates LangGraph state updates into the SSE event vocabulary the
 * dashboard renders. Keeping this mapping in one place means the run route and
 * the resume route stay identical from the client's point of view.
 */

import type { AIMessage, ToolMessage } from "@langchain/core/messages";
import type { Command } from "@langchain/langgraph";

import { getAuditLog, listLoads } from "@/mock/loads";
import { dispatchGraph, type DispatchGraph } from "./graph";
import {
  flushTraces,
  runCallbacks,
  withTraceContext,
} from "./observability";
import type { DispatchStateType } from "./state";

export type DispatchEvent =
  | { type: "run_started"; threadId: string; scenarioId: string; loadId: string }
  | { type: "agent_message"; text: string }
  | { type: "tool_call"; name: string; args: unknown }
  | { type: "tool_result"; name: string; result: unknown }
  | {
      type: "cost_gate";
      decision: "AUTONOMOUS" | "APPROVAL_REQUIRED" | "INFEASIBLE";
      thresholdUsd: number;
      costed: unknown;
    }
  | { type: "approval_required"; payload: unknown }
  | { type: "executed"; detail: unknown }
  | { type: "summary"; text: string }
  | { type: "tms_snapshot"; loads: unknown; audit: unknown }
  | { type: "done"; status: string }
  | { type: "error"; message: string };

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "string"
          ? part
          : typeof part === "object" && part && "text" in part
            ? String((part as { text: unknown }).text)
            : "",
      )
      .join("");
  }
  return "";
}

function parseMaybeJson(raw: unknown): unknown {
  try {
    return JSON.parse(String(raw));
  } catch {
    return String(raw);
  }
}

/** Fans one node update out into zero or more client events. */
function eventsForUpdate(node: string, update: Partial<DispatchStateType>): DispatchEvent[] {
  const events: DispatchEvent[] = [];
  const messages = (update.messages ?? []) as unknown as (AIMessage | ToolMessage)[];

  if (node === "agent") {
    for (const m of messages) {
      const text = messageText(m.content).trim();
      if (text) events.push({ type: "agent_message", text });
      for (const call of (m as AIMessage).tool_calls ?? []) {
        events.push({ type: "tool_call", name: call.name, args: call.args });
      }
    }
  }

  if (node === "tools") {
    for (const m of messages) {
      events.push({
        type: "tool_result",
        name: (m as ToolMessage).name ?? "tool",
        result: parseMaybeJson(m.content),
      });
    }
  }

  if (node === "costGate") {
    const costed = update.costed;
    if (!costed) {
      events.push({
        type: "cost_gate",
        decision: "INFEASIBLE",
        thresholdUsd: Number(process.env.MAX_AUTONOMOUS_SPEND_USD ?? 500),
        costed: null,
      });
    } else {
      const threshold = Number(process.env.MAX_AUTONOMOUS_SPEND_USD ?? 500);
      events.push({
        type: "cost_gate",
        decision: costed.infeasibleReason
          ? "INFEASIBLE"
          : costed.totalUsd >= threshold
            ? "APPROVAL_REQUIRED"
            : "AUTONOMOUS",
        thresholdUsd: threshold,
        costed,
      });
    }
  }

  if (node === "execute") {
    for (const m of messages) {
      events.push({ type: "executed", detail: parseMaybeJson(m.content) });
    }
  }

  if (node === "summarize") {
    for (const m of messages) {
      const text = messageText(m.content).trim();
      if (text) events.push({ type: "summary", text });
    }
  }

  return events;
}

export function streamDispatchRun(opts: {
  input: Partial<DispatchStateType> | Command;
  threadId: string;
  scenarioId: string;
  loadId: string;
  emitRunStarted: boolean;
  /**
   * Graph to run. Defaults to the in-process one; the Cloudflare Durable Object
   * passes a graph compiled against its own persistent checkpointer.
   */
  graph?: DispatchGraph;
  /**
   * Called once the run has finished streaming, successfully or not. The
   * Durable Object uses this to persist checkpoints and TMS state — it has to
   * happen after the graph is done, not when the Response is returned.
   */
  onFinished?: () => Promise<void>;
}): Response {
  const encoder = new TextEncoder();
  const graph = opts.graph ?? dispatchGraph;

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: DispatchEvent) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      try {
        if (opts.emitRunStarted) {
          send({
            type: "run_started",
            threadId: opts.threadId,
            scenarioId: opts.scenarioId,
            loadId: opts.loadId,
          });
        }

        let finalStatus = "RUNNING";
        let interrupted = false;

        const traceName = opts.emitRunStarted
          ? `dispatch:${opts.scenarioId}`
          : `dispatch:${opts.scenarioId}:resume`;
        const tags = [
          "dispatchops",
          `scenario:${opts.scenarioId}`,
          `load:${opts.loadId}`,
        ];

        await withTraceContext(
          { traceName, sessionId: opts.threadId, tags },
          async () => {
            const stream = await graph.stream(opts.input as never, {
              configurable: { thread_id: opts.threadId },
              callbacks: runCallbacks({
                threadId: opts.threadId,
                scenarioId: opts.scenarioId,
                loadId: opts.loadId,
              }),
              streamMode: "updates",
              recursionLimit: 40,
            });

            for await (const chunk of stream) {
              for (const [node, update] of Object.entries(
                chunk as Record<string, unknown>,
              )) {
                if (node === "__interrupt__") {
                  interrupted = true;
                  const first = (update as { value: unknown }[])[0];
                  send({ type: "approval_required", payload: first?.value });
                  continue;
                }

                const typed = update as Partial<DispatchStateType>;
                if (typed.status) finalStatus = typed.status;
                for (const event of eventsForUpdate(node, typed)) send(event);
              }
            }
          },
        );

        send({ type: "tms_snapshot", loads: listLoads(), audit: getAuditLog() });
        send({
          type: "done",
          status: interrupted ? "PENDING_HUMAN_APPROVAL" : finalStatus,
        });
      } catch (err) {
        send({ type: "error", message: (err as Error).message });
      } finally {
        try {
          await opts.onFinished?.();
        } catch {
          // Persistence failure must not truncate a response already streamed.
        }
        await flushTraces();
        controller.close();
      }
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
