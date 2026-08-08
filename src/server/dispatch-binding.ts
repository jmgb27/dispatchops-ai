/**
 * Resolves the Durable Object that owns dispatch state, when one exists.
 *
 * Returns null anywhere there is no Cloudflare binding — `next dev`, `next
 * start`, and the test suite — so those hosts keep running the graph in process
 * against the module-scoped checkpointer. Cloudflare is the only environment
 * that needs the indirection, so it is the only one that pays for it.
 */

/** The single instance every dispatch request is routed to. */
export const DISPATCH_ROOM_NAME = "dispatchops-global";

/** Binding name declared in wrangler.jsonc. */
const BINDING = "DISPATCH_ROOM";

type RoomStub = { fetch: (request: Request) => Promise<Response> };

type RoomNamespace = {
  idFromName: (name: string) => unknown;
  get: (id: unknown) => RoomStub;
};

export async function getDispatchRoom(): Promise<RoomStub | null> {
  try {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    const { env } = await getCloudflareContext({ async: true });
    const namespace = (env as Record<string, unknown>)[BINDING] as
      | RoomNamespace
      | undefined;

    if (!namespace) return null;
    return namespace.get(namespace.idFromName(DISPATCH_ROOM_NAME));
  } catch {
    // Not running on Workers.
    return null;
  }
}
