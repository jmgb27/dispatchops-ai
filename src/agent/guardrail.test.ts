/**
 * The tests that matter: proving the cost ceiling is structural.
 *
 * Run with MOCK_AGENT=1 so the sequence is deterministic — these assert the
 * behaviour of the graph and the cost model, not the wording of an LLM.
 */

import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { Command } from "@langchain/langgraph";
import { HumanMessage } from "@langchain/core/messages";

import { getAuditLog, getLoad, resetTms } from "@/mock/loads";
import { getScenario } from "@/mock/scenarios";
import { calculateActionCost, requiresHumanApproval } from "./cost";

beforeAll(() => {
  process.env.MOCK_AGENT = "1";
  process.env.MAX_AUTONOMOUS_SPEND_USD = "500";
});

beforeEach(() => {
  resetTms();
});

/**
 * `__interrupt__` is a runtime field on the invoke result rather than part of
 * the declared state annotation, so it needs a narrow cast to read in tests.
 */
interface ApprovalInterrupt {
  type: string;
  thresholdUsd: number;
  breakdown: { totalUsd: number };
}

function interruptsOf(
  result: unknown,
): { value: ApprovalInterrupt }[] | undefined {
  return (result as { __interrupt__?: { value: ApprovalInterrupt }[] })
    .__interrupt__;
}

async function runScenario(scenarioId: string, threadId: string) {
  const { dispatchGraph } = await import("./graph");
  const scenario = getScenario(scenarioId)!;
  return dispatchGraph.invoke(
    { messages: [new HumanMessage(scenario.event)], loadId: scenario.loadId },
    { configurable: { thread_id: threadId }, recursionLimit: 40 },
  );
}

describe("cost model", () => {
  test("prices the cheap relay under the ceiling", () => {
    const c = calculateActionCost("LOAD-4471", "DRV-217");
    expect(c.infeasibleReason).toBeUndefined();
    expect(c.totalUsd).toBe(149.94);
    expect(requiresHumanApproval(c.totalUsd)).toBe(false);
  });

  test("prices the carrier recovery over the ceiling", () => {
    const c = calculateActionCost("LOAD-4472", "CAR-882");
    expect(c.infeasibleReason).toBeUndefined();
    expect(c.totalUsd).toBe(1324.5);
    expect(requiresHumanApproval(c.totalUsd)).toBe(true);
  });

  test("line items reconcile to the total", () => {
    for (const [loadId, resourceId] of [
      ["LOAD-4471", "DRV-217"],
      ["LOAD-4472", "CAR-882"],
    ] as const) {
      const c = calculateActionCost(loadId, resourceId);
      const summed = c.lineItems.reduce((acc, li) => acc + li.amountUsd, 0);
      expect(Math.round(summed * 100) / 100).toBe(c.totalUsd);
    }
  });

  test("refuses an HOS-illegal driver regardless of cost", () => {
    const c = calculateActionCost("LOAD-4471", "DRV-221");
    expect(c.infeasibleReason).toMatch(/HOS minutes remaining/);
  });

  test("refuses a carrier outside its licensed region", () => {
    const c = calculateActionCost("LOAD-4472", "CAR-914");
    expect(c.infeasibleReason).toMatch(/not licensed in NV/);
  });

  test("refuses the driver whose own tractor is disabled", () => {
    const c = calculateActionCost("LOAD-4472", "DRV-231");
    expect(c.infeasibleReason).toMatch(/disabled/);
  });
});

describe("approval threshold boundary", () => {
  test("is a closed lower bound at the ceiling", () => {
    expect(requiresHumanApproval(499.99)).toBe(false);
    expect(requiresHumanApproval(500)).toBe(true);
    expect(requiresHumanApproval(500.01)).toBe(true);
  });

  test("tracks the configured ceiling", () => {
    process.env.MAX_AUTONOMOUS_SPEND_USD = "100";
    expect(requiresHumanApproval(149.94)).toBe(true);
    process.env.MAX_AUTONOMOUS_SPEND_USD = "500";
    expect(requiresHumanApproval(149.94)).toBe(false);
  });
});

describe("graph: autonomous path", () => {
  test("resolves the cheap reroute without interrupting", async () => {
    const result = await runScenario("telematics-exception", "t-auto-1");

    expect(interruptsOf(result)).toBeUndefined();
    expect(result.status).toBe("RESOLVED_AUTONOMOUS");

    const load = getLoad("LOAD-4471")!;
    expect(load.status).toBe("REASSIGNED");
    expect(load.assignedDriverId).toBe("DRV-217");

    const audit = getAuditLog();
    expect(audit).toHaveLength(1);
    expect(audit[0].approvedBy).toBe("AGENT_AUTONOMOUS");
    expect(audit[0].costUsd).toBe(149.94);
  });
});

describe("graph: human-in-the-loop path", () => {
  test("halts before mutating the TMS when the action is expensive", async () => {
    const result = await runScenario("major-breakdown", "t-hitl-1");

    const interrupts = interruptsOf(result);
    expect(interrupts).toBeDefined();
    expect(interrupts).toHaveLength(1);

    const payload = interrupts![0].value;
    expect(payload.type).toBe("COST_APPROVAL");
    expect(payload.breakdown.totalUsd).toBe(1324.5);
    expect(payload.thresholdUsd).toBe(500);

    // The critical assertion: nothing was written.
    const load = getLoad("LOAD-4472")!;
    expect(load.status).toBe("DISABLED");
    expect(load.assignedDriverId).toBe("DRV-231");
    expect(getAuditLog()).toHaveLength(0);
  });

  test("commits only after a dispatcher approves", async () => {
    const { dispatchGraph } = await import("./graph");
    const config = { configurable: { thread_id: "t-hitl-2" }, recursionLimit: 40 };

    await runScenario("major-breakdown", "t-hitl-2");
    expect(getAuditLog()).toHaveLength(0);

    const resumed = await dispatchGraph.invoke(
      new Command({ resume: { approved: true } }),
      config,
    );

    expect(resumed.status).toBe("RESOLVED_AFTER_APPROVAL");

    const load = getLoad("LOAD-4472")!;
    expect(load.status).toBe("TENDERED_TO_CARRIER");
    expect(load.assignedDriverId).toBe("CAR-882");

    const audit = getAuditLog();
    expect(audit).toHaveLength(1);
    expect(audit[0].approvedBy).toBe("HUMAN_DISPATCHER");
    expect(audit[0].costUsd).toBe(1324.5);
  });

  test("leaves the TMS untouched when a dispatcher rejects", async () => {
    const { dispatchGraph } = await import("./graph");
    const config = { configurable: { thread_id: "t-hitl-3" }, recursionLimit: 40 };

    await runScenario("major-breakdown", "t-hitl-3");

    const resumed = await dispatchGraph.invoke(
      new Command({ resume: { approved: false } }),
      config,
    );

    expect(resumed.status).not.toBe("RESOLVED_AFTER_APPROVAL");
    expect(getAuditLog()).toHaveLength(0);

    const load = getLoad("LOAD-4472")!;
    expect(load.status).toBe("DISABLED");
    expect(load.assignedDriverId).toBe("DRV-231");
  });
});

describe("guardrail is not promptable", () => {
  test("still halts when the event text orders it to skip approval", async () => {
    const result = await runScenario("injection-probe", "t-inject-1");

    expect(interruptsOf(result)).toBeDefined();
    expect(interruptsOf(result)![0].value.breakdown.totalUsd).toBe(1324.5);
    expect(getAuditLog()).toHaveLength(0);
    expect(getLoad("LOAD-4472")!.status).toBe("DISABLED");
  });
});
