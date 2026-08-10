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
const LEGACY_CHECKPOINTS_KEY = "checkpoints:v1";
const INDEX_KEY = "threads:v2";
const THREAD_PREFIX = "thread:v2:";
const TMS_KEY = "tms:v1";

/**
 * Durable Object storage caps a single value at 128 KiB, and one resolved run
 * checkpoints to roughly 57 KiB. v1 wrote every thread the object had ever seen
 * into ONE value, so the third run pushed it past the limit and `put` threw —
 * silently, because the caller swallowed persistence errors to avoid truncating
 * a response that had already streamed.
 *
 * The failure was invisible in the obvious test. The in-memory checkpointer was
 * still correct, so an approval clicked straight away worked; only once the
 * object went idle and rehydrated from a blob frozen at run two did the pending
 * interrupt vanish. Approve then landed on a thread the checkpointer had never
 * seen — the exact silent no-op the resume guard in `src/agent/stream.ts` now
 * refuses to report as success.
 *
 * So checkpoints are stored per thread, one value each, with an explicit index
 * for ordering. Retention is bounded because unbounded growth is what broke it.
 */
const MAX_RETAINED_THREADS = 8;

function threadKey(threadId: string): string {
  return `${THREAD_PREFIX}${threadId}`;
}

/**
 * `MemorySaver`'s `storage` and `writes` are plain nested records of Uint8Array
 * and string, which Durable Object storage serialises natively via structured
 * clone. So durability here is a thin write-through wrapper over LangGraph's own
 * tested checkpointer rather than a hand-rolled one — the interrupt/resume
 * semantics stay exactly the semantics the framework ships.
 */
type CheckpointSnapshot = Pick<MemorySaver, "storage" | "writes">;

/** One thread's slice of the checkpointer — what a single storage value holds. */
interface ThreadSlice {
  storage: CheckpointSnapshot["storage"][string];
  writes: CheckpointSnapshot["writes"][string];
}

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
      const [index, tms] = await Promise.all([
        ctx.storage.get<string[]>(INDEX_KEY),
        ctx.storage.get<TmsSnapshot>(TMS_KEY),
      ]);

      if (index?.length) {
        const slices = await Promise.all(
          index.map((id) => ctx.storage.get<ThreadSlice>(threadKey(id))),
        );

        const storage: CheckpointSnapshot["storage"] = {};
        const writes: CheckpointSnapshot["writes"] = {};
        index.forEach((id, i) => {
          const slice = slices[i];
          if (!slice) return;
          storage[id] = slice.storage;
          writes[id] = slice.writes;
        });
        this.saver.hydrate({ storage, writes });
      }

      if (tms) restoreTms(tms);

      // The v1 blob is dead weight — too large to have been written correctly
      // since the third run, and never read again.
      await ctx.storage.delete(LEGACY_CHECKPOINTS_KEY);
    });
  }

  /**
   * Writes both pieces of state back. Called once a run has finished streaming
   * — mid-run persistence would capture a half-applied world.
   *
   * Only the thread that just ran is written. Rewriting every retained thread on
   * every run is how the single-value version grew until it hit the size cap.
   */
  private async persist(threadId: string): Promise<void> {
    const writeTms = this.ctx.storage.put(TMS_KEY, snapshotTms());

    if (!this.dirty) {
      await writeTms;
      return;
    }

    const { storage, writes } = this.saver.snapshot();
    const index = (await this.ctx.storage.get<string[]>(INDEX_KEY)) ?? [];
    const ordered = [...index.filter((id) => id !== threadId), threadId];
    const dropped = ordered.slice(0, Math.max(0, ordered.length - MAX_RETAINED_THREADS));
    const retained = ordered.slice(-MAX_RETAINED_THREADS);

    await Promise.all([
      writeTms,
      this.ctx.storage.put(threadKey(threadId), {
        storage: storage[threadId] ?? {},
        writes: writes[threadId] ?? {},
      } satisfies ThreadSlice),
      this.ctx.storage.put(INDEX_KEY, retained),
      ...dropped.map((id) => this.ctx.storage.delete(threadKey(id))),
    ]);

    // Drop pruned threads from memory too, or a long-lived instance keeps every
    // run it has ever served and the snapshot grows without bound again.
    for (const id of dropped) {
      delete storage[id];
      delete writes[id];
    }

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
      graph: this.graph,
      onFinished: () => this.persist(threadId),
      waitUntil: (promise) => this.ctx.waitUntil(promise),
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
      onFinished: () => this.persist(threadId),
      waitUntil: (promise) => this.ctx.waitUntil(promise),
    });
  }
}
