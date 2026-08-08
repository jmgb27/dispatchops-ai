/**
 * Deterministic financial impact model — README §4.1 "pre-execution hook".
 *
 * This is the load-bearing part of the guardrail. It is a pure function of the
 * mock TMS state: no clock, no randomness, no model involvement. The LLM never
 * supplies a cost, it only nominates a resource; the number that decides
 * autonomy is computed here.
 */

import {
  FUEL_COST_USD_PER_MILE,
  OVERTIME_MULTIPLIER,
  RELAY_HANDOFF_FEE_USD,
  STANDARD_SHIFT_MINUTES,
  getCarrier,
  getDriver,
  roadMiles,
} from "@/mock/fleet";
import { getLoad } from "@/mock/loads";

/** Recovery of a disabled tractor: heavy tow plus trailer cross-dock. */
export const DISABLED_UNIT_RECOVERY_USD = 340;

export interface CostBreakdown {
  extraFuelUsd: number;
  driverOvertimeUsd: number;
  thirdPartyCarrierUsd: number;
  accessorialUsd: number;
  totalUsd: number;
  /** Human-readable derivation, rendered verbatim on the approval card. */
  lineItems: { label: string; amountUsd: number; basis: string }[];
}

export interface CostedProposal extends CostBreakdown {
  loadId: string;
  /** Driver id or carrier id. */
  resourceId: string;
  resourceKind: "COMPANY_DRIVER" | "THIRD_PARTY_CARRIER";
  resourceName: string;
  /** True when this resource cannot legally or physically take the load. */
  infeasibleReason?: string;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * The autonomy ceiling. Read at call time rather than module load so tests can
 * vary it and so a redeploy picks up a changed env without a rebuild.
 */
export function maxAutonomousSpendUsd(): number {
  const raw = Number(process.env.MAX_AUTONOMOUS_SPEND_USD);
  return Number.isFinite(raw) && raw > 0 ? raw : 500;
}

/**
 * Prices handing `loadId` to `resourceId`, which may be a company driver or a
 * third-party carrier. Throws only on unknown ids — infeasibility is reported
 * in-band via `infeasibleReason` so the agent can reason about it.
 */
export function calculateActionCost(
  loadId: string,
  resourceId: string,
): CostedProposal {
  const load = getLoad(loadId);
  if (!load) throw new Error(`Unknown load ${loadId}`);

  const driver = getDriver(resourceId);
  const carrier = getCarrier(resourceId);
  if (!driver && !carrier) throw new Error(`Unknown resource ${resourceId}`);

  const needsRecovery = load.status === "DISABLED";
  const lineItems: CostBreakdown["lineItems"] = [];

  if (carrier) {
    const linehaul = carrier.spotRateUsdPerMile * load.remainingRoadMiles;
    const thirdPartyCarrierUsd = round2(
      linehaul + carrier.emergencyAcceptanceFeeUsd,
    );
    const accessorialUsd = needsRecovery ? DISABLED_UNIT_RECOVERY_USD : 0;

    lineItems.push({
      label: "Carrier linehaul",
      amountUsd: round2(linehaul),
      basis: `${load.remainingRoadMiles} mi @ $${carrier.spotRateUsdPerMile}/mi spot`,
    });
    lineItems.push({
      label: "Emergency tender acceptance fee",
      amountUsd: carrier.emergencyAcceptanceFeeUsd,
      basis: `${carrier.name} flat fee`,
    });
    if (accessorialUsd > 0) {
      lineItems.push({
        label: "Disabled unit recovery",
        amountUsd: accessorialUsd,
        basis: "Heavy tow + trailer cross-dock",
      });
    }

    return {
      loadId,
      resourceId,
      resourceKind: "THIRD_PARTY_CARRIER",
      resourceName: carrier.name,
      infeasibleReason: carrier.serviceRegions.includes(load.currentStateCode)
        ? undefined
        : `${carrier.name} is not licensed in ${load.currentStateCode} (serves ${carrier.serviceRegions.join(", ")})`,
      extraFuelUsd: 0,
      driverOvertimeUsd: 0,
      thirdPartyCarrierUsd,
      accessorialUsd,
      totalUsd: round2(thirdPartyCarrierUsd + accessorialUsd),
      lineItems,
    };
  }

  // Company driver: deadhead to the stranded load, then run it out.
  const d = driver!;
  const deadheadMiles = round2(roadMiles(d.position, load.currentPosition));
  const extraFuelUsd = round2(deadheadMiles * FUEL_COST_USD_PER_MILE);

  // Deadhead time at a 55 mph average, plus the remaining drive.
  const deadheadMinutes = Math.round((deadheadMiles / 55) * 60);
  const totalOnDutyMinutes =
    d.minutesOnDutyToday + deadheadMinutes + load.remainingDriveMinutes;
  const overtimeMinutes = Math.max(0, totalOnDutyMinutes - STANDARD_SHIFT_MINUTES);
  const driverOvertimeUsd = round2(
    (overtimeMinutes / 60) * d.hourlyRateUsd * OVERTIME_MULTIPLIER,
  );

  const accessorialUsd =
    RELAY_HANDOFF_FEE_USD + (needsRecovery ? DISABLED_UNIT_RECOVERY_USD : 0);

  lineItems.push({
    label: "Deadhead fuel",
    amountUsd: extraFuelUsd,
    basis: `${deadheadMiles} mi @ $${FUEL_COST_USD_PER_MILE}/mi`,
  });
  lineItems.push({
    label: "Driver overtime",
    amountUsd: driverOvertimeUsd,
    basis: `${overtimeMinutes} min over shift @ $${d.hourlyRateUsd}/h x${OVERTIME_MULTIPLIER}`,
  });
  lineItems.push({
    label: "Relay handoff",
    amountUsd: RELAY_HANDOFF_FEE_USD,
    basis: "Yard time, seal break, re-scan",
  });
  if (needsRecovery) {
    lineItems.push({
      label: "Disabled unit recovery",
      amountUsd: DISABLED_UNIT_RECOVERY_USD,
      basis: "Heavy tow + trailer cross-dock",
    });
  }

  // Feasibility: the driver must have the legal hours for deadhead + delivery.
  const minutesNeeded = deadheadMinutes + load.remainingDriveMinutes;
  const infeasibleReason =
    d.status === "BREAKDOWN"
      ? `${d.name}'s tractor is disabled and awaiting recovery`
      : d.status === "OFF_DUTY"
        ? `${d.name} is off duty`
        : d.hosMinutesRemaining < minutesNeeded
          ? `${d.name} has ${d.hosMinutesRemaining} HOS minutes remaining but the run needs ${minutesNeeded}`
          : undefined;

  return {
    loadId,
    resourceId,
    resourceKind: "COMPANY_DRIVER",
    resourceName: d.name,
    extraFuelUsd,
    driverOvertimeUsd,
    thirdPartyCarrierUsd: 0,
    accessorialUsd,
    totalUsd: round2(extraFuelUsd + driverOvertimeUsd + accessorialUsd),
    lineItems,
    infeasibleReason,
  };
}

/** The guardrail decision itself. Structural, not prompted. */
export function requiresHumanApproval(totalUsd: number): boolean {
  return totalUsd >= maxAutonomousSpendUsd();
}
