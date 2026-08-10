/**
 * Translates LangGraph state updates into the SSE event vocabulary the
 * dashboard renders. Keeping this mapping in one place means the run route and
 * the resume route stay identical from the client's point of view.
 */

import type { AIMessage, ToolMessage } from "@langchain/core/messages";
import type { Command } from "@langchain/langgraph";

import { getAuditLog, listLoads } from "@/mock/loads";
import { maxAutonomousSpendUsd, type EscalationReason } from "@/spend-policy";
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
      /** The ceiling that decided the outcome — not always the per-action one. */
      thresholdUsd: number;
      escalationReason: EscalationReason | null;
      costed: unknown;
    }
  | { type: "approval_required"; payload: unknown }
  /** A dispatcher's decision, once the graph has actually taken it up. */
  | { type: "decision"; approved: boolean }
  /** The resume could not be applied — see the stale-thread guard below. */
  | { type: "resume_failed"; message: string }
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
    const autonomy = update.autonomy;
    // The verdict is read off state rather than recomputed. Deriving it a second
    // time from the per-action threshold alone would report AUTONOMOUS for a run
    // the gate actually escalated on a cumulative ceiling — a trace that
    // disagrees with the control flow is worse than no trace.
    events.push({
      type: "cost_gate",
      decision: !costed || costed.infeasibleReason
        ? "INFEASIBLE"
        : autonomy?.requiresApproval
          ? "APPROVAL_REQUIRED"
          : "AUTONOMOUS",
      thresholdUsd: autonomy?.ceilingUsd ?? maxAutonomousSpendUsd(),
      escalationReason: autonomy?.reason ?? null,
      costed: costed ?? null,
    });
  }

  // The approval node produces an update only once a decision has come back —
  // on the initial pass `interrupt()` unwinds it before it can return anything.
  // So an update here always means a dispatcher actually decided.
  if (node === "approval" && update.humanDecision) {
    events.push({
      type: "decision",
      approved: update.humanDecision === "APPROVED",
    });
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
  /**
   * Extends the current request's lifetime. Required on Cloudflare — see the
   * note on eager production below.
   */
  waitUntil?: (promise: Promise<unknown>) => void;
}): Response {
  const encoder = new TextEncoder();
  const graph = opts.graph ?? dispatchGraph;

  /**
   * The graph is driven by an eagerly-started producer writing into a
   * TransformStream, rather than from inside `ReadableStream.start()`.
   *
   * That is not a style choice. `start()` is invoked lazily, when the body is
   * first read — which on Cloudflare is after the Durable Object's `fetch()`
   * has already returned, in a different I/O context. LangGraph tracks the
   * running graph in an AsyncLocalStorage, so the continuation loses it and
   * `interrupt()` throws "Called interrupt() outside the context of a graph",
   * taking the entire human-in-the-loop path down. Starting the producer here
   * keeps it in the request's async context, and `waitUntil` keeps that context
   * alive until the run finishes.
   *
   * Local `wrangler dev` does not enforce the context boundary, so this only
   * ever reproduces in production.
   */
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();

  const producer = (async () => {
    {
      const send = (event: DispatchEvent) => {
        void writer.write(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
        );
      };

      /** Flushes state to durable storage exactly once, whatever the outcome. */
      let finished = false;
      const finish = async () => {
        if (finished) return;
        finished = true;
        try {
          await opts.onFinished?.();
        } catch (err) {
          // Persistence failure must not truncate a response already streamed —
          // but it must not be silent either. Swallowing this is what hid a
          // storage-limit error for as long as it took someone to click Approve
          // and be told, wrongly, that nothing had changed.
          console.error("[dispatch] persisting run state failed", err);
        }
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

        /**
         * A resume against a thread the checkpointer does not hold is a silent
         * no-op: LangGraph has nothing to continue, so the stream yields no
         * updates and the run ends `done` with nothing executed and no error.
         *
         * On screen that is indistinguishable from a rejection — the console
         * shows "nothing was changed" either way — so a dispatcher who clicks
         * Approve on a thread that has aged out is told their decision landed
         * when it did not. For a financial control that is the worst failure
         * mode available: silent, and confidently wrong.
         *
         * The thread can go missing legitimately: a redeployed Worker, an
         * evicted Durable Object, or a console left open across either.
         */
        if (!opts.emitRunStarted) {
          const snapshot = await graph.getState({
            configurable: { thread_id: opts.threadId },
          });
          if (!snapshot?.next?.length) {
            send({
              type: "resume_failed",
              message:
                "That decision could not be applied — this run is no longer " +
                "waiting for one. It most likely expired, or the server " +
                "restarted. Nothing was changed. Run the scenario again.",
            });
            await finish();
            send({ type: "tms_snapshot", loads: listLoads(), audit: getAuditLog() });
            send({ type: "done", status: "EXPIRED" });
            return;
          }
        }

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

        // Persist BEFORE announcing the run is over. The console enables the
        // Approve button on `done`, and a dispatcher who clicks it immediately
        // must not race the checkpoint that records the interrupt — losing that
        // race resumes a thread the checkpointer has not seen yet, which ends
        // the run silently with nothing executed.
        await finish();

        send({ type: "tms_snapshot", loads: listLoads(), audit: getAuditLog() });
        send({
          type: "done",
          status: interrupted ? "PENDING_HUMAN_APPROVAL" : finalStatus,
        });
      } catch (err) {
        await finish();
        send({ type: "error", message: (err as Error).message });
      } finally {
        await flushTraces();
        await writer.close();
      }
    }
  })();

  opts.waitUntil?.(producer);

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
