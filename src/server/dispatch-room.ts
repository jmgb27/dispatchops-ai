/**
 * The Durable Object that makes human-in-the-loop approval survive on Workers.
 *
 * The POC keeps two pieces of state in module scope: the LangGraph checkpointer
 * and the mock TMS table. That is correct on a single Node process and wrong on
 * Workers, where there is no isolate affinity — the request that calls
 * `interrupt()` and the request that resumes it are not guaranteed to share
 * memory, so a dispatcher's Approve can land somewhere that has never seen the
 * interrupt.
 *
 * A Durable Object fixes that by construction. Every dispatch request is routed
 * to ONE named instance, so the graph always finds its own checkpoint, and the
 * TMS panel shows one consistent world rather than whatever the isolate that
 * answered happens to remember.
 *
 * A single global instance is deliberate. The checkpointer is per-thread, but
 * the TMS table and audit log are shared demo state — keying the object by
 * thread id would fragment the board across scenarios. Serialising all runs
 * through one object costs nothing at demo volume and buys strong consistency.
 */

import { DurableObject } from "cloudflare:workers";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { Command } from "@langchain/langgraph";
import { HumanMessage } from "@langchain/core/messages";

import {
  compileDispatchGraph,
  type DispatchGraph,
} from "@/agent/graph";
import { streamDispatchRun } from "@/agent/stream";
import {
  resetTms,
  restoreTms,
  snapshotTms,
  type TmsSnapshot,
} from "@/mock/loads";
import { getScenario } from "@/mock/scenarios";

/** Storage keys. */
const CHECKPOINTS_KEY = "checkpoints:v1";
const TMS_KEY = "tms:v1";

/**
 * `MemorySaver`'s `storage` and `writes` are plain nested records of Uint8Array
 * and string, which Durable Object storage serialises natively via structured
 * clone. So durability here is a thin write-through wrapper over LangGraph's own
 * tested checkpointer rather than a hand-rolled one — the interrupt/resume
 * semantics stay exactly the semantics the framework ships.
 */
type CheckpointSnapshot = Pick<MemorySaver, "storage" | "writes">;

class PersistentMemorySaver extends MemorySaver {
  constructor(private readonly markDirty: () => void) {
    super();
  }

  override async put(
    ...args: Parameters<MemorySaver["put"]>
  ): ReturnType<MemorySaver["put"]> {
    const result = await super.put(...args);
    this.markDirty();
    return result;
  }

  override async putWrites(
    ...args: Parameters<MemorySaver["putWrites"]>
  ): Promise<void> {
    await super.putWrites(...args);
    this.markDirty();
  }

  override async deleteThread(threadId: string): Promise<void> {
    await super.deleteThread(threadId);
    this.markDirty();
  }

  snapshot(): CheckpointSnapshot {
    return { storage: this.storage, writes: this.writes };
  }

  hydrate(snapshot: CheckpointSnapshot): void {
    this.storage = snapshot.storage;
    this.writes = snapshot.writes;
  }
}

export class DispatchRoom extends DurableObject {
  private readonly saver: PersistentMemorySaver;
  private readonly graph: DispatchGraph;
  private dirty = false;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);

    this.saver = new PersistentMemorySaver(() => {
      this.dirty = true;
    });
    this.graph = compileDispatchGraph(this.saver);

    // Hydrate before any request is served. `blockConcurrencyWhile` is what
    // guarantees a cold start cannot answer a resume with an empty checkpointer.
    ctx.blockConcurrencyWhile(async () => {
      const [checkpoints, tms] = await Promise.all([
        ctx.storage.get<CheckpointSnapshot>(CHECKPOINTS_KEY),
        ctx.storage.get<TmsSnapshot>(TMS_KEY),
      ]);

      if (checkpoints) this.saver.hydrate(checkpoints);
      if (tms) restoreTms(tms);
    });
  }

  /**
   * Writes both pieces of state back. Called once a run has finished streaming
   * — mid-run persistence would capture a half-applied world.
   */
  private async persist(): Promise<void> {
    await Promise.all([
      this.dirty
        ? this.ctx.storage.put(CHECKPOINTS_KEY, this.saver.snapshot())
        : Promise.resolve(),
      this.ctx.storage.put(TMS_KEY, snapshotTms()),
    ]);
    this.dirty = false;
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/run") return this.run(request);
    if (url.pathname === "/resume") return this.resume(request);

    return Response.json({ error: "Not found" }, { status: 404 });
  }

  private async run(request: Request): Promise<Response> {
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

    return streamDispatchRun({
      input: {
        messages: [new HumanMessage(scenario.event)],
        loadId: scenario.loadId,
      },
      threadId: `run-${scenario.id}-${crypto.randomUUID()}`,
      scenarioId: scenario.id,
      loadId: scenario.loadId,
      emitRunStarted: true,
      graph: this.graph,
      onFinished: () => this.persist(),
    });
  }

  private async resume(request: Request): Promise<Response> {
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
      graph: this.graph,
      onFinished: () => this.persist(),
    });
  }
}
