/**
 * The agent's typed tool suite (README §3).
 *
 * Read tools run in the ToolNode. The one WRITE tool — `execute_reroute` — is
 * declared to the model but deliberately has no executable binding here: the
 * graph intercepts that call and routes it through the cost gate first. If you
 * ever add it to `READ_TOOLS`, you have removed the guardrail.
 */

import { tool } from "@langchain/core/tools";
import * as z from "zod";

import {
  CARRIERS,
  DRIVERS,
  getDriver,
  roadMiles,
  STANDARD_SHIFT_MINUTES,
} from "@/mock/fleet";
import { getLoad } from "@/mock/loads";
import { calculateActionCost } from "./cost";

/** How far out the dispatcher's board looks for relief drivers. */
export const SEARCH_RADIUS_MILES = 350;

const getLoadManifest = tool(
  async ({ load_id }) => {
    const load = getLoad(load_id);
    if (!load) return JSON.stringify({ error: `Unknown load ${load_id}` });

    return JSON.stringify({
      load_id: load.loadId,
      customer: load.customer,
      origin: load.origin,
      destination: load.destination,
      cargo: load.cargo,
      cargo_value_usd: load.cargoValueUsd,
      sla_penalty_usd: load.slaPenaltyUsd,
      minutes_until_sla_deadline: load.minutesUntilSlaDeadline,
      current_city: load.currentCity,
      current_lat: load.currentPosition.lat,
      current_lon: load.currentPosition.lon,
      remaining_road_miles: load.remainingRoadMiles,
      remaining_drive_minutes: load.remainingDriveMinutes,
      assigned_driver_id: load.assignedDriverId,
      status: load.status,
      dispatch_notes: load.dispatchNotes,
    });
  },
  {
    name: "get_load_manifest",
    description:
      "Retrieves the full manifest for a load: cargo, SLA deadline and penalty, " +
      "current position, remaining drive time, and dispatch notes.",
    schema: z.object({
      load_id: z.string().describe("The load identifier, e.g. LOAD-4471"),
    }),
  },
);

const queryNearbyDrivers = tool(
  async ({ location_lat, location_lon, required_hos_minutes }) => {
    const origin = { lat: location_lat, lon: location_lon };

    const candidates = DRIVERS.map((d) => ({
      driver: d,
      distanceMiles: Math.round(roadMiles(d.position, origin) * 10) / 10,
    }))
      .filter((c) => c.distanceMiles <= SEARCH_RADIUS_MILES)
      .sort((a, b) => a.distanceMiles - b.distanceMiles)
      .map(({ driver, distanceMiles }) => ({
        driver_id: driver.driverId,
        name: driver.name,
        nearest_city: driver.nearestCity,
        distance_road_miles: distanceMiles,
        hos_minutes_remaining: driver.hosMinutesRemaining,
        status: driver.status,
        meets_hos_requirement:
          driver.status === "AVAILABLE" &&
          driver.hosMinutesRemaining >= required_hos_minutes,
      }));

    return JSON.stringify({
      search_radius_miles: SEARCH_RADIUS_MILES,
      required_hos_minutes,
      drivers: candidates,
    });
  },
  {
    name: "query_nearby_drivers",
    description:
      "Finds available fleet drivers within a specific radius who have enough " +
      "legal Hours of Service (HOS) remaining.",
    schema: z.object({
      location_lat: z.number().describe("Latitude of the delayed truck"),
      location_lon: z.number().describe("Longitude of the delayed truck"),
      required_hos_minutes: z
        .number()
        .int()
        .describe(
          "Minimum legal driving minutes required to complete the delivery",
        ),
    }),
  },
);

const checkDriverHos = tool(
  async ({ driver_id }) => {
    const d = getDriver(driver_id);
    if (!d) return JSON.stringify({ error: `Unknown driver ${driver_id}` });

    return JSON.stringify({
      driver_id: d.driverId,
      name: d.name,
      status: d.status,
      hos_minutes_remaining: d.hosMinutesRemaining,
      minutes_on_duty_today: d.minutesOnDutyToday,
      minutes_until_overtime: Math.max(
        0,
        STANDARD_SHIFT_MINUTES - d.minutesOnDutyToday,
      ),
      current_load_id: d.currentLoadId ?? null,
    });
  },
  {
    name: "check_driver_hos",
    description:
      "Returns the remaining legal Hours of Service and duty status for one driver.",
    schema: z.object({
      driver_id: z.string().describe("The driver identifier, e.g. DRV-217"),
    }),
  },
);

const queryBackupCarriers = tool(
  async ({ load_id }) => {
    const load = getLoad(load_id);
    if (!load) return JSON.stringify({ error: `Unknown load ${load_id}` });

    return JSON.stringify({
      load_id,
      load_state: load.currentStateCode,
      carriers: CARRIERS.map((c) => ({
        carrier_id: c.carrierId,
        name: c.name,
        spot_rate_usd_per_mile: c.spotRateUsdPerMile,
        emergency_acceptance_fee_usd: c.emergencyAcceptanceFeeUsd,
        service_regions: c.serviceRegions,
        licensed_in_load_state: c.serviceRegions.includes(load.currentStateCode),
      })),
    });
  },
  {
    name: "query_backup_carriers",
    description:
      "Lists third-party carriers that could take over a load, with their spot " +
      "rates and whether they are licensed in the state the load is sitting in. " +
      "Use only when no company driver can legally run the load.",
    schema: z.object({
      load_id: z.string().describe("The load identifier, e.g. LOAD-4472"),
    }),
  },
);

const calculateRerouteCost = tool(
  async ({ load_id, resource_id }) => {
    try {
      const c = calculateActionCost(load_id, resource_id);
      return JSON.stringify({
        load_id: c.loadId,
        resource_id: c.resourceId,
        resource_name: c.resourceName,
        resource_kind: c.resourceKind,
        feasible: !c.infeasibleReason,
        infeasible_reason: c.infeasibleReason ?? null,
        extra_fuel_usd: c.extraFuelUsd,
        driver_overtime_usd: c.driverOvertimeUsd,
        third_party_carrier_usd: c.thirdPartyCarrierUsd,
        accessorial_usd: c.accessorialUsd,
        total_usd: c.totalUsd,
      });
    } catch (err) {
      return JSON.stringify({ error: (err as Error).message });
    }
  },
  {
    name: "calculate_reroute_cost",
    description:
      "Calculates the full financial impact of handing a load to a specific " +
      "company driver or third-party carrier: extra fuel, driver overtime, " +
      "carrier fees and accessorials. Also reports whether that resource is " +
      "legally and physically able to take the load.",
    schema: z.object({
      load_id: z.string().describe("The load identifier"),
      resource_id: z
        .string()
        .describe("A driver id (DRV-...) or carrier id (CAR-...)"),
    }),
  },
);

/** Tools the ToolNode may execute. All read-only. */
export const READ_TOOLS = [
  getLoadManifest,
  queryNearbyDrivers,
  checkDriverHos,
  queryBackupCarriers,
  calculateRerouteCost,
];

/**
 * The single write action. Declared to the model so it can request it, but it
 * is NEVER executed by the ToolNode — `graph.ts` intercepts the call, prices it
 * with `calculateActionCost`, and only then decides between autonomous
 * execution and human approval.
 */
export const EXECUTE_REROUTE_TOOL = {
  type: "function" as const,
  function: {
    name: "execute_reroute",
    description:
      "Commits the reroute in the TMS: assigns the load to the given company " +
      "driver or third-party carrier. Call this once you have chosen the best " +
      "feasible option. The dispatch platform prices the action and may require " +
      "human approval before it takes effect.",
    parameters: {
      type: "object",
      properties: {
        load_id: { type: "string", description: "The load identifier" },
        resource_id: {
          type: "string",
          description: "Driver id (DRV-...) or carrier id (CAR-...)",
        },
        justification: {
          type: "string",
          description:
            "One or two sentences on why this resource is the right choice.",
        },
      },
      required: ["load_id", "resource_id", "justification"],
    },
  },
};

export const EXECUTE_REROUTE_NAME = "execute_reroute";
