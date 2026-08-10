"use client";

import { useEffect, useMemo, useRef } from "react";

import { usd, usd0 } from "./format";
import { Markdown } from "./Markdown";
import type { LogEvent } from "./types";

/**
 * Plain-language name for every tool the agent can call. The raw tool name and
 * its JSON are still available, but only behind the "technical detail" switch —
 * a visitor watching the demo needs to know *that* it checked the driver's legal
 * hours, not the shape of the arguments it passed.
 */
const TOOL_LABEL: Record<string, string> = {
  get_load_manifest: "Read the shipment file",
  query_nearby_drivers: "Searched for nearby drivers",
  check_driver_hos: "Checked a driver's legal hours",
  query_backup_carriers: "Looked up outside carriers",
  calculate_reroute_cost: "Priced an option",
  execute_reroute: "Chose a fix",
};

interface Lookup {
  name: string;
  args: unknown;
  result?: unknown;
}

type Step =
  | { kind: "lookups"; lookups: Lookup[] }
  | { kind: "say"; text: string }
  | {
      kind: "gate";
      decision: "AUTONOMOUS" | "APPROVAL_REQUIRED" | "INFEASIBLE";
      totalUsd: number;
      thresholdUsd: number;
      reason?: string;
    }
  | { kind: "paused"; resolved: boolean }
  | { kind: "decision"; approved: boolean }
  | { kind: "executed"; detail: Record<string, unknown> }
  | { kind: "summary"; text: string }
  | { kind: "error"; message: string }
  | { kind: "resumeFailed"; message: string }
  | { kind: "handover"; message: string };

/**
 * Folds the raw event stream into a short human narrative.
 *
 * Two things do the work: consecutive tool calls collapse into one "looked
 * things up" step instead of two rows each, and the bookkeeping events
 * (`run_started`, `tms_snapshot`, `done`) are dropped — the console frame around
 * this list already says all three.
 */
function buildSteps(events: LogEvent[]): Step[] {
  const steps: Step[] = [];

  for (const e of events) {
    const tail = steps[steps.length - 1];

    switch (e.type) {
      case "tool_call": {
        const call = { name: e.name, args: e.args };
        if (tail?.kind === "lookups") tail.lookups.push(call);
        else steps.push({ kind: "lookups", lookups: [call] });
        break;
      }

      case "tool_result": {
        // Pair the result with its call so the detail view can show both.
        for (let i = steps.length - 1; i >= 0; i--) {
          const step = steps[i];
          if (step.kind !== "lookups") continue;
          const slot = step.lookups.find(
            (l) => l.name === e.name && l.result === undefined,
          );
          if (slot) {
            slot.result = e.result;
            break;
          }
        }
        break;
      }

      case "agent_message":
        steps.push({ kind: "say", text: e.text });
        break;

      case "cost_gate":
        steps.push({
          kind: "gate",
          decision: e.decision,
          totalUsd: e.costed?.totalUsd ?? 0,
          thresholdUsd: e.thresholdUsd,
          reason: e.costed?.infeasibleReason,
        });
        break;

      case "approval_required":
        steps.push({ kind: "paused", resolved: false });
        break;

      case "decision": {
        // The pause it answers is no longer pending, so stop describing it in
        // the present tense — a timeline that still says "waiting for you"
        // after you have answered reads as though the click did nothing.
        for (let i = steps.length - 1; i >= 0; i--) {
          const step = steps[i];
          if (step.kind === "paused") {
            step.resolved = true;
            break;
          }
        }
        steps.push({ kind: "decision", approved: e.approved });
        break;
      }

      case "resume_failed":
        steps.push({ kind: "resumeFailed", message: e.message });
        break;

      case "handover":
        steps.push({ kind: "handover", message: e.message });
        break;

      case "executed":
        steps.push({ kind: "executed", detail: e.detail });
        break;

      case "summary":
        steps.push({ kind: "summary", text: e.text });
        break;

      case "error":
        steps.push({ kind: "error", message: e.message });
        break;

      default:
        break;
    }
  }

  return steps;
}

function dotClass(step: Step): string {
  switch (step.kind) {
    case "lookups":
      return "bg-line";
    case "say":
      return "bg-accent/70";
    case "gate":
      return step.decision === "AUTONOMOUS" ? "bg-ok" : "bg-warn";
    case "paused":
      return step.resolved ? "bg-line" : "bg-warn";
    case "decision":
      return step.approved ? "bg-ok" : "bg-danger";
    case "executed":
    case "summary":
      return "bg-ok";
    case "error":
    case "resumeFailed":
      return "bg-danger";
    case "handover":
      return "bg-warn";
  }
}

function Json({ value }: { value: unknown }) {
  return (
    <pre className="mt-1.5 max-h-48 overflow-auto rounded-md border border-line bg-ink/60 p-2 font-mono text-[11px] leading-relaxed text-muted">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

export function AgentLog({
  events,
  running,
  detail,
}: {
  events: LogEvent[];
  running: boolean;
  detail: boolean;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  const steps = useMemo(() => {
    const built = buildSteps(events);
    // The write confirmation and the closing summary say the same thing, and the
    // verdict banner under the timeline says it a third time. Only the summary
    // earns its place here; the raw write is technical detail.
    return detail ? built : built.filter((s) => s.kind !== "executed");
  }, [events, detail]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [steps.length]);

  if (steps.length === 0 && !running) {
    return (
      <p className="px-5 py-8 text-center text-sm text-muted">
        Waiting for the first step…
      </p>
    );
  }

  return (
    <ol className="px-5 py-4">
      {steps.map((step, i) => (
        <li key={i} className="relative pb-4 pl-7 last:pb-0">
          <span
            className={`absolute left-1 top-[7px] h-2 w-2 rounded-full ${dotClass(step)}`}
          />
          {i < steps.length - 1 && (
            <span className="absolute bottom-0 left-[7px] top-4 w-px bg-line" />
          )}
          <StepBody step={step} detail={detail} />
        </li>
      ))}

      {running && (
        <li className="relative pl-7 text-sm text-muted">
          <span className="live-dot absolute left-1 top-[7px] h-2 w-2 rounded-full bg-accent" />
          Working…
        </li>
      )}
      <div ref={endRef} />
    </ol>
  );
}

function StepBody({ step, detail }: { step: Step; detail: boolean }) {
  switch (step.kind) {
    case "lookups":
      return (
        <div className="text-sm text-muted">
          {step.lookups.map((l, i) => (
            <div key={i} className={i > 0 ? "mt-1" : undefined}>
              {detail ? (
                <details>
                  <summary className="cursor-pointer select-none hover:text-text">
                    {TOOL_LABEL[l.name] ?? l.name}{" "}
                    <span className="font-mono text-[11px] text-muted/70">
                      {l.name}
                    </span>
                  </summary>
                  <Json value={{ arguments: l.args, returned: l.result }} />
                </details>
              ) : (
                (TOOL_LABEL[l.name] ?? l.name)
              )}
            </div>
          ))}
        </div>
      );

    case "say":
      return <Markdown>{step.text}</Markdown>;

    case "gate": {
      if (step.decision === "INFEASIBLE") {
        return (
          <div className="text-sm leading-relaxed text-text">
            <strong className="text-danger">Rejected by the system.</strong>{" "}
            {step.reason ?? "That option cannot take this load."} The assistant
            has to pick something else.
          </div>
        );
      }

      const needsApproval = step.decision === "APPROVAL_REQUIRED";
      return (
        <div
          className={`rounded-lg border px-3 py-2.5 ${
            needsApproval
              ? "border-warn/40 bg-warn/5"
              : "border-ok/40 bg-ok/5"
          }`}
        >
          <div className="text-sm text-text">
            This fix costs <strong>{usd(step.totalUsd)}</strong>. The limit is{" "}
            {usd0(step.thresholdUsd)}.
          </div>
          <div
            className={`mt-1 text-xs font-medium ${needsApproval ? "text-warn" : "text-ok"}`}
          >
            {needsApproval
              ? "Over the limit — a person has to approve it."
              : "Under the limit — the assistant can do this itself."}
          </div>
        </div>
      );
    }

    case "paused":
      return step.resolved ? (
        <p className="text-sm leading-relaxed text-muted">
          Stopped and asked you. Nothing had been changed at this point.
        </p>
      ) : (
        <p className="text-sm leading-relaxed text-warn">
          Stopped and waiting for you. Nothing has been changed yet.
        </p>
      );

    case "decision":
      return step.approved ? (
        <p className="text-sm leading-relaxed text-text">
          <strong className="text-ok">You approved it.</strong> Going ahead.
        </p>
      ) : (
        <p className="text-sm leading-relaxed text-text">
          <strong className="text-danger">You turned it down.</strong> Nothing
          was changed. The assistant has to look for something cheaper, or
          explain that there isn&apos;t one.
        </p>
      );

    case "handover":
      return (
        <div className="rounded-lg border border-warn/40 bg-warn/5 px-3 py-2.5">
          <p className="text-sm font-semibold text-warn">
            Handed back to you.
          </p>
          <p className="mt-1 text-sm leading-relaxed text-muted">
            {step.message}
          </p>
        </div>
      );

    case "resumeFailed":
      return (
        <div className="rounded-lg border border-danger/40 bg-danger/5 px-3 py-2.5">
          <p className="text-sm font-semibold text-danger">
            Your decision was not applied.
          </p>
          <p className="mt-1 text-sm leading-relaxed text-muted">
            {step.message}
          </p>
        </div>
      );

    case "executed": {
      const byHuman = String(step.detail.approved_by) === "HUMAN_DISPATCHER";
      return (
        <div className="text-sm leading-relaxed text-text">
          <strong className="text-ok">Done.</strong>{" "}
          <span className="font-mono text-xs">
            {String(step.detail.load_id)}
          </span>{" "}
          handed to {String(step.detail.assigned_to)} for{" "}
          {usd(Number(step.detail.cost_usd))} —{" "}
          {byHuman ? "you approved it" : "handled automatically"}.
          {detail && <Json value={step.detail} />}
        </div>
      );
    }

    case "summary":
      return <Markdown>{step.text}</Markdown>;

    case "error":
      return <p className="text-sm leading-relaxed text-danger">{step.message}</p>;
  }
}
