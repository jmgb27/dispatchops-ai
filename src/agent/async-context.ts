/**
 * Installs a real AsyncLocalStorage for LangChain on non-Node runtimes.
 *
 * LangGraph's `interrupt()` finds the running graph through
 * `AsyncLocalStorageProviderSingleton`. When nothing has installed a real
 * instance, the provider falls back to `MockAsyncLocalStorage`, whose
 * `getStore()` returns undefined — so `interrupt()` throws "Called interrupt()
 * outside the context of a graph" and the entire human-in-the-loop path dies.
 *
 * Under Node the initialisation happens as a side effect of loading
 * `@langchain/core/context`. Bundled for workerd that module is never reached,
 * so the fallback silently stays in place. The failure is invisible until a
 * graph actually interrupts: every other path — tool loop, cost gate,
 * autonomous execution — works fine without it, which is exactly what made this
 * present as "only approvals are broken, and only in production".
 *
 * `initializeGlobalInstance` is a no-op when an instance already exists, so
 * importing this on Node changes nothing.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons";

AsyncLocalStorageProviderSingleton.initializeGlobalInstance(
  new AsyncLocalStorage(),
);
