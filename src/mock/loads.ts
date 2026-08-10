/**
 * Mock TMS load table — the system of record the agent is allowed to mutate.
 *
 * This module holds the only mutable state in the POC. `reassignLoad` and
 * `tenderLoad` are the write paths; both are reachable ONLY through the
 * graph's execute node, never directly from the model. See src/agent/graph.ts.
 */

import {
  describeEscalation,
  evaluateAutonomy,
  type AutonomyDecision,
  type SpendLedger,
} from "@/spend-policy";
import type { GeoPoint } from "./fleet";

export type LoadStatus =
  | "IN_TRANSIT"
  | "DELAYED"
  | "DISABLED"
  | "REASSIGNED"
  | "TENDERED_TO_CARRIER";

export interface Load {
  loadId: string;
  customer: string;
  origin: string;
  destination: string;
  destinationPosition: GeoPoint;
  cargo: string;
  cargoValueUsd: number;
  /** Contractual penalty if the delivery window is missed. */
  slaPenaltyUsd: number;
  /** Minutes left before the SLA delivery window closes. */
  minutesUntilSlaDeadline: number;
  currentPosition: GeoPoint;
  currentCity: string;
  /** State the load is sitting in — carriers only serve their licensed regions. */
  currentStateCode: string;
  /** Road miles still to run to the delivery point. */
  remainingRoadMiles: number;
  /** Legal driving minutes still required to complete the delivery. */
  remainingDriveMinutes: number;
  assignedDriverId: string;
  status: LoadStatus;
  /** Free-text notes from the driver or telematics unit. Untrusted input. */
  dispatchNotes: string;
}

export interface AuditEntry {
  loadId: string;
  action: "REASSIGN" | "TENDER";
  detail: string;
  costUsd: number;
  approvedBy: "AGENT_AUTONOMOUS" | "HUMAN_DISPATCHER";
}

const SEED_LOADS: Load[] = [
  {
    loadId: "LOAD-4471",
    customer: "Meridian Pharma Distribution",
    origin: "Long Beach, CA",
    destination: "Phoenix, AZ",
    destinationPosition: { lat: 33.4484, lon: -112.074 },
    cargo: "Refrigerated vaccine consignment, 12 pallets",
    cargoValueUsd: 410_000,
    slaPenaltyUsd: 18_000,
    minutesUntilSlaDeadline: 300,
    currentPosition: { lat: 33.7206, lon: -116.2156 },
    currentCity: "Indio, CA",
    currentStateCode: "CA",
    remainingRoadMiles: 252,
    remainingDriveMinutes: 260,
    assignedDriverId: "DRV-204",
    status: "DELAYED",
    dispatchNotes:
      "I-10 eastbound closed at Chiriaco Summit following a multi-vehicle incident. " +
      "Held 95 minutes. Reefer holding at 4C, fuel adequate.",
  },
  {
    loadId: "LOAD-4472",
    customer: "Northstar Electronics",
    origin: "Stockton, CA",
    destination: "Salt Lake City, UT",
    destinationPosition: { lat: 40.7608, lon: -111.891 },
    cargo: "High-value consumer electronics, 22 pallets",
    cargoValueUsd: 780_000,
    slaPenaltyUsd: 42_000,
    minutesUntilSlaDeadline: 265,
    currentPosition: { lat: 40.8324, lon: -115.7631 },
    currentCity: "Elko, NV",
    currentStateCode: "NV",
    remainingRoadMiles: 230,
    remainingDriveMinutes: 220,
    assignedDriverId: "DRV-231",
    status: "DISABLED",
    dispatchNotes:
      "Tractor 1142 catastrophic turbo failure on I-80 near Elko. Unit is not " +
      "driveable and requires recovery. Trailer and cargo intact and sealed.",
  },
];

/** Live mutable table. Cloned from seed so `resetTms()` can restore it. */
let loads: Load[] = structuredClone(SEED_LOADS);
let auditLog: AuditEntry[] = [];

/** Restores the mock TMS to its seed state. Called at the start of each demo run. */
export function resetTms(): void {
  loads = structuredClone(SEED_LOADS);
  auditLog = [];
}

/**
 * Whole-table snapshot, for hosts that cannot rely on this module's memory
 * surviving between requests. On Cloudflare Workers the graph runs inside a
 * Durable Object which persists this blob to storage; see
 * `src/server/dispatch-room.ts`.
 */
export interface TmsSnapshot {
  loads: Load[];
  auditLog: AuditEntry[];
}

export function snapshotTms(): TmsSnapshot {
  return { loads: structuredClone(loads), auditLog: structuredClone(auditLog) };
}

export function restoreTms(snapshot: TmsSnapshot): void {
  loads = structuredClone(snapshot.loads);
  auditLog = structuredClone(snapshot.auditLog);
}

/** Returns a defensive copy — callers cannot mutate the table by accident. */
export function getLoad(loadId: string): Load | undefined {
  const load = loads.find((l) => l.loadId === loadId);
  return load ? structuredClone(load) : undefined;
}

export function listLoads(): Load[] {
  return structuredClone(loads);
}

export function getAuditLog(): AuditEntry[] {
  return structuredClone(auditLog);
}

/**
 * What has already been committed, read straight off the audit log.
 *
 * The ledger is derived rather than stored on purpose. A separate running total
 * is a second source of truth that can drift from the entries it summarises —
 * and for a spend control, drifting low is a silent hole.
 */
export function spendLedger(loadId: string): SpendLedger {
  let loadUsd = 0;
  let dailyUsd = 0;
  for (const entry of auditLog) {
    dailyUsd += entry.costUsd;
    if (entry.loadId === loadId) loadUsd += entry.costUsd;
  }
  return {
    loadUsd: Math.round(loadUsd * 100) / 100,
    dailyUsd: Math.round(dailyUsd * 100) / 100,
  };
}

/** Thrown when an autonomous commit would breach a spend ceiling. */
export class SpendCapExceededError extends Error {
  constructor(readonly decision: AutonomyDecision) {
    super(`Refused: ${describeEscalation(decision)}`);
    this.name = "SpendCapExceededError";
  }
}

/**
 * The backstop. The graph's cost gate decides the *route*; this decides whether
 * the write actually lands, so a commit cannot get past a ceiling even if the
 * routing is wrong. Read-check-write happens here in one synchronous step,
 * against the same log the commit appends to, so two runs cannot both pass a
 * check and then both commit.
 *
 * A human-approved action is exempt by design. The ceilings bound what the
 * agent may spend *unsupervised*; approval is the audited way past them, and
 * an approved recovery is expected to sit above the line — that is the whole
 * reason a dispatcher was asked.
 */
function assertCommitAllowed(
  loadId: string,
  costUsd: number,
  approvedBy: AuditEntry["approvedBy"],
): void {
  if (approvedBy === "HUMAN_DISPATCHER") return;

  const decision = evaluateAutonomy(costUsd, spendLedger(loadId));
  if (decision.requiresApproval) throw new SpendCapExceededError(decision);
}

/** Write path: hand the load to a different company driver. */
export function reassignLoad(
  loadId: string,
  driverId: string,
  costUsd: number,
  approvedBy: AuditEntry["approvedBy"],
): Load {
  const load = loads.find((l) => l.loadId === loadId);
  if (!load) throw new Error(`Unknown load ${loadId}`);
  assertCommitAllowed(loadId, costUsd, approvedBy);

  load.assignedDriverId = driverId;
  load.status = "REASSIGNED";
  auditLog.push({
    loadId,
    action: "REASSIGN",
    detail: `Reassigned to ${driverId}`,
    costUsd,
    approvedBy,
  });
  return structuredClone(load);
}

/** Write path: tender the load out to a third-party carrier. */
export function tenderLoad(
  loadId: string,
  carrierId: string,
  costUsd: number,
  approvedBy: AuditEntry["approvedBy"],
): Load {
  const load = loads.find((l) => l.loadId === loadId);
  if (!load) throw new Error(`Unknown load ${loadId}`);
  assertCommitAllowed(loadId, costUsd, approvedBy);

  load.assignedDriverId = carrierId;
  load.status = "TENDERED_TO_CARRIER";
  auditLog.push({
    loadId,
    action: "TENDER",
    detail: `Tendered to carrier ${carrierId}`,
    costUsd,
    approvedBy,
  });
  return structuredClone(load);
}
