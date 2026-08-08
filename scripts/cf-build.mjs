/**
 * Cloudflare build wrapper.
 *
 * `instrumentation.ts` registers a `NodeTracerProvider` from
 * `@opentelemetry/sdk-trace-node` for Langfuse. Two reasons it does not come
 * along to Workers:
 *
 *   1. Next 16.3's standalone output emits `instrumentation.js.nft.json` but
 *      not the `.js` file beside it, and OpenNext's `copyTracedFiles` throws on
 *      the mismatch.
 *   2. The provider is a Node-specific path, and bundling the OTel Node SDK
 *      pushes the Worker toward the free plan's 3 MB compressed ceiling for a
 *      feature that would not run there anyway.
 *
 * So the hook is set aside for the duration of the Cloudflare build and put
 * back afterwards. Tracing is untouched under Node (`npm run dev` / `start`);
 * on Workers the app self-disables it, which it already does whenever the
 * Langfuse keys are unset.
 */

import { spawnSync } from "node:child_process";
import { existsSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const live = join(root, "instrumentation.ts");
const parked = join(root, "instrumentation.node.ts.parked");

let moved = false;

function restore() {
  if (moved && existsSync(parked)) {
    renameSync(parked, live);
    moved = false;
  }
}

// Restore even if the build is interrupted — leaving the repo without its
// instrumentation hook would silently disable tracing on every other host.
process.on("exit", restore);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    restore();
    process.exit(1);
  });
}

if (existsSync(live)) {
  renameSync(live, parked);
  moved = true;
}

const result = spawnSync(
  "npx",
  ["opennextjs-cloudflare", "build", ...process.argv.slice(2)],
  { stdio: "inherit", cwd: root },
);

restore();
process.exit(result.status ?? 1);
