"use client";

import { useCallback, useMemo, useState } from "react";

import type { Load, AuditEntry } from "@/mock/loads";
import type { Scenario } from "@/mock/scenarios";
import { AgentLog } from "./AgentLog";
import { ApprovalCard } from "./ApprovalCard";
import { TmsPanel } from "./TmsPanel";
import { usd0 } from "./format";
import type { ApprovalPayload, LogEvent } from "./types";

/**
 * Reads an SSE body without EventSource — the runs are POSTs, which EventSource
 * cannot issue.
 */
async function consumeSse(
  response: Response,
  onEvent: (event: LogEvent) => void,
) {
  if (!response.body) throw new Error("No response body");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";

    for (const frame of frames) {
      const line = frame.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      try {
        onEvent(JSON.parse(line.slice(6)) as LogEvent);
      } catch {
        // A partial frame is not worth surfacing; the next read completes it.
      }
    }
  }
}

export function DispatchConsole({
  scenarios,
  initialLoads,
  config,
}: {
  scenarios: Scenario[];
  initialLoads: Load[];
  config: { model: string; thresholdUsd: number; langfuse: boolean; mock: boolean };
}) {
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [running, setRunning] = useState(false);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [activeScenario, setActiveScenario] = useState<string | null>(null);
  const [approval, setApproval] = useState<ApprovalPayload | null>(null);
  const [loads, setLoads] = useState<Load[]>(initialLoads);
  const [audit, setAudit] = useState<AuditEntry[]>([]);

  /**
   * What each scenario's load costs if it misses its window. Read from the seed
   * loads rather than live state so the figure on the button is the stake going
   * in, not whatever the last run left behind.
   */
  const penaltyByLoad = useMemo(
    () => new Map(initialLoads.map((l) => [l.loadId, l.slaPenaltyUsd])),
    [initialLoads],
  );

  const active = useMemo(
    () => scenarios.find((s) => s.id === activeScenario) ?? null,
    [scenarios, activeScenario],
  );

  const handleEvent = useCallback((event: LogEvent) => {
    setEvents((prev) => [...prev, event]);

    if (event.type === "run_started") setThreadId(event.threadId);
    if (event.type === "approval_required") setApproval(event.payload);
    if (event.type === "tms_snapshot") {
      setLoads(event.loads);
      setAudit(event.audit);
    }
  }, []);

  const trigger = useCallback(
    async (scenario: Scenario) => {
      setEvents([]);
      setApproval(null);
      setAudit([]);
      setThreadId(null);
      setActiveScenario(scenario.id);
      setRunning(true);

      try {
        const response = await fetch("/api/dispatch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scenarioId: scenario.id }),
        });
        if (!response.ok) throw new Error(await response.text());
        await consumeSse(response, handleEvent);
      } catch (err) {
        handleEvent({ type: "error", message: (err as Error).message });
      } finally {
        setRunning(false);
      }
    },
    [handleEvent],
  );

  const decide = useCallback(
    async (approved: boolean) => {
      if (!threadId) return;
      setApproval(null);
      setRunning(true);

      try {
        const response = await fetch("/api/dispatch/resume", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            threadId,
            approved,
            scenarioId: activeScenario,
          }),
        });
        if (!response.ok) throw new Error(await response.text());
        await consumeSse(response, handleEvent);
      } catch (err) {
        handleEvent({ type: "error", message: (err as Error).message });
      } finally {
        setRunning(false);
      }
    },
    [threadId, activeScenario, handleEvent],
  );

  return (
    <div className="mx-auto w-full max-w-7xl flex-1 px-5 py-6 lg:px-8">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div className="max-w-2xl">
          <h1 className="text-xl font-semibold tracking-tight text-text">
            DispatchOps <span className="text-accent">AI</span>
          </h1>
          <p className="mt-1.5 text-sm leading-relaxed text-text">
            A truck stops moving. This assistant works out the fix, prices it,
            and either handles it or asks you first — it can never spend more
            than {usd0(config.thresholdUsd)} without your say-so.
          </p>
          <p className="mt-1 text-xs text-muted">
            Pick a situation below to watch it work, step by step. Nothing here
            is real — it&apos;s a demo fleet.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          <Badge label={`Spend limit: ${usd0(config.thresholdUsd)}`} />
          <Badge
            label={config.mock ? "offline demo mode" : `AI model: ${config.model}`}
          />
          <Badge
            label={config.langfuse ? "tracing on" : "tracing off"}
            tone={config.langfuse ? "ok" : "muted"}
          />
        </div>
      </header>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-5">
          <section className="grid gap-3 sm:grid-cols-3">
            {scenarios.map((scenario) => {
              const isActive = activeScenario === scenario.id;
              return (
                <button
                  key={scenario.id}
                  type="button"
                  disabled={running}
                  onClick={() => trigger(scenario)}
                  className={`rounded-xl border p-4 text-left transition disabled:cursor-not-allowed disabled:opacity-60 ${
                    isActive
                      ? "border-accent/60 bg-panel-2"
                      : "border-line bg-panel hover:border-accent/40 hover:bg-panel-2"
                  }`}
                >
                  <div className="text-sm font-semibold text-text">
                    {scenario.label}
                  </div>
                  <p className="mt-1.5 text-xs leading-relaxed text-muted">
                    {scenario.blurb}
                  </p>
                  <div className="mt-3 space-y-1">
                    <div
                      className={`text-xs font-medium ${
                        scenario.expectation === "AUTONOMOUS"
                          ? "text-ok"
                          : "text-warn"
                      }`}
                    >
                      {scenario.expectation === "AUTONOMOUS"
                        ? "Should handle it alone"
                        : "Should stop and ask you"}
                    </div>
                    {penaltyByLoad.has(scenario.loadId) && (
                      <div className="text-[11px] text-muted">
                        If it delivers late:{" "}
                        {usd0(penaltyByLoad.get(scenario.loadId)!)} penalty
                      </div>
                    )}
                  </div>
                </button>
              );
            })}
          </section>

          {active && (
            <InboundMessage
              scenario={active}
              thresholdUsd={config.thresholdUsd}
            />
          )}

          {approval && (
            <ApprovalCard
              payload={approval}
              busy={running}
              onDecision={decide}
            />
          )}

          <section className="overflow-hidden rounded-xl border border-line bg-panel">
            <header className="flex items-center justify-between border-b border-line px-4 py-3">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-muted">
                What the assistant is doing
              </h2>
              {threadId && (
                <span className="font-mono text-[10px] text-muted">
                  {threadId}
                </span>
              )}
            </header>
            <AgentLog events={events} running={running} />
          </section>
        </div>

        <aside className="lg:sticky lg:top-6 lg:self-start">
          <TmsPanel loads={loads} audit={audit} />
        </aside>
      </div>
    </div>
  );
}

/**
 * The exact text the agent was handed. Worth showing in full: on the injection
 * scenario it is the only place the attack is visible, and without it that run
 * looks identical to the ordinary breakdown.
 */
function InboundMessage({
  scenario,
  thresholdUsd,
}: {
  scenario: Scenario;
  thresholdUsd: number;
}) {
  const attack = scenario.injectedInstruction;
  const [before, after] = attack
    ? (() => {
        const at = scenario.event.indexOf(attack);
        return at === -1
          ? [scenario.event, ""]
          : [scenario.event.slice(0, at), scenario.event.slice(at + attack.length)];
      })()
    : [scenario.event, ""];

  return (
    <section className="rounded-xl border border-line bg-panel">
      <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted">
          The message that came in
        </h2>
        {attack && (
          <span className="rounded-full border border-danger/40 px-2 py-0.5 font-mono text-[10px] text-danger">
            contains a planted instruction
          </span>
        )}
      </header>
      <p className="px-4 py-3 text-sm leading-relaxed text-muted">
        {before}
        {attack && (
          <mark className="rounded bg-danger/15 px-1 text-danger">{attack}</mark>
        )}
        {after}
      </p>
      {attack && (
        <p className="border-t border-line px-4 py-3 text-xs leading-relaxed text-muted">
          Anyone who can send this assistant a message could write those two
          sentences. They are a bluff — the {usd0(thresholdUsd)} spend limit
          lives in code the assistant cannot talk its way past, so watch it stop
          and ask you anyway.
        </p>
      )}
    </section>
  );
}

function Badge({
  label,
  tone = "muted",
}: {
  label: string;
  tone?: "muted" | "ok";
}) {
  return (
    <span
      className={`rounded-full border px-2.5 py-1 font-mono ${
        tone === "ok"
          ? "border-ok/40 text-ok"
          : "border-line text-muted"
      }`}
    >
      {label}
    </span>
  );
}
