"use client";

import type { AuditEntry, Load } from "@/mock/loads";

import { usd0 } from "./format";

/** Status codes are the system's words; these are the ones people use. */
const STATUS: Record<string, { label: string; tone: string }> = {
  IN_TRANSIT: { label: "on the road", tone: "text-muted" },
  DELAYED: { label: "running late", tone: "text-warn" },
  DISABLED: { label: "broken down", tone: "text-danger" },
  REASSIGNED: { label: "reassigned", tone: "text-ok" },
  TENDERED_TO_CARRIER: { label: "given to a carrier", tone: "text-ok" },
};

export function TmsPanel({
  loads,
  audit,
}: {
  loads: Load[];
  audit: AuditEntry[];
}) {
  return (
    <section className="rounded-xl border border-line bg-panel">
      <header className="border-b border-line px-4 py-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted">
          The dispatch board
        </h2>
      </header>

      <div className="divide-y divide-line/60">
        {loads.map((load) => {
          const status = STATUS[load.status] ?? {
            label: load.status,
            tone: "text-muted",
          };
          return (
            <div
              key={load.loadId}
              className="flex items-baseline justify-between gap-3 px-4 py-2.5"
            >
              <div className="min-w-0">
                <div className="font-mono text-xs text-text">
                  {load.loadId.replace(/^LOAD-/, "Load ")}
                </div>
                <div className="text-xs text-muted">
                  {load.origin} → {load.destination}
                </div>
              </div>
              <span className={`shrink-0 text-[11px] ${status.tone}`}>
                {status.label}
              </span>
            </div>
          );
        })}
      </div>

      <div className="border-t border-line px-4 py-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">
          Changes made
        </h3>
        {audit.length === 0 ? (
          <p className="mt-2 text-xs leading-relaxed text-muted">
            None. Nothing on this board has been touched.
          </p>
        ) : (
          <ul className="mt-2 space-y-2.5">
            {audit.map((entry, i) => (
              <li key={i} className="text-xs leading-relaxed text-muted">
                <span className="font-mono text-text">
                  {entry.loadId.replace(/^LOAD-/, "Load ")}
                </span>{" "}
                {entry.detail}{" "}
                <span className="text-text">{usd0(entry.costUsd)}</span>
                <div
                  className={
                    entry.approvedBy === "HUMAN_DISPATCHER"
                      ? "text-warn"
                      : "text-ok"
                  }
                >
                  {entry.approvedBy === "HUMAN_DISPATCHER"
                    ? "you approved this"
                    : "done automatically"}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
