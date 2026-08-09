"use client";

import { useEffect, useRef } from "react";

import { usd } from "./format";
import type { LogEvent } from "./types";

function Row({
  tag,
  tone,
  children,
}: {
  tag: string;
  tone: "muted" | "accent" | "ok" | "warn" | "danger";
  children: React.ReactNode;
}) {
  const toneClass = {
    muted: "text-muted border-line",
    accent: "text-accent border-accent/40",
    ok: "text-ok border-ok/40",
    warn: "text-warn border-warn/40",
    danger: "text-danger border-danger/40",
  }[tone];

  return (
    <div className="flex gap-3 px-4 py-2.5 border-b border-line/60 last:border-b-0">
      <span
        className={`shrink-0 w-28 font-mono text-[10px] uppercase tracking-wider pt-0.5 ${toneClass.split(" ")[0]}`}
      >
        {tag}
      </span>
      <div className="min-w-0 flex-1 text-sm leading-relaxed">{children}</div>
    </div>
  );
}

function Json({ value }: { value: unknown }) {
  return (
    <pre className="mt-1.5 max-h-56 overflow-auto rounded-md bg-ink/60 border border-line p-2.5 font-mono text-[11px] leading-relaxed text-muted">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

export function AgentLog({
  events,
  running,
}: {
  events: LogEvent[];
  running: boolean;
}) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [events.length]);

  if (events.length === 0) {
    return (
      <div className="flex h-full min-h-64 items-center justify-center px-6 text-center text-sm text-muted">
        Pick a situation above to watch it work, step by step.
      </div>
    );
  }

  return (
    <div className="divide-y divide-line/40">
      {events.map((e, i) => {
        switch (e.type) {
          case "run_started":
            return (
              <Row key={i} tag="exception" tone="warn">
                Telematics exception raised on{" "}
                <span className="font-mono text-text">{e.loadId}</span>. Agent
                engaged.
              </Row>
            );

          case "agent_message":
            return (
              <Row key={i} tag="reasoning" tone="muted">
                <span className="text-text">{e.text}</span>
              </Row>
            );

          case "tool_call":
            return (
              <Row key={i} tag="tool call" tone="accent">
                <span className="font-mono text-accent">{e.name}</span>
                <Json value={e.args} />
              </Row>
            );

          case "tool_result":
            return (
              <Row key={i} tag="tool result" tone="muted">
                <details>
                  <summary className="cursor-pointer select-none font-mono text-xs text-muted hover:text-text">
                    {e.name} returned
                  </summary>
                  <Json value={e.result} />
                </details>
              </Row>
            );

          case "cost_gate": {
            if (e.decision === "INFEASIBLE") {
              return (
                <Row key={i} tag="guardrail" tone="danger">
                  <strong className="text-danger">Action refused.</strong>{" "}
                  {e.costed?.infeasibleReason ??
                    "The proposed resource cannot take this load."}{" "}
                  The agent must choose again.
                </Row>
              );
            }
            const approval = e.decision === "APPROVAL_REQUIRED";
            return (
              <Row key={i} tag="cost gate" tone={approval ? "warn" : "ok"}>
                Priced at{" "}
                <strong className="text-text">
                  {usd(e.costed?.totalUsd ?? 0)}
                </strong>{" "}
                against a {usd(e.thresholdUsd)} ceiling —{" "}
                {approval ? (
                  <span className="text-warn">human approval required</span>
                ) : (
                  <span className="text-ok">cleared for autonomous execution</span>
                )}
                .
              </Row>
            );
          }

          case "approval_required":
            return (
              <Row key={i} tag="halted" tone="warn">
                Run paused at{" "}
                <span className="font-mono">PENDING_HUMAN_APPROVAL</span>. The
                TMS has not been modified.
              </Row>
            );

          case "executed":
            return (
              <Row key={i} tag="tms write" tone="ok">
                <strong className="text-ok">Committed.</strong>{" "}
                <span className="font-mono text-xs">
                  {String(e.detail.load_id)} → {String(e.detail.assigned_to)}
                </span>{" "}
                at {usd(Number(e.detail.cost_usd))}, authorised by{" "}
                {String(e.detail.approved_by) === "HUMAN_DISPATCHER"
                  ? "a human dispatcher"
                  : "the agent"}
                .
                <Json value={e.detail} />
              </Row>
            );

          case "summary":
            return (
              <Row key={i} tag="handover" tone="ok">
                <span className="text-text">{e.text}</span>
              </Row>
            );

          case "done":
            return (
              <Row key={i} tag="run status" tone="muted">
                <span className="font-mono text-xs">{e.status}</span>
              </Row>
            );

          case "error":
            return (
              <Row key={i} tag="error" tone="danger">
                {e.message}
              </Row>
            );

          default:
            return null;
        }
      })}

      {running && (
        <div className="flex items-center gap-2 px-4 py-3 text-xs text-muted">
          <span className="live-dot inline-block h-1.5 w-1.5 rounded-full bg-accent" />
          agent working…
        </div>
      )}
      <div ref={endRef} />
    </div>
  );
}
