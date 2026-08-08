"use client";

import type { ApprovalPayload } from "./types";

const usd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" });

export function ApprovalCard({
  payload,
  busy,
  onDecision,
}: {
  payload: ApprovalPayload;
  busy: boolean;
  onDecision: (approved: boolean) => void;
}) {
  const { breakdown } = payload;

  return (
    <section className="rounded-xl border border-warn/50 bg-panel shadow-[0_0_0_1px_rgba(255,180,84,0.08),0_18px_40px_-24px_rgba(0,0,0,0.9)]">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-5 py-3.5">
        <span className="live-dot h-2 w-2 rounded-full bg-warn" />
        <h2 className="text-sm font-semibold tracking-wide text-warn">
          APPROVAL REQUIRED
        </h2>
        <span className="ml-auto font-mono text-xs text-muted">
          {payload.loadId}
        </span>
      </header>

      <div className="space-y-4 px-5 py-4">
        <p className="text-sm leading-relaxed text-text">
          The agent proposes assigning this load to{" "}
          <strong className="text-warn">{payload.resourceName}</strong>{" "}
          <span className="font-mono text-xs text-muted">
            ({payload.resourceId})
          </span>
          . At {usd(breakdown.totalUsd)} this exceeds the{" "}
          {usd(payload.thresholdUsd)} autonomous ceiling, so execution is held
          pending your decision.
        </p>

        {payload.justification && (
          <blockquote className="border-l-2 border-line pl-3 text-sm italic leading-relaxed text-muted">
            {payload.justification}
          </blockquote>
        )}

        <div className="overflow-hidden rounded-lg border border-line">
          <table className="w-full text-sm">
            <tbody>
              {breakdown.lineItems.map((li) => (
                <tr key={li.label} className="border-b border-line/70">
                  <td className="px-3 py-2 text-text">
                    {li.label}
                    <div className="text-xs text-muted">{li.basis}</div>
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-text align-top">
                    {usd(li.amountUsd)}
                  </td>
                </tr>
              ))}
              <tr className="bg-panel-2">
                <td className="px-3 py-2.5 font-semibold text-text">Total</td>
                <td className="px-3 py-2.5 text-right font-mono font-semibold text-warn">
                  {usd(breakdown.totalUsd)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap gap-3 pt-1">
          <button
            type="button"
            disabled={busy}
            onClick={() => onDecision(true)}
            className="rounded-lg bg-ok px-5 py-2.5 text-sm font-semibold text-ink transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Approve {usd(breakdown.totalUsd)}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onDecision(false)}
            className="rounded-lg border border-danger/60 px-5 py-2.5 text-sm font-semibold text-danger transition hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Reject
          </button>
        </div>
      </div>
    </section>
  );
}
