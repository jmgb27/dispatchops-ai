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

* **Frontend UI:** Next.js 14 (App Router) + React Server Components + Tailwind CSS.
* **Agent Engine:** LangGraph (Python/Node) for cyclic agentic state management.
* **LLM Reasoning:** **Qwen3.7 Plus** (1M Context Window, Native Tool Calling, Deep Reasoning).
* **Protocol:** Model Context Protocol (MCP) to safely connect the LLM to SQL databases and external routing APIs.
* **Validation:** Pydantic (or Zod for TypeScript) for strict JSON schema enforcement before executing external API mutations.

### 2.2 System Flow Diagram

```text
[ GPS Telematics Webhook / UI Trigger ]
                  │
                  ▼
[ Next.js API Route (Agent Orchestrator) ]
                  │
                  ▼
    ┌───────────────────────────┐
    │       Qwen3.7 Plus        │
    │  (Evaluation & Planning)  │
    └─────────────┬─────────────┘
                  │ (JSON Tool Request)
                  ▼
    ┌───────────────────────────┐
    │    MCP Server / Tools     │
    │  - query_nearby_drivers() │
    │  - check_driver_hos()     │
    │  - calculate_cost()       │
    └─────────────┬─────────────┘
                  │ (Context Returned)
                  ▼
          [ Cost Threshold Evaluation ]
           /                       \
   (Cost < $500)             (Cost >= $500)
         /                           \
[ Execute Action ]          [ HITL Approval Request ]
[ Update TMS DB  ]          [ Alert UI Dashboard    ]
```

---

## 3. Core Agentic Workflows & Tool Schemas

The Qwen3.7 Plus agent has access to a strictly typed suite of tools. During the POC phase, these are backed by local mock databases to ensure flawless demonstration during interviews.

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

Agentic automation in logistics carries severe financial and safety risks if unconstrained. The application implements a **Hard Cost Ceiling Guardrail**:

1. **Pre-Execution Hook:** Before any routing tool is executed, an internal `calculate_action_cost()` function evaluates the financial impact (extra fuel, driver overtime, 3PL carrier fees).
2. **Threshold Logic:**
   * If `Cost < $500`: The agent executes the route mutation autonomously.
   * If `Cost >= $500`: The agent state shifts to `PENDING_HUMAN_APPROVAL`.
3. **UI Resolution:** The Next.js dashboard renders an Action Card for the dispatcher, detailing the agent's reasoning, the cost breakdown, and `[Approve]` or `[Reject]` buttons.

---

## 5. Unit Economics & Rationale for Qwen3.7 Plus

To align with Teoh Capital's focus on SaaS margins, Qwen3.7 Plus was deliberately chosen over GPT-4o or Claude 3.5 Sonnet.

* **Context Window:** 1,000,000 tokens (Crucial for reading 50+ page freight carrier PDFs).
* **Cost Efficiency:** ~$0.40 Input / ~$1.60 Output per 1M tokens.
* **Margin Impact:** This represents an **85%+ reduction in inference costs** compared to OpenAI/Anthropic, transforming AI from a high-cost R&D expense into a high-margin product feature.
* **Agentic Capabilities:** Qwen3.7 Plus natively supports parallel tool calling, structured JSON output, and complex multi-step reasoning required by LangGraph and MCP architectures.

---

## 6. Implementation & Local Setup Guide

Follow these steps to run the interactive Next.js prototype locally.

### Prerequisites

* Node.js v20.x or higher
* `npm` or `yarn` package manager
* Qwen/OpenRouter API Key

### Step 1: Clone and Install

```bash
git clone https://github.com/your-username/dispatchops-ai.git
cd dispatchops-ai
npm install
```

### Step 2: Environment Variables

Create a `.env.local` file in the root directory:

```env
# OpenRouter or direct DashScope API Key for Qwen
QWEN_API_KEY=your_api_key_here
NEXT_PUBLIC_APP_URL=http://localhost:3000

# Guardrail settings
MAX_AUTONOMOUS_SPEND_USD=500
```

### Step 3: Run the Development Server

```bash
npm run dev
```

### Step 4: Using the Prototype

1. Navigate to `http://localhost:3000`.
2. Click the **"Simulate Telematics Exception"** button to trigger a mock GPS delay event.
3. Watch the real-time agent log as Qwen3.7 Plus formulates a plan, executes `query_nearby_drivers`, calculates costs, and resolves the delay.
4. Click **"Simulate Major Breakdown"** to test the Human-in-the-Loop guardrail (costs > $500).

---

## 7. Future Roadmap (Phase 2 & 3)

* **Week 5-8:** Replace mock tools with a production Model Context Protocol (MCP) server connecting directly to PostgreSQL TMS databases.
* **Week 9-12:** Integrate Twilio SMS webhooks to allow the agent to text drivers instructions dynamically.
* **Week 13+:** Self-host the Qwen ecosystem on dedicated Proxmox/vLLM servers via Cloudflare Tunnels for zero-variable-cost inference.
