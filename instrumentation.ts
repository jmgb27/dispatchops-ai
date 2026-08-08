/**
 * Next.js instrumentation hook — runs once when the server boots.
 *
 * The Langfuse v5 SDK is OpenTelemetry-based: the CallbackHandler emits spans
 * and LangfuseSpanProcessor ships them. Without a registered provider the
 * handler is silently inert, so this registration is what actually turns
 * tracing on.
 */

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (!process.env.LANGFUSE_PUBLIC_KEY || !process.env.LANGFUSE_SECRET_KEY) {
    return;
  }

  const { LangfuseSpanProcessor } = await import("@langfuse/otel");
  const { NodeTracerProvider } = await import("@opentelemetry/sdk-trace-node");

  const processor = new LangfuseSpanProcessor();

  // Kept on globalThis so a finished request can force a flush. Spans are
  // batched, and a serverless instance can be frozen before the timer fires —
  // that loses traces silently, which is worse than not tracing at all.
  (
    globalThis as unknown as { __langfuseSpanProcessor?: unknown }
  ).__langfuseSpanProcessor = processor;

  new NodeTracerProvider({ spanProcessors: [processor] }).register();
}
