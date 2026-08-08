import { Command } from "@langchain/langgraph";

import { streamDispatchRun } from "@/agent/stream";
import { getScenario } from "@/mock/scenarios";
import { getDispatchRoom } from "@/server/dispatch-binding";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Resolves a pending HITL approval. The thread id is what ties this request
 * back to the interrupted run held in the checkpointer.
 */
export async function POST(request: Request) {
  // Must reach the same checkpointer that recorded the interrupt. On Workers
  // that is only guaranteed by going through the Durable Object.
  const room = await getDispatchRoom();
  if (room) {
    return room.fetch(
      new Request("https://dispatch-room/resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: await request.text(),
      }),
    );
  }

  const { threadId, approved, scenarioId } = (await request.json()) as {
    threadId?: string;
    approved?: boolean;
    scenarioId?: string;
  };

  if (!threadId || typeof approved !== "boolean") {
    return Response.json(
      { error: "threadId and approved are required" },
      { status: 400 },
    );
  }

  const scenario = scenarioId ? getScenario(scenarioId) : undefined;

  return streamDispatchRun({
    input: new Command({ resume: { approved } }),
    threadId,
    scenarioId: scenario?.id ?? "unknown",
    loadId: scenario?.loadId ?? "",
    emitRunStarted: false,
  });
}
