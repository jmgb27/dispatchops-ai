/**
 * Deterministic offline stand-in for Qwen, enabled with MOCK_AGENT=1.
 *
 * It is not a language model — it replays the tool sequence a competent agent
 * would follow, reading the real tool results to decide each next step. That
 * means it exercises the same graph, the same cost model and the same guardrail
 * as a live run, so an interview demo survives a dead network. Anything it
 * "reasons" is canned; anything it decides comes from actual tool output.
 */

import { AIMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";

interface ToolCallSpec {
  name: string;
  args: Record<string, unknown>;
}

/** Shapes of the tool payloads this script reads back. */
interface ManifestResult {
  current_lat: number;
  current_lon: number;
  remaining_drive_minutes: number;
  minutes_until_sla_deadline: number;
  sla_penalty_usd: number;
}

interface DriverCandidate {
  driver_id: string;
  name: string;
  distance_road_miles: number;
  hos_minutes_remaining: number;
  meets_hos_requirement: boolean;
}

interface NearbyDriversResult {
  drivers: DriverCandidate[];
}

interface CarrierOption {
  carrier_id: string;
  name: string;
  licensed_in_load_state: boolean;
}

interface BackupCarriersResult {
  load_state: string;
  carriers: CarrierOption[];
}

interface CostResult {
  feasible: boolean;
  resource_id: string;
  resource_name: string;
  total_usd: number;
}

interface ExecutionResult {
  executed: boolean;
  reason?: string;
  load_id?: string;
  new_status?: string;
  assigned_to?: string;
  cost_usd?: number;
  approved_by?: string;
}

let callCounter = 0;
function nextCallId(): string {
  callCounter += 1;
  return `mock_call_${callCounter}`;
}

function say(text: string, call?: ToolCallSpec): AIMessage {
  return new AIMessage({
    content: text,
    tool_calls: call
      ? [{ name: call.name, args: call.args, id: nextCallId(), type: "tool_call" }]
      : [],
  });
}

/** Latest result for each tool, parsed. */
function collectToolResults(messages: BaseMessage[]): Map<string, unknown> {
  const results = new Map<string, unknown>();
  for (const m of messages) {
    if (m instanceof ToolMessage && m.name) {
      try {
        results.set(m.name, JSON.parse(String(m.content)));
      } catch {
        results.set(m.name, { raw: String(m.content) });
      }
    }
  }
  return results;
}

function findLoadId(messages: BaseMessage[]): string {
  for (const m of messages) {
    const match = String(m.content).match(/LOAD-\d+/);
    if (match) return match[0];
  }
  return "LOAD-4471";
}

class MockBoundModel {
  async invoke(messages: BaseMessage[]): Promise<AIMessage> {
    const results = collectToolResults(messages);
    const loadId = findLoadId(messages);

    const manifest = results.get("get_load_manifest") as
      | ManifestResult
      | undefined;
    const nearby = results.get("query_nearby_drivers") as
      | NearbyDriversResult
      | undefined;
    const carriers = results.get("query_backup_carriers") as
      | BackupCarriersResult
      | undefined;
    const cost = results.get("calculate_reroute_cost") as
      | CostResult
      | undefined;
    const execution = results.get("execute_reroute") as
      | ExecutionResult
      | undefined;

    if (execution) {
      if (execution.executed) {
        return say("The reroute is committed.");
      }
      return say(
        `The platform refused that action: ${execution.reason ?? "unknown reason"}. ` +
          "There is no cheaper feasible alternative for this load, so this needs a dispatcher decision.",
      );
    }

    if (!manifest) {
      return say(`Pulling the manifest for ${loadId} to see what the SLA exposure is.`, {
        name: "get_load_manifest",
        args: { load_id: loadId },
      });
    }

    if (!nearby) {
      return say(
        `${manifest.remaining_drive_minutes} driving minutes remain and only ` +
          `${manifest.minutes_until_sla_deadline} minutes before the SLA window closes. ` +
          "Looking for a relief driver with the legal hours.",
        {
          name: "query_nearby_drivers",
          args: {
            location_lat: manifest.current_lat,
            location_lon: manifest.current_lon,
            required_hos_minutes: manifest.remaining_drive_minutes,
          },
        },
      );
    }

    const eligible = (nearby.drivers ?? []).filter(
      (d) => d.meets_hos_requirement,
    );

    if (eligible.length > 0 && !cost) {
      const pick = eligible[0];
      return say(
        `${pick.name} is ${pick.distance_road_miles} mi away with ` +
          `${pick.hos_minutes_remaining} HOS minutes — enough to run this out. Pricing the relay.`,
        {
          name: "calculate_reroute_cost",
          args: { load_id: loadId, resource_id: pick.driver_id },
        },
      );
    }

    if (eligible.length === 0 && !carriers) {
      return say(
        "No company driver has the legal hours to take this load. " +
          "Checking third-party carriers.",
        { name: "query_backup_carriers", args: { load_id: loadId } },
      );
    }

    if (carriers && !cost) {
      const licensed = (carriers.carriers ?? []).find(
        (c) => c.licensed_in_load_state,
      );
      return say(
        `${licensed?.name ?? "A carrier"} is licensed in ${carriers.load_state}. Pricing the tender.`,
        {
          name: "calculate_reroute_cost",
          args: { load_id: loadId, resource_id: licensed?.carrier_id },
        },
      );
    }

    if (cost?.feasible) {
      return say(
        `${cost.resource_name} can cover it for $${cost.total_usd}. Committing the reroute.`,
        {
          name: "execute_reroute",
          args: {
            load_id: loadId,
            resource_id: cost.resource_id,
            justification:
              `${cost.resource_name} is the only feasible option that protects the ` +
              `$${manifest.sla_penalty_usd} SLA penalty, at $${cost.total_usd}.`,
          },
        },
      );
    }

    return say(
      "I could not find a feasible way to protect this delivery. Escalating to the duty dispatcher.",
    );
  }
}

class MockSummaryModel {
  async invoke(messages: BaseMessage[]): Promise<AIMessage> {
    const results = collectToolResults(messages);
    const execution = results.get("execute_reroute") as
      | ExecutionResult
      | undefined;
    const cost = results.get("calculate_reroute_cost") as
      | CostResult
      | undefined;

    if (execution?.executed) {
      return new AIMessage(
        `${execution.load_id} is now ${(execution.new_status ?? "reassigned").toLowerCase().replace(/_/g, " ")} ` +
          `to ${execution.assigned_to} at a cost of $${execution.cost_usd}, ` +
          `${execution.approved_by === "HUMAN_DISPATCHER" ? "following dispatcher approval" : "resolved autonomously"}. ` +
          `The delivery window is protected and no SLA penalty is expected.`,
      );
    }

    return new AIMessage(
      `The reroute was not committed${cost ? ` (last option priced at $${cost.total_usd})` : ""}. ` +
        "The load still needs a dispatcher decision.",
    );
  }
}

export function buildMockBoundModel() {
  return new MockBoundModel();
}

export function buildMockSummaryModel() {
  return new MockSummaryModel();
}
