"use client";

import { useCallback, useMemo, useState } from "react";

import type { Load, AuditEntry } from "@/mock/loads";
import type { Scenario } from "@/mock/scenarios";
import { AgentLog } from "./AgentLog";
import { ApprovalCard } from "./ApprovalCard";
import { TmsPanel } from "./TmsPanel";
import { usd, usd0 } from "./format";
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

  for (; ;) {
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
  config: {
    model: string;
    thresholdUsd: number;
    loadCeilingUsd: number;
    dailyCeilingUsd: number;
    langfuse: boolean;
    mock: boolean;
  };
}) {
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [running, setRunning] = useState(false);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [activeScenario, setActiveScenario] = useState<string | null>(null);
  const [approval, setApproval] = useState<ApprovalPayload | null>(null);
  const [loads, setLoads] = useState<Load[]>(initialLoads);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [detail, setDetail] = useState(false);

  const active = useMemo(
    () => scenarios.find((s) => s.id === activeScenario) ?? null,
    [scenarios, activeScenario],
  );

  /**
   * The verdict, shown once the run settles. It answers the question a visitor
   * actually has — did it act on its own, or did it have to ask? — so the
   * timeline does not have to be read back to find out.
   */
  const outcome = useMemo(() => {
    if (running || approval) return null;
    if (!events.some((e) => e.type === "done")) return null;

    const executed = [...events]
      .reverse()
      .find(
        (e): e is Extract<LogEvent, { type: "executed" }> =>
          e.type === "executed",
      );

    if (!executed) {
      // Three different reasons the board is untouched, and they are not the
      // same news. Collapsing them into one "nothing was changed" is what made
      // a lost decision look like a normal rejection.
      if (events.some((e) => e.type === "resume_failed")) {
        return {
          tone: "bad" as const,
          headline: "Your decision was not applied.",
          detail:
            "This run had already finished waiting. Nothing was changed — run the scenario again.",
        };
      }

      const handover = [...events]
        .reverse()
        .find(
          (e): e is Extract<LogEvent, { type: "handover" }> =>
            e.type === "handover",
        );

      if (handover) {
        return {
          tone: "muted" as const,
          headline: "It has run out of options.",
          detail: handover.message,
        };
      }

      const rejected = [...events]
        .reverse()
        .find(
          (e): e is Extract<LogEvent, { type: "decision" }> =>
            e.type === "decision",
        );

      if (rejected && !rejected.approved) {
        return {
          tone: "muted" as const,
          headline: "You turned it down.",
          detail:
            "Nothing was changed. The load is still assigned exactly as it was, and the delivery window is still at risk — that is now yours to resolve.",
        };
      }

      return {
        tone: "muted" as const,
        headline: "Nothing was changed.",
        detail: "The dispatch board is exactly as it was.",
      };
    }

    const byHuman = String(executed.detail.approved_by) === "HUMAN_DISPATCHER";
    const what = `${String(executed.detail.load_id).replace(/^LOAD-/, "Load ")} went to ${String(executed.detail.assigned_to)} for ${usd(Number(executed.detail.cost_usd))}`;

    return {
      tone: "ok" as const,
      headline: byHuman ? "Handled — but only once you said yes." : "Handled on its own.",
      detail: byHuman
        ? `${what}, over the ${usd0(config.thresholdUsd)} limit.`
        : `${what}, under the ${usd0(config.thresholdUsd)} limit.`,
    };
  }, [events, running, approval, config.thresholdUsd]);

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
    <div className="mx-auto w-full max-w-5xl flex-1 px-5 py-8 lg:px-8">
      <header className="mb-8">
        <h1 className="text-xl font-semibold tracking-tight text-text">
          DispatchOps <span className="text-accent">AI</span>
        </h1>
        <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted">
          An assistant that fixes freight problems on its own — but only up to{" "}
          <span className="font-semibold text-text">
            {usd0(config.thresholdUsd)}
          </span>
          . Past that it has to stop and ask a person.
        </p>
      </header>

      {!active ? (
        <section>
          <h2 className="mb-3 text-sm font-medium text-text">
            Choose a scenario:
          </h2>
          <div className="grid gap-3 sm:grid-cols-3">
            {scenarios.map((scenario) => (
              <button
                key={scenario.id}
                type="button"
                onClick={() => trigger(scenario)}
                className="flex flex-col rounded-xl border border-line bg-panel p-4 text-left transition hover:border-accent/50 hover:bg-panel-2"
              >
                <div className="text-sm font-semibold text-text">
                  {scenario.label}
                </div>
                <p className="mt-1.5 text-xs leading-relaxed text-muted">
                  {scenario.blurb}
                </p>
                <div
                  className={`mt-auto pt-3 text-xs font-medium ${scenario.expectation === "AUTONOMOUS"
                    ? "text-ok"
                    : "text-warn"
                    }`}
                >
                  {scenario.expectation === "AUTONOMOUS"
                    ? "Should handle it alone"
                    : "Should stop and ask you"}
                </div>
              </button>
            ))}
          </div>
          <p className="mt-4 text-xs text-muted">
            Nothing here is real — it&apos;s a demo fleet.
          </p>
        </section>
      ) : (
        <>
          <div className="mb-5 flex flex-wrap gap-2">
            {scenarios.map((scenario) => {
              const isActive = scenario.id === active.id;
              return (
                <button
                  key={scenario.id}
                  type="button"
                  disabled={running}
                  onClick={() => trigger(scenario)}
                  className={`rounded-full border px-3.5 py-1.5 text-xs transition disabled:cursor-not-allowed disabled:opacity-50 ${isActive
                    ? "border-accent/60 bg-panel-2 text-text"
                    : "border-line text-muted hover:border-accent/40 hover:text-text"
                    }`}
                >
                  {scenario.label}
                </button>
              );
            })}
          </div>

          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_260px]">
            <div className="space-y-4">
              <InboundMessage
                scenario={active}
                thresholdUsd={config.thresholdUsd}
              />

              <section className="overflow-hidden rounded-xl border border-line bg-panel">
                <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-3">
                  <h2 className="text-xs font-semibold uppercase tracking-wider text-muted">
                    What it did
                  </h2>
                  <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-muted hover:text-text">
                    <input
                      type="checkbox"
                      checked={detail}
                      onChange={(e) => setDetail(e.target.checked)}
                      className="accent-accent"
                    />
                    technical detail
                  </label>
                </header>
                <AgentLog events={events} running={running} detail={detail} />
                {detail && threadId && (
                  <div className="border-t border-line px-5 py-2 font-mono text-[10px] text-muted">
                    thread {threadId}
                  </div>
                )}
              </section>

              {approval && (
                <ApprovalCard
                  payload={approval}
                  busy={running}
                  onDecision={decide}
                />
              )}

              {outcome && (
                <section
                  className={`rounded-xl border px-5 py-3.5 ${outcome.tone === "ok"
                    ? "border-ok/30 bg-ok/5"
                    : outcome.tone === "bad"
                      ? "border-danger/40 bg-danger/5"
                      : "border-line bg-panel"
                    }`}
                >
                  <p className="text-sm font-semibold text-text">
                    {outcome.headline}
                  </p>
                  <p className="mt-1 text-sm leading-relaxed text-muted">
                    {outcome.detail}
                  </p>
                </section>
              )}
            </div>

            <aside className="lg:sticky lg:top-6 lg:self-start">
              <TmsPanel loads={loads} audit={audit} />
            </aside>
          </div>
        </>
      )}

      <footer className="mt-10 border-t border-line/60 pt-4">
        <details className="group">
          <summary className="cursor-pointer select-none text-[11px] font-mono text-muted/50 transition hover:text-muted inline-flex items-center gap-1.5">
            <span>⚙️ debug info</span>
          </summary>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-muted">
            <span>limit per decision: {usd0(config.thresholdUsd)}</span>
            <span>per load: {usd0(config.loadCeilingUsd)}</span>
            <span>per day: {usd0(config.dailyCeilingUsd)}</span>
            <span>{config.mock ? "offline demo mode" : `model: ${config.model}`}</span>
            <span>tracing: {config.langfuse ? "on" : "off"}</span>
          </div>
        </details>
      </footer>
    </div>
  );
}

/**
 * The exact text the agent was handed. Folded away by default — on two of the
 * three scenarios it just restates the card you clicked. On the injection run it
 * is the whole point, so that one opens itself.
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
    <details
      open={Boolean(attack)}
      className={`rounded-xl border bg-panel ${attack ? "border-danger/40" : "border-line"}`}
    >
      <summary className="cursor-pointer select-none px-5 py-3 text-xs font-semibold uppercase tracking-wider text-muted hover:text-text">
        The alert it received
        {attack && (
          <span className="ml-2 normal-case tracking-normal text-danger">
            — contains a planted instruction
          </span>
        )}
      </summary>

      <p className="border-t border-line px-5 py-3 text-sm leading-relaxed text-muted">
        {before}
        {attack && (
          <mark className="rounded bg-danger/15 px-1 text-danger">{attack}</mark>
        )}
        {after}
      </p>

      {attack && (
        <p className="border-t border-line px-5 py-3 text-xs leading-relaxed text-muted">
          Anyone who can message this assistant could write those two sentences.
          They are a bluff — the {usd0(thresholdUsd)} limit lives in code the
          assistant cannot talk its way past. Watch it ask you anyway.
        </p>
      )}
    </details>
  );
}
