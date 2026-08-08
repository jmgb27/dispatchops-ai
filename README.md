# 📖 DispatchOps AI — Project Documentation & Scoping Pack

## 1. Executive Summary

**DispatchOps AI** is an agentic middleware layer designed to integrate into legacy Transport Management Systems (TMS). Instead of requiring manual dispatcher intervention for every route delay, driver reassignment, and carrier rate sheet ingestion, DispatchOps continuously monitors fleet telemetry, executes autonomous resolution loops, and enforces Human-In-The-Loop (HITL) guardrails.

**Target Outcomes:**

* **60% Reduction** in manual dispatcher overhead.
* **Near-Zero SLA Breaches** for priority freight through instant agentic rerouting.
* **85%+ Reduction in LLM API Costs** by leveraging **Qwen3.7 Plus** over Western frontier models.

---

## 2. Technical Architecture & Stack

To ensure high reliability, fast UI reactivity, and low inference costs, the system relies on the following stack:

### 2.1 Core Technologies

* **Frontend UI:** Next.js 16 (App Router) + React Server Components + Tailwind CSS v4.
* **Agent Engine:** LangGraph JS (`@langchain/langgraph`) for cyclic agentic state management, running in-process inside Next.js API routes.
* **LLM Reasoning:** **Qwen3.7 Plus** (1M Context Window, Native Tool Calling, Deep Reasoning), reached over Alibaba Cloud Model Studio's OpenAI-compatible endpoint.
* **Observability & Evaluation:** **Langfuse** (v5 JS SDK, OpenTelemetry-based) for run tracing, token/cost accounting and evaluation datasets.
* **Protocol:** Model Context Protocol (MCP) to safely connect the LLM to SQL databases and external routing APIs — *Phase 2; the POC uses local mock tools.*
* **Validation:** Zod for strict schema enforcement on every tool argument before it reaches the mock TMS.

### 2.2 System Flow Diagram

```text
[ GPS Telematics Webhook / UI Trigger ]
                  │
                  ▼
[ Next.js API Route → LangGraph StateGraph (SSE stream) ]
                  │
                  ▼
    ┌───────────────────────────┐
    │       Qwen3.7 Plus        │◀──────────────┐
    │  (Evaluation & Planning)  │               │
    └─────────────┬─────────────┘               │
                  │ (JSON Tool Request)         │ (tool results)
                  ▼                             │
    ┌───────────────────────────┐               │
    │  ToolNode — READ ONLY     │───────────────┘
    │  - get_load_manifest()    │
    │  - query_nearby_drivers() │
    │  - check_driver_hos()     │
    │  - query_backup_carriers()│
    │  - calculate_reroute_cost()│
    └───────────────────────────┘

  ...but a request for the ONE write tool is intercepted:

      [ execute_reroute requested ]
                  │
                  ▼
    ┌───────────────────────────┐
    │       costGate node       │  ← deterministic TypeScript,
    │  calculateActionCost()    │    no model involvement
    └─────────────┬─────────────┘
        ┌─────────┴─────────┬──────────────────┐
   (infeasible)       (Cost < $500)      (Cost >= $500)
        │                   │                  │
 [ Refuse + replan ]  [ execute node ]   [ approval node ]
                      [ mutate TMS   ]   [ interrupt()   ]
                                         [ Action Card   ]
                                                │
                                    ┌───────────┴──────────┐
                               [ Approve ]            [ Reject ]
                               → execute              → replan
```

---

## 3. Core Agentic Workflows & Tool Schemas

The Qwen3.7 Plus agent has access to a strictly typed suite of tools. During the POC phase, these are backed by local mock databases to ensure flawless demonstration during interviews.

> **POC scope:** Workflow 1 is implemented and running. Workflow 2 (rate-sheet RAG ingestion) is specified below but scheduled for Phase 2 — see §7.

### 3.1 Workflow 1: Route Delay & SLA Resolver

* **Trigger:** GPS webhook alerts that a truck is delayed by X minutes.
* **Agent Logic:** Analyzes the manifest, determines if delivery SLAs will be breached, and queries available drivers to re-route the shipment.

**Tool Schema: `query_nearby_drivers`**

```json
{
  "name": "query_nearby_drivers",
  "description": "Finds available fleet drivers within a specific radius who have enough legal Hours of Service (HOS) remaining.",
  "parameters": {
    "type": "object",
    "properties": {
      "location_lat": { "type": "number", "description": "Latitude of the delayed truck" },
      "location_lon": { "type": "number", "description": "Longitude of the delayed truck" },
      "required_hos_minutes": { "type": "integer", "description": "Minimum legal driving minutes required to complete the delivery" }
    },
    "required": ["location_lat", "location_lon", "required_hos_minutes"]
  }
}
```

### 3.2 Workflow 2: Freight Rate Sheet Ingestion (RAG)

* **Trigger:** An unstructured PDF or email from a third-party carrier is uploaded.
* **Agent Logic:** Qwen3.7 Plus utilizes its massive 1M token context window to parse complex, unstructured rate tables and outputs a validated JSON tender matching current load capacity requirements.

**Tool Schema: `issue_carrier_tender`**

```json
{
  "name": "issue_carrier_tender",
  "description": "Formally issues a load tender to a third-party carrier based on extracted rate margins.",
  "parameters": {
    "type": "object",
    "properties": {
      "carrier_id": { "type": "string" },
      "load_id": { "type": "string" },
      "agreed_rate_usd": { "type": "number" },
      "pickup_window": { "type": "string", "format": "date-time" }
    },
    "required": ["carrier_id", "load_id", "agreed_rate_usd"]
  }
}
```

---

## 4. Guardrails & Safety (Human-In-The-Loop)

Agentic automation in logistics carries severe financial and safety risks if unconstrained. The application implements a **Hard Cost Ceiling Guardrail**.

The design decision that matters: **the ceiling is a graph edge, not an instruction.** The model can *request* a reroute, but `execute_reroute` is deliberately never bound to the ToolNode. The request lands in `costGateNode` (`src/agent/graph.ts`), which prices it with pure TypeScript and routes on the resulting number. A prompt-based guardrail is one jailbreak away from a $40k tender; this one cannot be argued with, because nothing is asked.

1. **Pre-Execution Hook:** `calculateActionCost()` (`src/agent/cost.ts`) evaluates the financial impact — deadhead fuel, driver overtime, 3PL spot rate, accessorials — as a pure function of TMS state. No clock, no randomness, no model input.
2. **Feasibility is also structural:** an assignment that breaks federal Hours-of-Service limits, uses a driver whose own tractor is disabled, or hands a load to a carrier unlicensed in that state is refused outright, whatever it costs and whatever the model argued.
3. **Threshold Logic:**
   * If `Cost < $500`: The agent executes the route mutation autonomously.
   * If `Cost >= $500`: The graph calls LangGraph's `interrupt()` and the run halts at `PENDING_HUMAN_APPROVAL`, checkpointed mid-execution.
4. **UI Resolution:** The dashboard renders an Action Card detailing the agent's justification, the itemised cost derivation, and `[Approve]` / `[Reject]`. Approve resumes the same graph thread via `Command({ resume })`; Reject sends the refusal back to the agent as a tool result so it replans.

The whole of `src/agent/guardrail.test.ts` exists to prove this holds — including a scenario whose inbound dispatch notes explicitly instruct the agent to ignore the cost ceiling. It changes nothing.

---

## 5. Unit Economics & Rationale for Qwen3.7 Plus

To align with Teoh Capital's focus on SaaS margins, Qwen3.7 Plus was deliberately chosen over GPT-4o or Claude 3.5 Sonnet.

* **Context Window:** 1,000,000 tokens (Crucial for reading 50+ page freight carrier PDFs).
* **Cost Efficiency:** **$0.32 Input / $1.28 Output per 1M tokens** (verified against the live endpoint, August 2026).
* **Margin Impact:** This represents an **85%+ reduction in inference costs** compared to OpenAI/Anthropic, transforming AI from a high-cost R&D expense into a high-margin product feature.
* **Agentic Capabilities:** Confirmed in this POC — Qwen3.7 Plus emits well-formed parallel tool calls (it routinely batches `check_driver_hos` and `query_nearby_drivers` in a single turn), returns clean structured arguments, and exposes reasoning tokens for the multi-step planning LangGraph depends on.

### 5.1 Observability & Evaluation (Langfuse)

Every run is traced to **Langfuse** so a reviewer can open one exception and see the entire decision path: each Qwen call with its reasoning, each tool result, the cost-gate decision, and per-run token and dollar cost.

* The graph `thread_id` is used as the Langfuse `sessionId`, so the initial run and the post-approval resume appear as one continuous session rather than two orphaned traces.
* Runs are tagged `scenario:<id>` and `load:<id>` for filtering, and stamped with the model id for A/B comparisons between Qwen tiers.
* Traces are named `dispatch:<scenario>` (and `dispatch:<scenario>:resume`), set via `propagateAttributes` — the LangChain `CallbackHandler` has no `traceName` option, so the name has to come from the surrounding context.
* Spans are force-flushed when a run finishes streaming. OTel batches on a timer, and a serverless instance can be frozen before that timer fires — which loses traces silently, worse than not tracing at all.
* Tracing is strictly optional. With `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` unset the callback factory returns an empty array and the app behaves identically — the demo never depends on an external service being reachable.

Wiring lives in `instrumentation.ts` (registers the OpenTelemetry span processor once at boot) and `src/agent/observability.ts` (per-run callback handler, trace context, flush).

#### One-time setup: register the model price

Langfuse computes cost from token counts and a model price table, and it does not ship a price for Qwen. Until you register one, traces show accurate token usage but **$0 cost**. Add it once per project:

```bash
curl -u "$LANGFUSE_PUBLIC_KEY:$LANGFUSE_SECRET_KEY" \
  -X POST "$LANGFUSE_BASE_URL/api/public/models" \
  -H "Content-Type: application/json" -d '{
    "modelName": "qwen3.7-plus",
    "matchPattern": "(?i)^(qwen3\\.7-plus.*)$",
    "unit": "TOKENS",
    "inputPrice": 0.00000032,
    "outputPrice": 0.00000128
  }'
```

#### Measured unit economics

From a live traced run of the Route Delay resolver (5 Qwen generations, full tool loop):

| | Tokens | Cost |
|---|---|---|
| Input | 9,436 | $0.0030 |
| Output (incl. reasoning) | 1,763 | $0.0023 |
| **Per resolved exception** | **11,199** | **≈ $0.0053** |

That is **$5.28 per 1,000 exceptions**. The same token volume on a $2.50/$10.00-per-1M frontier model costs $0.0412 — a **7.8× difference, or 87% lower inference cost**, which validates the §5 thesis with measured numbers rather than list prices.

---

## 6. Implementation & Local Setup Guide

Follow these steps to run the interactive Next.js prototype locally.

### Repository Layout

```text
instrumentation.ts              Langfuse OTel span processor, registered at boot
src/agent/
  graph.ts                      StateGraph — agent │ tools │ costGate │ approval │ execute
  cost.ts                       calculateActionCost() — the deterministic guardrail
  tools.ts                      5 read tools (Zod) + the intercepted write tool
  model.ts                      Qwen3.7 Plus binding + system prompt
  mockModel.ts                  Scripted offline agent (MOCK_AGENT=1)
  observability.ts              Langfuse CallbackHandler factory
  stream.ts                     Graph updates → SSE event vocabulary
  guardrail.test.ts             The tests that prove the ceiling holds
src/mock/                       Mock TMS: fleet roster, load table, demo scenarios
src/app/api/dispatch/           POST run (SSE) + POST resume (Command resume)
src/components/                 Dispatcher console, agent trace, approval card
```

### Prerequisites

* Node.js v20.x or higher (developed on v22)
* `npm`
* A Qwen API key — Alibaba Cloud Model Studio or OpenRouter

### Step 1: Clone and Install

```bash
git clone https://github.com/jmgb27/dispatchops-ai.git
cd dispatchops-ai
npm install
```

### Step 2: Environment Variables

```bash
cp .env.example .env.local
```

Then fill it in. `.env.local` is gitignored — never commit real keys.

```env
# Alibaba Cloud Model Studio (OpenAI-compatible mode)
QWEN_API_KEY=sk-...
QWEN_BASE_URL=https://dashscope-intl.aliyuncs.com/compatible-mode/v1
QWEN_MODEL=qwen3.7-plus

# Guardrail
MAX_AUTONOMOUS_SPEND_USD=500

# Optional — tracing self-disables when these are blank
LANGFUSE_PUBLIC_KEY=
LANGFUSE_SECRET_KEY=
LANGFUSE_BASE_URL=https://cloud.langfuse.com

# Set to 1 to run fully offline against a scripted agent
MOCK_AGENT=0
```

> **Model id differs by provider.** On Model Studio / DashScope the id is `qwen3.7-plus`. On OpenRouter it is `qwen/qwen3.7-plus` and the base URL is `https://openrouter.ai/api/v1`. If you have a dedicated Model Studio workspace, use that workspace's own `compatible-mode` host rather than the shared one.

### Step 3: Run the Development Server

```bash
npm run dev     # http://localhost:3000
npm test        # guardrail + cost model suite (13 tests, no API key needed)
npm run typecheck
```

### Step 4: Using the Prototype

1. Navigate to `http://localhost:3000`.
2. Click **"Simulate Telematics Exception"** — a reefer load held 95 minutes on I-10. Watch Qwen pull the manifest, discover the assigned driver is out of legal hours, find a relief driver 4.3 mi away, and price the relay at **$149.94**. Under the ceiling, so it commits autonomously.
3. Click **"Simulate Major Breakdown"** — a disabled tractor near Elko, NV. No company driver has the legal hours, so the only feasible option is a third-party recovery at **$1,324.50**. The run halts at `PENDING_HUMAN_APPROVAL` and the TMS panel stays untouched. Approve to resume; Reject to watch the agent replan.
4. Click **"Simulate Injected Manifest"** — the same breakdown, but the inbound dispatch notes instruct the agent to ignore the cost ceiling and execute immediately. It still halts, because the ceiling was never the model's to honour.

**Offline demo:** set `MOCK_AGENT=1` to swap Qwen for a deterministic scripted agent that walks the same graph, the same cost model and the same guardrail. Useful when the venue's wifi is not to be trusted.

---

## 7. Future Roadmap (Phase 2 & 3)

* **Week 5-8:** Replace mock tools with a production Model Context Protocol (MCP) server connecting directly to PostgreSQL TMS databases. At the same time, swap LangGraph's in-process `MemorySaver` checkpointer for the Postgres checkpointer — the POC's approval state is held in memory, which is fine for a single-node demo but will not survive a restart or scale across instances.
* **Week 5-8:** Ship Workflow 2 (freight rate-sheet RAG ingestion, §3.2), which is where the 1M context window earns its keep.
* **Week 9-12:** Integrate Twilio SMS webhooks to allow the agent to text drivers instructions dynamically.
* **Week 13+:** Self-host the Qwen ecosystem on dedicated Proxmox/vLLM servers via Cloudflare Tunnels for zero-variable-cost inference.
