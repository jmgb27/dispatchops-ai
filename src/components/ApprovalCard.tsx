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
      <header className="flex items-center gap-2.5 border-b border-line px-5 py-3.5">
        <span className="live-dot h-2 w-2 rounded-full bg-warn" />
        <h2 className="text-sm font-semibold tracking-wide text-warn">
          Your decision
        </h2>
      </header>

      <div className="space-y-4 px-5 py-4">
        {/*
         * The trade, first and largest: what the fix costs against what going
         * wrong costs. Without the comparison the card asks someone to approve a
         * four-figure spend with no way to judge it.
         */}
        <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
          <div>
            <div className="text-xs text-muted">Spend now</div>
            <div className="mt-0.5 text-3xl font-semibold text-warn">
              {usd0(breakdown.totalUsd)}
            </div>
          </div>
          {penalty > 0 && (
            <>
              <div className="pb-1.5 text-sm text-muted">to avoid</div>
              <div>
                <div className="text-xs text-muted">A late-delivery penalty</div>
                <div className="mt-0.5 text-3xl font-semibold text-danger">
                  {usd0(penalty)}
                </div>
              </div>
              <div className="pb-1.5 text-sm text-ok">
                Net {usd0(savings)} saved
              </div>
            </>
          )}
        </div>

        <p className="text-sm leading-relaxed text-text">
          Hand load {payload.loadId.replace(/^LOAD-/, "")} to{" "}
          <strong className="text-warn">{payload.resourceName}</strong>
          {payload.resourceKind === "THIRD_PARTY_CARRIER"
            ? ", an outside carrier"
            : ", one of your own drivers"}
          {payload.minutesUntilSlaDeadline !== undefined &&
            ` — due in ${humanMinutes(payload.minutesUntilSlaDeadline)}`}
          . Nothing has been changed yet.
        </p>

        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            disabled={busy}
            onClick={() => onDecision(true)}
            className="rounded-lg bg-ok px-5 py-2.5 text-sm font-semibold text-ink transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Approve {usd0(breakdown.totalUsd)}
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

        {/*
         * Everything a dispatcher would want before signing off, but folded away
         * — on screen at all times it buried the two numbers and the buttons.
         */}
        <details className="border-t border-line pt-3">
          <summary className="cursor-pointer select-none text-xs text-muted hover:text-text">
            Where the {usd(breakdown.totalUsd)} goes, and why it picked this
          </summary>

          <div className="mt-3 space-y-3">
            <div className="overflow-hidden rounded-lg border border-line">
              <table className="w-full text-sm">
                <tbody>
                  {breakdown.lineItems.map((li) => (
                    <tr key={li.label} className="border-b border-line/70">
                      <td className="px-3 py-2 text-text">
                        {li.label}
                        <div className="text-xs text-muted">{li.basis}</div>
                      </td>
                      <td className="px-3 py-2 text-right align-top font-mono text-text">
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
            <p className="text-xs text-muted">
              These figures are worked out by the system, not written by the AI.
            </p>

            {payload.justification && (
              <blockquote className="border-l-2 border-line pl-3 text-sm italic leading-relaxed text-muted">
                {payload.justification}
              </blockquote>
            )}
          </div>
        </details>
      </div>
    </section>
  );
}
