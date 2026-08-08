/**
 * Langfuse tracing (README §5.1).
 *
 * Every graph run is traced as a session so a reviewer can open one exception
 * and see the whole decision path — each Qwen call, each tool result, token
 * counts and cost. Tracing is strictly optional: with no keys set the factory
 * returns an empty callback array and the app behaves identically.
 */

import { CallbackHandler } from "@langfuse/langchain";

export function langfuseEnabled(): boolean {
  return Boolean(
    process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY,
  );
}

/**
 * Runs `fn` inside a Langfuse attribute context so the resulting trace carries a
 * readable name. The LangChain CallbackHandler has no `traceName` option — the
 * name comes from the surrounding propagated context, not from the handler.
 */
export async function withTraceContext<T>(
  params: { traceName: string; sessionId: string; tags: string[] },
  fn: () => Promise<T>,
): Promise<T> {
  if (!langfuseEnabled()) return fn();

  const { propagateAttributes } = await import("@langfuse/tracing");
  return propagateAttributes(params, fn);
}

/**
 * Pushes any batched spans immediately. Call once a run has finished streaming:
 * the OTel processor batches on a timer, and a serverless instance may be
 * frozen before that timer fires.
 */
export async function flushTraces(): Promise<void> {
  if (!langfuseEnabled()) return;

  const processor = (
    globalThis as unknown as {
      __langfuseSpanProcessor?: { forceFlush?: () => Promise<void> };
    }
  ).__langfuseSpanProcessor;

  try {
    await processor?.forceFlush?.();
  } catch {
    // Losing a trace must never fail a dispatch run.
  }
}

/**
 * Callbacks for one dispatch run. `sessionId` is the graph thread id, so the
 * initial run and the post-approval resume land in the same Langfuse session.
 */
export function runCallbacks(opts: {
  threadId: string;
  scenarioId: string;
  loadId: string;
}) {
  if (!langfuseEnabled()) return [];

  return [
    new CallbackHandler({
      sessionId: opts.threadId,
      tags: ["dispatchops", `scenario:${opts.scenarioId}`, `load:${opts.loadId}`],
      traceMetadata: {
        scenarioId: opts.scenarioId,
        loadId: opts.loadId,
        model: process.env.QWEN_MODEL || "qwen3.7-plus",
      },
    }),
  ];
}
