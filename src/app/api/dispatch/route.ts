import { HumanMessage } from "@langchain/core/messages";

import { streamDispatchRun } from "@/agent/stream";
import { resetTms } from "@/mock/loads";
import { getScenario } from "@/mock/scenarios";
import { getDispatchRoom } from "@/server/dispatch-binding";

/** The Langfuse OTel span processor needs the Node runtime, not Edge. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  // On Cloudflare the run belongs to the Durable Object, which owns the
  // checkpointer the eventual resume has to find. See src/server/dispatch-room.ts.
  const room = await getDispatchRoom();
  if (room) {
    return room.fetch(
      new Request("https://dispatch-room/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: await request.text(),
      }),
    );
  }

  const { scenarioId } = (await request.json()) as { scenarioId?: string };
  const scenario = scenarioId ? getScenario(scenarioId) : undefined;

  if (!scenario) {
    return Response.json(
      { error: `Unknown scenario ${scenarioId}` },
      { status: 400 },
    );
  }

  // Each demo run starts from a clean TMS so the dashboard is reproducible.
  resetTms();

  const threadId = `run-${scenario.id}-${crypto.randomUUID()}`;

  return streamDispatchRun({
    input: {
      messages: [new HumanMessage(scenario.event)],
      loadId: scenario.loadId,
    },
    threadId,
    scenarioId: scenario.id,
    loadId: scenario.loadId,
    emitRunStarted: true,
  });
}
