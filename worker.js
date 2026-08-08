/**
 * Cloudflare Worker entrypoint.
 *
 * OpenNext generates `.open-next/worker.js` at build time, which serves the
 * Next.js app and exports the Durable Objects its cache layer uses. Wrangler
 * points at this file instead so DispatchOps' own Durable Object is exported
 * alongside them — a DO class is only reachable if the entry module exports it.
 *
 * Plain JS on purpose: `next build` type-checks every .ts file in the project,
 * and the module this re-exports does not exist until OpenNext has run.
 */

export { default } from "./.open-next/worker.js";
export {
  BucketCachePurge,
  DOQueueHandler,
  DOShardedTagCache,
} from "./.open-next/worker.js";

export { DispatchRoom } from "./src/server/dispatch-room";
