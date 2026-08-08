"use client";

import type { AuditEntry, Load } from "@/mock/loads";

const usd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" });

const STATUS_TONE: Record<string, string> = {
  IN_TRANSIT: "text-muted",
  DELAYED: "text-warn",
  DISABLED: "text-danger",
  REASSIGNED: "text-ok",
  TENDERED_TO_CARRIER: "text-ok",
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
          Mock TMS — system of record
        </h2>
      </header>

      <div className="divide-y divide-line/60">
        {loads.map((load) => (
          <div key={load.loadId} className="px-4 py-3">
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-mono text-sm text-text">{load.loadId}</span>
              <span
                className={`font-mono text-[11px] ${STATUS_TONE[load.status] ?? "text-muted"}`}
              >
                {load.status}
              </span>
            </div>
            <div className="mt-1 text-xs text-muted">
              {load.origin} → {load.destination}
            </div>
            <div className="mt-1 text-xs text-muted">
              assigned{" "}
              <span className="font-mono text-text">{load.assignedDriverId}</span>
              {" · "}SLA in {load.minutesUntilSlaDeadline} min
            </div>
          </div>
        ))}
      </div>

      <div className="border-t border-line px-4 py-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">
          Audit log
        </h3>
        {audit.length === 0 ? (
          <p className="mt-2 text-xs text-muted">
            No mutations. Nothing has been written to the TMS.
          </p>
        ) : (
          <ul className="mt-2 space-y-2">
            {audit.map((entry, i) => (
              <li key={i} className="text-xs leading-relaxed">
                <span className="font-mono text-text">{entry.loadId}</span>{" "}
                <span className="text-muted">{entry.detail}</span>{" "}
                <span className="font-mono text-text">
                  {usd(entry.costUsd)}
                </span>
                <div
                  className={
                    entry.approvedBy === "HUMAN_DISPATCHER"
                      ? "text-warn"
                      : "text-ok"
                  }
                >
                  {entry.approvedBy === "HUMAN_DISPATCHER"
                    ? "authorised by dispatcher"
                    : "executed autonomously"}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
