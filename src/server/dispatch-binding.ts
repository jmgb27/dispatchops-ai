/**
 * Resolves the Durable Object that owns dispatch state, when one exists.
 *
 * Returns null anywhere but a real Worker — `next dev`, `next start`, and the
 * test suite — so those hosts keep running the graph in process against the
 * module-scoped checkpointer. Cloudflare is the only environment that needs the
 * indirection, so it is the only one that pays for it.
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

/**
 * True only inside workerd. Node sets its own `navigator.userAgent`
 * ("Node.js/24"), so this separates a real Worker from `next dev`/`next start`.
 *
 * The check has to come before the binding lookup, not after. Next 16 hands
 * `next dev` the bindings declared in wrangler.jsonc, so DISPATCH_ROOM resolves
 * there to a namespace whose stub is a stand-in for a Durable Object class that
 * only exists in the built worker. It looks real — `idFromName` and `get` both
 * answer — and then `fetch()` throws "Failed to parse URL from [object
 * Request]", which took every dispatch run down with a 500.
 */
function onWorkers(): boolean {
  return globalThis.navigator?.userAgent === "Cloudflare-Workers";
}

export async function getDispatchRoom(): Promise<RoomStub | null> {
  if (!onWorkers()) return null;

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
