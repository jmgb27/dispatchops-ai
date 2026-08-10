import { DispatchConsole } from "@/components/DispatchConsole";
import { langfuseEnabled } from "@/agent/observability";
import {
  maxAutonomousSpendUsd,
  maxDailySpendUsd,
  maxLoadSpendUsd,
} from "@/agent/cost";
import { listLoads, resetTms } from "@/mock/loads";
import { SCENARIOS } from "@/mock/scenarios";

export const dynamic = "force-dynamic";

export default function Home() {
  // The dashboard always opens on a clean board.
  resetTms();

  return (
    <DispatchConsole
      scenarios={SCENARIOS}
      initialLoads={listLoads()}
      config={{
        model: process.env.QWEN_MODEL || "qwen3.7-plus",
        thresholdUsd: maxAutonomousSpendUsd(),
        // The headline stays the single-action limit, because that is the one
        // the demo exercises. The other two are real and enforced, so they
        // belong somewhere visible rather than only in the README.
        loadCeilingUsd: maxLoadSpendUsd(),
        dailyCeilingUsd: maxDailySpendUsd(),
        langfuse: langfuseEnabled(),
        mock: process.env.MOCK_AGENT === "1",
      }}
    />
  );
}
