"use client";

import { humanMinutes, usd, usd0 } from "./format";
import type { ApprovalPayload } from "./types";

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
  const penalty = payload.slaPenaltyUsd ?? 0;
  const savings = penalty - breakdown.totalUsd;

  return (
    <section className="rounded-xl border border-warn/50 bg-panel shadow-[0_0_0_1px_rgba(255,180,84,0.08),0_18px_40px_-24px_rgba(0,0,0,0.9)]">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-5 py-3.5">
        <span className="live-dot h-2 w-2 rounded-full bg-warn" />
        <h2 className="text-sm font-semibold tracking-wide text-warn">
          Needs your approval
        </h2>
        <span className="ml-auto text-xs text-muted">
          Load {payload.loadId.replace(/^LOAD-/, "")}
          {payload.customer ? ` · ${payload.customer}` : ""}
        </span>
      </header>

      <div className="space-y-4 px-5 py-4">
        {/*
         * The comparison, first and largest. Without it the card asks someone to
         * approve a four-figure spend against no context, which is the single
         * thing that made the demo hard to read.
         */}
        {penalty > 0 && (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-line bg-panel-2 px-4 py-3">
              <div className="text-xs text-muted">Cost of this fix</div>
              <div className="mt-1 text-2xl font-semibold text-warn">
                {usd(breakdown.totalUsd)}
              </div>
            </div>
            <div className="rounded-lg border border-danger/30 bg-panel-2 px-4 py-3">
              <div className="text-xs text-muted">
                Cost of delivering this late
              </div>
              <div className="mt-1 text-2xl font-semibold text-danger">
                {usd0(penalty)}
              </div>
            </div>
          </div>
        )}

        <p className="text-sm leading-relaxed text-text">
          {penalty > 0 ? (
            <>
              Spending <strong>{usd(breakdown.totalUsd)}</strong> now avoids a{" "}
              <strong>{usd0(penalty)}</strong> late-delivery penalty
              {payload.customer ? ` for ${payload.customer}` : ""} — a net{" "}
              <strong className="text-ok">{usd0(savings)}</strong> saved.{" "}
            </>
          ) : (
            <>This fix costs {usd(breakdown.totalUsd)}. </>
          )}
          It is over the {usd0(payload.thresholdUsd)} limit the assistant is
          allowed to spend on its own, so it stopped and is waiting for your
          decision. Nothing has been changed yet.
        </p>

        <div className="rounded-lg border border-line bg-panel-2 px-4 py-3 text-sm leading-relaxed text-text">
          The assistant wants to hand this load to{" "}
          <strong className="text-warn">{payload.resourceName}</strong>
          {payload.resourceKind === "THIRD_PARTY_CARRIER"
            ? ", an outside carrier"
            : ", one of your own drivers"}
          .
          {payload.cargo && (
            <div className="mt-1.5 text-xs text-muted">
              Cargo: {payload.cargo}
              {payload.minutesUntilSlaDeadline !== undefined &&
                ` · due in ${humanMinutes(payload.minutesUntilSlaDeadline)}`}
            </div>
          )}
        </div>

        {payload.justification && (
          <div>
            <div className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted">
              Why it picked this option
            </div>
            <blockquote className="border-l-2 border-line pl-3 text-sm italic leading-relaxed text-muted">
              {payload.justification}
            </blockquote>
          </div>
        )}

        <div>
          <div className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted">
            How the {usd(breakdown.totalUsd)} breaks down
          </div>
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
          <p className="mt-1.5 text-xs text-muted">
            These figures are worked out by the system, not written by the AI.
          </p>
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
            Reject — find something cheaper
          </button>
        </div>
      </div>
    </section>
  );
}
