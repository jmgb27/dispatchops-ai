/**
 * The tests that matter: proving the cost ceiling is structural.
 *
 * Run with MOCK_AGENT=1 so the sequence is deterministic — these assert the
 * behaviour of the graph and the cost model, not the wording of an LLM.
 */

import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { Command } from "@langchain/langgraph";
import { HumanMessage } from "@langchain/core/messages";

import {
  SpendCapExceededError,
  getAuditLog,
  getLoad,
  reassignLoad,
  resetTms,
  spendLedger,
} from "@/mock/loads";
import { getScenario } from "@/mock/scenarios";
import { evaluateAutonomy } from "@/spend-policy";
import { calculateActionCost, requiresHumanApproval } from "./cost";

const CEILINGS = {
  MAX_AUTONOMOUS_SPEND_USD: "500",
  MAX_LOAD_SPEND_USD: "2000",
  MAX_DAILY_SPEND_USD: "5000",
};

beforeAll(() => {
  process.env.MOCK_AGENT = "1";
});

beforeEach(() => {
  Object.assign(process.env, CEILINGS);
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
  autonomy?: { reason: string | null };
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

describe("cumulative ceilings", () => {
  test("the per-action ceiling alone cannot see a sequence", () => {
    // The hole this exists to close. Each action passes on its own merits.
    expect(requiresHumanApproval(450)).toBe(false);

    const decision = evaluateAutonomy(450, { loadUsd: 1_600, dailyUsd: 1_600 });
    expect(decision.requiresApproval).toBe(true);
    expect(decision.reason).toBe("LOAD_CUMULATIVE_CEILING");
    expect(decision.alreadySpentUsd).toBe(1_600);
    expect(decision.wouldTotalUsd).toBe(2_050);
  });

  test("the ledger is derived from the audit log, not tracked separately", () => {
    expect(spendLedger("LOAD-4471")).toEqual({ loadUsd: 0, dailyUsd: 0 });

    reassignLoad("LOAD-4471", "DRV-217", 149.94, "AGENT_AUTONOMOUS");
    reassignLoad("LOAD-4472", "DRV-238", 200.5, "AGENT_AUTONOMOUS");

    expect(spendLedger("LOAD-4471")).toEqual({
      loadUsd: 149.94,
      dailyUsd: 350.44,
    });
  });

  test("a run of individually cheap actions escalates before it runs away", () => {
    // Four $450 reroutes are fine. The fifth crosses $2,000 on one load.
    for (let i = 0; i < 4; i++) {
      reassignLoad("LOAD-4471", "DRV-217", 450, "AGENT_AUTONOMOUS");
    }
    expect(spendLedger("LOAD-4471").loadUsd).toBe(1_800);

    const decision = evaluateAutonomy(450, spendLedger("LOAD-4471"));
    expect(decision.requiresApproval).toBe(true);
    expect(decision.reason).toBe("LOAD_CUMULATIVE_CEILING");
  });

  test("the daily ceiling catches spend spread across different loads", () => {
    process.env.MAX_LOAD_SPEND_USD = "10000";
    process.env.MAX_DAILY_SPEND_USD = "1000";

    reassignLoad("LOAD-4471", "DRV-217", 450, "AGENT_AUTONOMOUS");
    reassignLoad("LOAD-4472", "DRV-238", 450, "AGENT_AUTONOMOUS");

    const decision = evaluateAutonomy(450, spendLedger("LOAD-4471"));
    expect(decision.reason).toBe("DAILY_CUMULATIVE_CEILING");
    expect(decision.wouldTotalUsd).toBe(1_350);
  });

  test("every cumulative bound is closed from below, like the per-action one", () => {
    expect(
      evaluateAutonomy(100, { loadUsd: 1_899.99, dailyUsd: 0 })
        .requiresApproval,
    ).toBe(false);
    expect(
      evaluateAutonomy(100, { loadUsd: 1_900, dailyUsd: 0 }).requiresApproval,
    ).toBe(true);
  });
});

describe("the write path is the backstop, not the gate", () => {
  test("refuses an autonomous commit past the ceiling even with no gate involved", () => {
    process.env.MAX_LOAD_SPEND_USD = "500";

    reassignLoad("LOAD-4471", "DRV-217", 400, "AGENT_AUTONOMOUS");

    // Called directly — this is what a routing bug would look like.
    expect(() =>
      reassignLoad("LOAD-4471", "DRV-217", 400, "AGENT_AUTONOMOUS"),
    ).toThrow(SpendCapExceededError);

    // And it refused before writing anything.
    expect(getAuditLog()).toHaveLength(1);
    expect(spendLedger("LOAD-4471").loadUsd).toBe(400);
  });

  test("an approved commit is exempt — approval is the way past the ceiling", () => {
    process.env.MAX_LOAD_SPEND_USD = "500";

    reassignLoad("LOAD-4471", "DRV-217", 400, "AGENT_AUTONOMOUS");
    expect(() =>
      reassignLoad("LOAD-4471", "DRV-217", 400, "HUMAN_DISPATCHER"),
    ).not.toThrow();

    expect(getAuditLog()).toHaveLength(2);
    expect(spendLedger("LOAD-4471").loadUsd).toBe(800);
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

describe("graph: the cumulative ceiling is control flow too", () => {
  test("the same cheap reroute halts once the load has spent enough today", async () => {
    // A dispatcher already signed off $1,900 on this load. The relay that ran
    // autonomously in the test above is unchanged and still costs $149.94 —
    // what changed is the authority left to spend it.
    reassignLoad("LOAD-4471", "DRV-204", 1_900, "HUMAN_DISPATCHER");

    const result = await runScenario("telematics-exception", "t-cum-1");

    const interrupts = interruptsOf(result);
    expect(interrupts).toBeDefined();

    const payload = interrupts![0].value;
    expect(payload.breakdown.totalUsd).toBe(149.94);
    expect(payload.autonomy?.reason).toBe("LOAD_CUMULATIVE_CEILING");

    // Still under the per-action ceiling — this is the sequence being caught.
    expect(requiresHumanApproval(149.94)).toBe(false);

    // And nothing new was committed.
    expect(getAuditLog()).toHaveLength(1);
  });
});

describe("a decision that cannot be applied must not look like one that was", () => {
  test("an interrupted thread reports work still pending", async () => {
    const { dispatchGraph } = await import("./graph");
    await runScenario("major-breakdown", "t-pending-1");

    const snapshot = await dispatchGraph.getState({
      configurable: { thread_id: "t-pending-1" },
    });
    expect(snapshot.next.length).toBeGreaterThan(0);
  });

  test("a thread the checkpointer never saw reports nothing pending", async () => {
    const { dispatchGraph } = await import("./graph");
    const snapshot = await dispatchGraph.getState({
      configurable: { thread_id: "t-never-existed" },
    });

    // This is the signal the stream guard reads before resuming. Without it a
    // resume here is a silent no-op that the console renders as a rejection.
    expect(snapshot?.next?.length ?? 0).toBe(0);
  });

  test("approving a thread that was never interrupted commits nothing", async () => {
    const { dispatchGraph } = await import("./graph");

    await dispatchGraph.invoke(new Command({ resume: { approved: true } }), {
      configurable: { thread_id: "t-ghost" },
      recursionLimit: 40,
    });

    expect(getAuditLog()).toHaveLength(0);
    expect(getLoad("LOAD-4472")!.status).toBe("DISABLED");
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
