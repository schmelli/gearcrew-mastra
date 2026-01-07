# GearGraph Hygiene Daemon - Project Scope Document

**Project Name:** gearcrew-mastra
**Version:** 1.0.0
**Last Updated:** January 2026
**Status:** Planning → Implementation

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Problem Statement](#2-problem-statement)
3. [Solution Overview](#3-solution-overview)
4. [System Architecture](#4-system-architecture)
5. [Agent Network Design](#5-agent-network-design)
6. [Memory System](#6-memory-system)
7. [Graph-Theoretic Integrity Checks](#7-graph-theoretic-integrity-checks)
8. [Workflow Definitions](#8-workflow-definitions)
9. [Tools Catalog](#9-tools-catalog)
10. [Guardrails & Safety](#10-guardrails--safety)
11. [Self-Improvement Mechanisms](#11-self-improvement-mechanisms)
12. [Data Models & Schemas](#12-data-models--schemas)
13. [API & Admin Interface](#13-api--admin-interface)
14. [Deployment Architecture](#14-deployment-architecture)
15. [Migration Strategy](#15-migration-strategy)
16. [Success Criteria](#16-success-criteria)
17. [Technology Stack](#17-technology-stack)
18. [Project Structure](#18-project-structure)
19. [Configuration Reference](#19-configuration-reference)
20. [Appendix: Code to Port](#20-appendix-code-to-port)

---

## 1. Executive Summary

### 1.1 Project Goal

Build a fully autonomous, 24/7 data hygiene daemon that maintains the GearGraph database (outdoor/hiking gear knowledge base) with minimal human intervention. The system will:

- Run continuously on the same server as Memgraph
- Automatically detect and fix data quality issues
- Learn from its decisions and human feedback
- Use graph-theoretic algorithms for structural integrity
- Only require human review for uncertain decisions (weekly batch)

### 1.2 Key Differentiators

| Current System (Python/Agno) | New System (TypeScript/Mastra) |
|------------------------------|--------------------------------|
| Manual UI clicks required | 24/7 autonomous daemon |
| No memory across sessions | Three-layer persistent memory |
| Rule-based + LLM hybrid | Algorithmic + LLM + Graph algorithms |
| No self-improvement | Pattern extraction + feedback loops |
| Single agent | Multi-agent network (7 agents) |
| No structural analysis | Centrality, WCC, community detection |

### 1.3 Vision: "Matrix Cocoon Robots"

Like the robots in The Matrix that maintain the cocoons, this agent works silently in the background, continuously improving data quality. You don't watch it work—you receive a weekly summary and occasionally approve decisions it's uncertain about.

---

## 2. Problem Statement

### 2.1 Current Data Quality Issues

The GearGraph database contains ~3,000+ gear items extracted from YouTube videos and web sources. Common issues include:

| Issue Type | Prevalence | Example |
|------------|------------|---------|
| Whitespace errors | ~15% | `"  Arc Haul Ultra "` |
| Case inconsistencies | ~20% | `"ZPACKS"` vs `"Zpacks"` |
| Generic brand terms | ~8% | Brand: `"Sleeping Bag"` |
| Transcription errors | ~12% | `"Thermorest"` → `"Therm-a-Rest"` |
| Duplicate items | ~10% | Same product with typos |
| Orphaned nodes | ~5% | Items with no relationships |
| Missing data | ~40% | No weight, price, or description |
| Conflicting values | ~3% | Different weights from different sources |

### 2.2 Why the Current System Fails

1. **Requires babysitting**: Every batch needs manual UI clicks
2. **No scheduling**: Can't run automatically
3. **No memory**: Forgets everything between sessions
4. **False positives**: Rule-based scanner suggests wrong fixes (e.g., "Big Agnes Big House" → "House")
5. **No learning**: Same mistakes repeat
6. **No structural analysis**: Can't detect graph-wide issues

### 2.3 Business Impact

- **Time wasted**: 2-3 hours/week manually reviewing issues
- **Data quality degradation**: Without constant maintenance, quality drops
- **User trust**: Incorrect data damages credibility
- **Scalability**: Can't handle growth in data volume

---

## 3. Solution Overview

### 3.1 Core Principles

1. **Autonomous by default**: Runs 24/7 without human intervention
2. **Conservative fixes**: Only auto-fix when confident; flag uncertain cases
3. **Full auditability**: Every decision logged with reasoning
4. **Self-improvement**: Learns from approved/rejected fixes
5. **Mathematical rigor**: Graph algorithms for structural integrity (not just LLM intuition)
6. **Graceful degradation**: Continues operating even if components fail

### 3.2 Processing Philosophy

```
                    ┌─────────────────────────┐
                    │    Incoming Item        │
                    └───────────┬─────────────┘
                                │
                    ┌───────────▼─────────────┐
                    │   Algorithmic Checks    │
                    │   (deterministic)       │
                    │   - Whitespace          │
                    │   - Schema validation   │
                    │   - Centrality metrics  │
                    └───────────┬─────────────┘
                                │
              ┌─────────────────┼─────────────────┐
              │                 │                 │
              ▼                 ▼                 ▼
        ┌───────────┐   ┌───────────┐   ┌───────────┐
        │ Auto-Fix  │   │ LLM Judge │   │ Research  │
        │ (>95%)    │   │ (70-95%)  │   │ (<70%)    │
        └─────┬─────┘   └─────┬─────┘   └─────┬─────┘
              │               │               │
              │               ▼               │
              │        ┌───────────┐         │
              │        │   Flag    │         │
              │        │ for Review│         │
              │        └───────────┘         │
              │                               │
              └───────────────┬───────────────┘
                              │
                    ┌─────────▼─────────┐
                    │   Log Decision    │
                    │   + Update Memory │
                    └───────────────────┘
```

---

## 4. System Architecture

### 4.1 High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Docker Container: gearcrew-mastra                 │
├─────────────────────────────────────────────────────────────────────┤
│  ┌─────────────────┐   ┌─────────────────┐   ┌─────────────────┐   │
│  │   Scheduler     │   │   Health API    │   │   Admin API     │   │
│  │   (node-cron)   │   │   (:8080)       │   │   (:8081)       │   │
│  └────────┬────────┘   └────────┬────────┘   └────────┬────────┘   │
│           │                     │                     │             │
│           └─────────────────────┼─────────────────────┘             │
│                                 │                                   │
│  ┌──────────────────────────────▼────────────────────────────────┐ │
│  │                      Mastra Core Instance                      │ │
│  │  ┌──────────────────┐  ┌──────────────────┐                   │ │
│  │  │ PostgresStore    │  │ Memory System    │                   │ │
│  │  │ (workflow state) │  │ (LibSQL+Vector)  │                   │ │
│  │  │ /data/state.db   │  │ /data/memory.db  │                   │ │
│  │  └──────────────────┘  └──────────────────┘                   │ │
│  └───────────────────────────────────────────────────────────────┘ │
│                                 │                                   │
│  ┌──────────────────────────────▼────────────────────────────────┐ │
│  │                       Agent Network                            │ │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐         │ │
│  │  │Orchestrator│ │ Triage  │ │Evaluator │ │  Fixer   │         │ │
│  │  │ (Sonnet)  │ │ (Haiku) │ │ (Sonnet) │ │ (Sonnet) │         │ │
│  │  └──────────┘ └──────────┘ └──────────┘ └──────────┘         │ │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐                       │ │
│  │  │Researcher│ │ Reviewer │ │ Learner  │                       │ │
│  │  │ (Sonnet) │ │ (Sonnet) │ │ (Sonnet) │                       │ │
│  │  └──────────┘ └──────────┘ └──────────┘                       │ │
│  │  ┌──────────────────────────────────────┐                     │ │
│  │  │        Analyst (Algorithmic)         │                     │ │
│  │  │  No LLM - Pure graph algorithms      │                     │ │
│  │  └──────────────────────────────────────┘                     │ │
│  └───────────────────────────────────────────────────────────────┘ │
│                                 │                                   │
├─────────────────────────────────┼───────────────────────────────────┤
│                    External Services                                │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐  │
│  │ Memgraph         │  │ Anthropic API    │  │ Firecrawl        │  │
│  │ (same server)    │  │ (Claude models)  │  │ (web research)   │  │
│  │ bolt://localhost │  │                  │  │                  │  │
│  └──────────────────┘  └──────────────────┘  └──────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

### 4.2 Data Flow

```
1. SCHEDULER triggers hygiene-cycle every 6 hours
           │
           ▼
2. TRIAGE AGENT queries Memgraph for items needing hygiene
   - Calculates hygiene score per item
   - Assigns priority (P1-P5)
   - Returns sorted queue
           │
           ▼
3. ANALYST runs graph algorithms (no LLM)
   - Degree centrality (supernode detection)
   - WCC (orphan island detection)
   - Schema validation
   - Flags structural issues
           │
           ▼
4. For each item in queue:
   │
   ├─► P1 (Instant): EVALUATOR runs deterministic checks
   │   - Whitespace? → Auto-fix
   │   - Case issues? → Auto-fix
   │
   ├─► P2 (Quick): EVALUATOR uses LLM judgment
   │   - Brand validity? → LLM decides
   │   - Brand in name? → LLM decides
   │   - Confidence ≥90%? → Auto-fix
   │   - Confidence <90%? → Flag for review
   │
   ├─► P3 (Context): EVALUATOR queries graph
   │   - Brand exists? → Count items
   │   - Duplicates? → Fuzzy match
   │   - Always flag for review
   │
   ├─► P4 (Research): RESEARCHER searches web
   │   - Verify brand → Firecrawl
   │   - Find missing weight → Firecrawl
   │   - Flag for review with findings
   │
   └─► P5 (Deep): Flag everything for review
       - Orphaned nodes
       - Missing provenance
       - Data completeness
           │
           ▼
5. FIXER AGENT applies approved fixes to Memgraph
           │
           ▼
6. All decisions logged to EPISODIC MEMORY
           │
           ▼
7. Weekly: REVIEWER AGENT sends batch review email
           │
           ▼
8. Daily: LEARNER AGENT extracts patterns from feedback
   - Updates confidence calibration
   - Adds new transcription error mappings
   - Stores in SEMANTIC MEMORY
```

### 4.3 Persistence Architecture

```
/data/
├── state.db          # SQLite - Workflow checkpoints, run history
├── memory.db         # LibSQL - Episodic + Semantic memory
├── vector.db         # LibSQL Vector - Embeddings for semantic recall
├── audit.log         # JSONL - Immutable audit trail
├── metrics.json      # Prometheus metrics snapshot
└── config/
    ├── thresholds.json    # Confidence thresholds (mutable)
    ├── patterns.json      # Learned patterns (auto-updated)
    └── calibration.json   # Confidence calibration factors
```

---

## 5. Agent Network Design

### 5.1 Orchestrator Agent

**Role:** Coordinates all other agents, manages workflow execution

```typescript
{
  id: "hygiene-orchestrator",
  model: "claude-sonnet-4-20250514",
  capabilities: [
    "Delegate tasks to specialized agents",
    "Monitor workflow progress",
    "Handle errors and retries",
    "Manage rate limits",
    "Escalate to human review"
  ],
  tools: [
    "delegateToAgent",
    "startWorkflow",
    "checkWorkflowStatus",
    "sendNotification"
  ],
  memory: "full access to all memory layers"
}
```

### 5.2 Triage Agent

**Role:** Score and prioritize items for processing

```typescript
{
  id: "hygiene-triage",
  model: "claude-haiku-4-20250514",  // Fast, cheap for simple scoring
  capabilities: [
    "Calculate hygiene scores",
    "Assign priorities P1-P5",
    "Identify quick wins",
    "Detect high-risk items"
  ],
  tools: [
    "queryItems",
    "calculateHygieneScore",
    "assignPriority",
    "getItemRelationships"
  ],
  output: {
    items: "QueueItem[]",
    statistics: {
      total: "number",
      byPriority: "Record<Priority, number>",
      avgScore: "number"
    }
  }
}
```

### 5.3 Evaluator Agent

**Role:** Assess individual items for specific issues

```typescript
{
  id: "hygiene-evaluator",
  model: "claude-sonnet-4-20250514",
  capabilities: [
    "Run P1 deterministic checks",
    "Apply LLM judgment for P2",
    "Query graph context for P3",
    "Recommend fixes with confidence"
  ],
  tools: [
    "checkWhitespace",
    "checkCaseNormalization",
    "checkBrandValidity",
    "checkBrandInName",
    "checkTranscriptionErrors",
    "findDuplicates",
    "checkDataCompleteness"
  ],
  output: {
    issueFound: "boolean",
    confidence: "number (0-1)",
    reasoning: "string",
    recommendedFix: "Fix | null",
    decision: "auto_fix | flag_review | skip"
  },
  context: {
    domainKnowledge: "Outdoor gear brands, product naming conventions",
    examples: [
      "'Big Agnes Big House 6' is VALID - 'Big House' is the product name",
      "'Zpacks' not 'Zpack' or 'Z-Packs'",
      "'Therm-a-Rest' not 'Thermorest' or 'Thermarest'"
    ]
  }
}
```

### 5.4 Fixer Agent

**Role:** Apply approved fixes to the database

```typescript
{
  id: "hygiene-fixer",
  model: "claude-sonnet-4-20250514",
  capabilities: [
    "Apply field updates",
    "Standardize brands across items",
    "Create missing relationships",
    "Clear invalid values"
  ],
  tools: [
    "updateField",
    "standardizeBrand",
    "createRelationship",
    "clearField",
    "mergeDuplicates"  // Only with human approval
  ],
  safety: {
    requiresApproval: ["mergeDuplicates", "deleteEntity"],
    maxChangesPerRun: 100,
    dryRunMode: "configurable"
  }
}
```

### 5.5 Researcher Agent

**Role:** Find missing information via web search

```typescript
{
  id: "hygiene-researcher",
  model: "claude-sonnet-4-20250514",
  capabilities: [
    "Verify brand legitimacy",
    "Find product specifications",
    "Research missing weights/prices",
    "Validate product URLs"
  ],
  tools: [
    "searchWeb",           // Firecrawl
    "scrapeProductPage",   // Firecrawl
    "verifyBrandOnline",
    "findProductSpecs"
  ],
  rateLimits: {
    firecrawl: "20 req/min",
    cacheResults: "24 hours"
  }
}
```

### 5.6 Reviewer Agent

**Role:** Manage human review queue

```typescript
{
  id: "hygiene-reviewer",
  model: "claude-sonnet-4-20250514",
  capabilities: [
    "Compile review queue",
    "Prioritize review items",
    "Format review notifications",
    "Process human feedback"
  ],
  tools: [
    "getReviewQueue",
    "formatReviewEmail",
    "sendNotification",
    "processFeedback",
    "applyApprovedFixes"
  ],
  schedule: {
    batchReview: "Monday 9am UTC",
    urgentItems: "immediate notification"
  }
}
```

### 5.7 Learner Agent

**Role:** Extract patterns and calibrate confidence

```typescript
{
  id: "hygiene-learner",
  model: "claude-sonnet-4-20250514",
  capabilities: [
    "Analyze approved fixes",
    "Identify rejected patterns",
    "Extract transcription errors",
    "Calibrate confidence factors"
  ],
  tools: [
    "queryDecisionHistory",
    "extractPatterns",
    "updateCalibration",
    "storeLearnedPattern"
  ],
  learning: {
    minOccurrences: 3,          // Pattern must appear 3+ times
    minSuccessRate: 0.9,        // 90%+ approval rate
    calibrationDampening: 0.95  // 5% reduction per rejection
  }
}
```

### 5.8 Analyst Agent (Algorithmic - No LLM)

**Role:** Graph-theoretic structural analysis

```typescript
{
  id: "hygiene-analyst",
  model: null,  // No LLM - pure algorithms
  capabilities: [
    "Compute centrality metrics",
    "Detect orphan islands (WCC)",
    "Run community detection",
    "Validate schema constraints",
    "Detect contradictions"
  ],
  algorithms: {
    degreeCentrality: "Flag nodes with degree >3σ above mean",
    betweennessCentrality: "Identify critical bridge nodes",
    weaklyConnectedComponents: "Find orphan islands",
    communityDetection: "Louvain algorithm for clustering",
    schemaValidation: "SHACL-style constraint checking"
  },
  output: {
    supernodes: "Node[] - potential merge errors",
    bridgeNodes: "Node[] - critical nodes",
    orphanIslands: "Component[] - disconnected clusters",
    misclassified: "Node[] - wrong cluster membership",
    schemaViolations: "Violation[] - constraint failures"
  }
}
```

---

## 6. Memory System

### 6.1 Three-Layer Architecture

```
┌────────────────────────────────────────────────────────────────┐
│                    WORKING MEMORY                               │
│                    (per-session)                                │
│  ┌────────────────────────────────────────────────────────┐   │
│  │ Current Session State:                                  │   │
│  │ - Session ID, started at, items processed               │   │
│  │ - Current item being evaluated                          │   │
│  │ - Recent decisions (last 50)                            │   │
│  │ - Rate limit status, error counts                       │   │
│  │ - Learned patterns applied this session                 │   │
│  └────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────┐
│                    EPISODIC MEMORY                              │
│                    (decision logs)                              │
│  ┌────────────────────────────────────────────────────────┐   │
│  │ Decision Log Entry:                                     │   │
│  │ - ID, timestamp, entity_id, entity_name                 │   │
│  │ - Check ID, priority level                              │   │
│  │ - Decision: auto_fixed | flagged | skipped              │   │
│  │ - Confidence score, reasoning                           │   │
│  │ - Fix applied (if any)                                  │   │
│  │ - Human review outcome (if any)                         │   │
│  │ - Graph context at decision time                        │   │
│  └────────────────────────────────────────────────────────┘   │
│  - Queryable by entity, check type, date range, outcome       │
│  - Enables audit trail and learning                           │
└────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────┐
│                    SEMANTIC MEMORY                              │
│                    (learned knowledge)                          │
│  ┌────────────────────────────────────────────────────────┐   │
│  │ Learned Patterns:                                       │   │
│  │ - Transcription error mappings (Thermorest→Therm-a-Rest)│   │
│  │ - Brand canonicalization (zpacks→Zpacks)                │   │
│  │ - Confidence calibration factors per check type         │   │
│  │ - Product relationship patterns                         │   │
│  │ - Domain knowledge (valid categories, typical weights)  │   │
│  └────────────────────────────────────────────────────────┘   │
│  - Vector-indexed for semantic retrieval                      │
│  - Updated daily by Learner Agent                             │
└────────────────────────────────────────────────────────────────┘
```

### 6.2 Working Memory Template

```markdown
# GearGraph Hygiene Agent - Working Memory

## Session Context
- **Session ID**: {{session_id}}
- **Started**: {{started_at}}
- **Mode**: {{mode}} (hygiene_cycle | batch_review | learning)

## Processing State
- **Items Processed**: {{processed_count}} / {{total_count}}
- **Current Item**:
  - Entity: {{current_entity_id}} - {{current_entity_name}}
  - Brand: {{current_brand}}
  - Priority: {{current_priority}}
  - Checks Remaining: {{remaining_checks}}

## Session Statistics
- **Auto-Fixed**: {{auto_fixed_count}}
- **Flagged for Review**: {{flagged_count}}
- **Skipped (No Issue)**: {{skipped_count}}
- **Errors**: {{error_count}}

## Rate Limit Status
- **Anthropic API**: {{anthropic_remaining}} / {{anthropic_limit}} (resets {{anthropic_reset}})
- **Firecrawl**: {{firecrawl_remaining}} / {{firecrawl_limit}} (resets {{firecrawl_reset}})
- **Memgraph**: {{memgraph_qps}} queries/sec

## Recent Decisions (for context)
{{#each recent_decisions}}
- [{{this.timestamp}}] {{this.entity_name}}: {{this.decision}} ({{this.check_id}}, confidence: {{this.confidence}})
{{/each}}

## Patterns Applied This Session
{{#each applied_patterns}}
- {{this.pattern_type}}: {{this.source}} → {{this.target}} ({{this.applications}} times)
{{/each}}

## Alerts
{{#each alerts}}
- [{{this.level}}] {{this.message}}
{{/each}}
```

### 6.3 Memory Configuration

```typescript
// src/memory/index.ts
import { Memory } from "@mastra/memory";
import { LibSQLStore, LibSQLVector } from "@mastra/libsql";
import { openai } from "@ai-sdk/openai";

export const hygieneMemory = new Memory({
  storage: new LibSQLStore({
    url: "file:/data/memory.db",
  }),
  vector: new LibSQLVector({
    connectionUrl: "file:/data/vector.db",
  }),
  embedder: openai.embedding("text-embedding-3-small"),
  options: {
    lastMessages: 50,
    semanticRecall: {
      topK: 10,
      messageRange: { before: 3, after: 1 },
    },
    workingMemory: {
      enabled: true,
      template: WORKING_MEMORY_TEMPLATE,
    },
  },
});
```

---

## 7. Graph-Theoretic Integrity Checks

### 7.1 Centrality Metrics

#### Degree Centrality (Supernode Detection)

**Purpose:** Identify nodes with abnormally high connection count, which may indicate merge errors.

**Algorithm:**
```cypher
// Calculate degree for all nodes
MATCH (n)
WITH n, SIZE([(n)-[]-() | 1]) AS degree
WITH AVG(degree) AS mean, STDEV(degree) AS stddev
MATCH (n)
WITH n, SIZE([(n)-[]-() | 1]) AS degree, mean, stddev
WHERE degree > mean + 3 * stddev
RETURN n.name, labels(n), degree, mean, stddev
ORDER BY degree DESC
```

**Threshold:** Flag nodes with degree > mean + 3σ

**Example Issue:** A brand node "Generic" connected to 5,000 items (should be ~50 max) suggests many items were assigned to a catch-all brand.

#### Betweenness Centrality (Bridge Node Detection)

**Purpose:** Identify nodes whose removal would fragment the graph.

**Algorithm:** Use Memgraph's built-in betweenness centrality:
```cypher
CALL betweenness_centrality.get()
YIELD node, betweenness_centrality
WITH node, betweenness_centrality
WHERE betweenness_centrality > 0.1  // Top 10% influence
RETURN node.name, labels(node), betweenness_centrality
ORDER BY betweenness_centrality DESC
LIMIT 20
```

**Action:** Warn before modifying high-betweenness nodes; require human approval.

### 7.2 Weakly Connected Components (Orphan Detection)

**Purpose:** Find disconnected "islands" in the graph.

**Algorithm:**
```cypher
CALL weakly_connected_components.get()
YIELD node, component_id
WITH component_id, COLLECT(node) AS nodes, COUNT(*) AS size
ORDER BY size DESC
RETURN component_id, size,
       [n IN nodes[..5] | n.name] AS sample_nodes
```

**Expected Result:**
- Component 0: Main graph (~95% of nodes)
- Components 1-N: Orphan islands to investigate

**Action:**
- Islands with 1-3 nodes: Auto-flag for integration or deletion
- Islands with 4+ nodes: May be valid sub-graphs (e.g., a brand's product line)

### 7.3 Community Detection

**Purpose:** Identify clusters and detect misclassified nodes.

**Algorithm:** Louvain community detection:
```cypher
CALL community_detection.louvain()
YIELD node, community_id
WITH community_id,
     COLLECT({name: node.name, category: node.category}) AS members
RETURN community_id,
       SIZE(members) AS size,
       [m IN members | m.category] AS categories
```

**Anomaly Detection:**
- A node in a community where 95% of members have a different category
- Example: A "sleeping bag" in a cluster of "cookware" items

**Action:** Flag misclassified nodes for review.

### 7.4 Schema Validation (SHACL-Style)

**Purpose:** Enforce ontology constraints mathematically, not via LLM guessing.

**Shape Definitions:**

```typescript
// src/config/shapes.ts
export const GearItemShape = {
  nodeType: "GearItem",
  required: ["name", "category"],
  recommended: ["brand", "weight_grams"],
  constraints: {
    name: {
      type: "string",
      minLength: 2,
      maxLength: 200,
      pattern: "^[^\\s].*[^\\s]$"  // No leading/trailing whitespace
    },
    brand: {
      type: "string",
      notIn: GENERIC_TERMS  // Can't be "sleeping bag", "tent", etc.
    },
    weight_grams: {
      type: "integer",
      min: 1,
      max: 50000  // 50kg max
    },
    price_usd: {
      type: "number",
      min: 0.01,
      max: 10000
    },
    category: {
      enum: VALID_CATEGORIES
    },
  },
  relationships: {
    MANUFACTURED_BY: {
      target: "OutdoorBrand",
      cardinality: "0..1"  // Optional, but max 1
    },
    EXTRACTED_FROM: {
      target: "VideoSource",
      cardinality: "1..*"  // Required, at least 1
    },
  }
};

export const OutdoorBrandShape = {
  nodeType: "OutdoorBrand",
  required: ["name"],
  constraints: {
    name: {
      type: "string",
      minLength: 2,
      maxLength: 100,
    },
  },
  relationships: {
    MANUFACTURES_ITEM: {
      target: "GearItem",
      cardinality: "1..*"  // Must have at least 1 product
    }
  }
};
```

**Validation Query:**
```cypher
// Find GearItems violating weight constraints
MATCH (g:GearItem)
WHERE g.weight_grams IS NOT NULL
  AND (g.weight_grams < 1 OR g.weight_grams > 50000)
RETURN g.name, g.weight_grams, "weight_out_of_range" AS violation

UNION

// Find GearItems with generic brand terms
MATCH (g:GearItem)
WHERE toLower(g.brand) IN ["sleeping bag", "tent", "backpack", "gear"]
RETURN g.name, g.brand, "generic_brand" AS violation

UNION

// Find GearItems without any source
MATCH (g:GearItem)
WHERE NOT (g)-[:EXTRACTED_FROM]->(:VideoSource)
RETURN g.name, null, "missing_source" AS violation
```

### 7.5 Contradiction Resolution

**Temporal Resolution:**
```cypher
// Find items with multiple values for same field at different times
MATCH (g:GearItem)-[:HAS_FIELD_SOURCE]->(s1:FieldSource)
MATCH (g)-[:HAS_FIELD_SOURCE]->(s2:FieldSource)
WHERE s1.fieldName = s2.fieldName
  AND s1.value <> s2.value
  AND s1.extractedAt <> s2.extractedAt
RETURN g.name, s1.fieldName,
       s1.value, s1.extractedAt,
       s2.value, s2.extractedAt
ORDER BY g.name, s1.fieldName
```

**Resolution Strategy:**
1. If timestamps differ significantly (>6 months): Treat as product revision history
2. If timestamps are close: Use source trust ranking

**Source Trust Ranking:**
```typescript
const SOURCE_TRUST = {
  "manufacturer_website": 1.0,
  "rei_specs": 0.95,
  "outdoor_gear_lab": 0.9,
  "youtube_description": 0.7,
  "youtube_transcript": 0.6,
  "user_comment": 0.4,
};
```

---

## 8. Workflow Definitions

### 8.1 Hygiene Cycle Workflow

**Trigger:** Every 6 hours (cron: `0 */6 * * *`)

**Steps:**
```
1. [triage]
   - Query 100 items from Memgraph
   - Calculate hygiene scores
   - Assign priorities
   - Return sorted queue

2. [analyze] (parallel with triage results)
   - Run centrality metrics
   - Detect orphan islands
   - Run schema validation
   - Add structural issues to queue

3. [process] (foreach item in queue)
   - 3a. [evaluate]
        - Run checks based on priority
        - Determine confidence
        - Recommend action
   - 3b. [decide]
        - Apply guardrails
        - Auto-fix if confident
        - Flag if uncertain
   - 3c. [execute]
        - Apply fix to Memgraph
        - Log decision to memory
   - 3d. [checkpoint]
        - Save workflow state

4. [summarize]
   - Compile statistics
   - Update metrics
   - Log completion
```

**Workflow Definition:**
```typescript
// src/workflows/hygiene-cycle.ts
export const hygieneCycleWorkflow = createWorkflow({
  id: "hygiene-cycle",
  inputSchema: z.object({
    batchSize: z.number().default(50),
    priorityFilter: z.array(z.enum(["P1", "P2", "P3", "P4", "P5"])).optional(),
    dryRun: z.boolean().default(false),
  }),
  outputSchema: z.object({
    itemsProcessed: z.number(),
    autoFixed: z.number(),
    flaggedForReview: z.number(),
    errors: z.number(),
    duration: z.number(),
  }),
})
  .then(triageStep)
  .then(analyzeStep)
  .foreach(
    (ctx) => ctx.getStepResult("triage").items,
    processItemWorkflow
  )
  .then(summarizeStep)
  .commit();
```

### 8.2 Graph Analysis Workflow

**Trigger:** Daily at 3am UTC (cron: `0 3 * * *`)

**Steps:**
```
1. [centrality]
   - Compute degree centrality
   - Compute betweenness centrality
   - Flag supernodes (>3σ)
   - Flag bridge nodes (>0.1)

2. [components]
   - Run WCC algorithm
   - Identify main component
   - List orphan islands
   - Flag islands for review

3. [community]
   - Run Louvain detection
   - Analyze cluster composition
   - Flag misclassified nodes

4. [validate]
   - Run schema validation
   - Check all constraints
   - Generate violation report

5. [report]
   - Compile findings
   - Add to review queue
   - Update metrics
```

### 8.3 Batch Review Workflow

**Trigger:** Monday 9am UTC (cron: `0 9 * * 1`)

**Steps:**
```
1. [compile]
   - Query all flagged items from past week
   - Group by issue type
   - Prioritize by severity

2. [format]
   - Generate HTML email
   - Generate Slack blocks
   - Include context for each item

3. [send]
   - Send email notification
   - Post to Slack channel

4. [await]
   - Monitor for responses
   - Process feedback via webhook

5. [apply]
   - Apply approved fixes
   - Mark rejected as reviewed
   - Update learner with feedback
```

### 8.4 Learning Cycle Workflow

**Trigger:** Daily at midnight UTC (cron: `0 0 * * *`)

**Steps:**
```
1. [gather]
   - Query decisions from past 7 days
   - Filter to human-reviewed only
   - Separate approved vs rejected

2. [extract]
   - Identify transcription error patterns
   - Identify brand mapping patterns
   - Calculate success rates

3. [validate]
   - Filter patterns with ≥3 occurrences
   - Filter patterns with ≥90% success rate

4. [calibrate]
   - Adjust confidence factors per check type
   - Apply dampening for rejections

5. [store]
   - Store new patterns in semantic memory
   - Update calibration config
   - Log learning summary
```

---

## 9. Tools Catalog

### 9.1 Evaluation Tools

| Tool ID | Purpose | Input | Output | LLM? |
|---------|---------|-------|--------|------|
| `checkWhitespace` | Detect whitespace issues | `{name, brand}` | `{hasIssue, fix}` | No |
| `checkCaseNormalization` | Detect case issues | `{name, brand}` | `{hasIssue, fix}` | No |
| `checkBrandValidity` | Is brand a generic term? | `{brand, name}` | `{isGeneric, confidence, reasoning}` | Yes |
| `checkBrandInName` | Is brand redundantly in name? | `{brand, name}` | `{isRedundant, confidence, reasoning}` | Yes |
| `checkTranscriptionErrors` | Match known error patterns | `{name, brand}` | `{hasError, correction}` | No |
| `findDuplicates` | Fuzzy match similar items | `{name, brand}` | `{matches[], confidence[]}` | No |
| `checkDataCompleteness` | Calculate completeness score | `{item}` | `{score, missingFields[]}` | No |
| `checkOrphanedNode` | Has required relationships? | `{entityId}` | `{isOrphaned, missingRels[]}` | No |
| `checkProvenance` | Has source tracking? | `{entityId}` | `{hasProvenance, missingFields[]}` | No |

### 9.2 Fix Tools

| Tool ID | Purpose | Input | Output | Approval? |
|---------|---------|-------|--------|-----------|
| `updateField` | Update single field | `{entityId, field, value}` | `{success}` | No |
| `standardizeBrand` | Update brand across items | `{oldBrand, newBrand}` | `{updatedCount}` | No |
| `createRelationship` | Add missing relationship | `{fromId, toId, relType}` | `{success}` | No |
| `clearField` | Set field to null | `{entityId, field}` | `{success}` | No |
| `mergeDuplicates` | Merge two items | `{sourceId, targetId}` | `{success}` | **Yes** |
| `deleteEntity` | Remove node | `{entityId}` | `{success}` | **Yes** |

### 9.3 Research Tools

| Tool ID | Purpose | Input | Output | Rate Limit |
|---------|---------|-------|--------|------------|
| `searchWeb` | General web search | `{query}` | `{results[]}` | 20/min |
| `verifyBrandOnline` | Is brand legitimate? | `{brand}` | `{verified, confidence, sources[]}` | 10/min |
| `findProductSpecs` | Find specifications | `{name, brand}` | `{specs}` | 10/min |
| `scrapeProductPage` | Extract from URL | `{url}` | `{data}` | 5/min |

### 9.4 Graph Algorithm Tools

| Tool ID | Purpose | Input | Output | Complexity |
|---------|---------|-------|--------|------------|
| `computeDegreeCentrality` | Node connection count | `{nodeType?}` | `{nodes[], degrees[]}` | O(V+E) |
| `computeBetweenness` | Bridge node detection | `{nodeType?}` | `{nodes[], scores[]}` | O(V*E) |
| `findConnectedComponents` | Orphan island detection | `{}` | `{components[]}` | O(V+E) |
| `detectCommunities` | Cluster analysis | `{algorithm}` | `{communities[]}` | O(V*log(V)) |
| `validateSchema` | Check constraints | `{shape}` | `{violations[]}` | O(V) |
| `findContradictions` | Conflicting values | `{field}` | `{conflicts[]}` | O(V) |

---

## 10. Guardrails & Safety

### 10.1 Confidence Thresholds

| Priority | Base Threshold | Auto-Fix Behavior |
|----------|----------------|-------------------|
| P1 | 0.95 | Auto-fix if confidence ≥ threshold |
| P2 | 0.90 | Auto-fix if confidence ≥ threshold |
| P3 | 1.00 | Never auto-fix (always flag) |
| P4 | 1.00 | Never auto-fix (always flag) |
| P5 | 1.00 | Never auto-fix (always flag) |

**Calibrated Threshold:**
```
effective_threshold = base_threshold × calibration_factor

calibration_factor starts at 1.0
- Approved fix: factor += 0.01 (max 1.1)
- Rejected fix: factor *= 0.95 (min 0.8)
```

### 10.2 Actions Requiring Human Approval

| Action | Risk Level | Reason |
|--------|------------|--------|
| `mergeDuplicates` | High | Data loss if wrong |
| `deleteEntity` | Critical | Irreversible |
| `reassignBrand` | Medium | Major property change |
| `changeCategory` | Medium | Major property change |
| `modifyBridgeNode` | High | May fragment graph |

### 10.3 Rate Limits

| Service | Limit | Window | Behavior on Exceed |
|---------|-------|--------|-------------------|
| Anthropic API | 60 req | 1 min | Queue with exponential backoff |
| Firecrawl | 20 req | 1 min | Queue with backoff |
| Memgraph | 100 queries | 1 sec | Batch queries |

### 10.4 Circuit Breakers

| Condition | Threshold | Action |
|-----------|-----------|--------|
| Error rate | >10% in 5 min | Pause processing, alert |
| API failures | >5 consecutive | Switch to degraded mode |
| Fix rejections | >20% in batch | Pause, request calibration review |
| Memory usage | >80% | Flush caches, GC |

### 10.5 Audit Trail

Every decision is logged with:
```typescript
interface AuditEntry {
  id: string;
  timestamp: Date;
  workflowRunId: string;
  sessionId: string;

  // What was evaluated
  entityId: string;
  entityName: string;
  entityType: string;

  // What was decided
  checkId: string;
  decision: "auto_fixed" | "flagged" | "skipped" | "error";
  confidence: number;
  reasoning: string;

  // What was changed (if any)
  fix?: {
    field: string;
    oldValue: unknown;
    newValue: unknown;
  };

  // Context
  graphContext: Record<string, unknown>;
  patternsApplied: string[];

  // Human review (populated later)
  humanReview?: {
    reviewedAt: Date;
    approved: boolean;
    notes: string;
  };
}
```

---

## 11. Self-Improvement Mechanisms

### 11.1 Pattern Extraction

**Transcription Error Patterns:**
```typescript
// Extracted from approved fixes
{
  patternType: "transcription_error",
  source: "Thermorest",
  target: "Therm-a-Rest",
  occurrences: 15,
  successRate: 1.0,
  sources: ["decision_123", "decision_456", ...]
}
```

**Brand Canonicalization:**
```typescript
{
  patternType: "brand_canonical",
  source: "zpacks",   // Any case
  target: "Zpacks",   // Canonical
  occurrences: 42,
  successRate: 0.98,
}
```

### 11.2 Feedback Loop Integration

```
Human approves fix
        │
        ▼
┌───────────────────┐
│ Record feedback   │
│ in episodic memory│
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│ Update confidence │
│ calibration       │
│ factor += 0.01    │
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│ Check pattern     │
│ threshold (≥3, ≥90%)
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│ If meets threshold:│
│ Store in semantic │
│ memory            │
└───────────────────┘
```

### 11.3 Confidence Calibration

```typescript
interface CalibrationState {
  checkId: string;
  baseFactor: 1.0;
  currentFactor: number;  // 0.8 - 1.1
  approvalCount: number;
  rejectionCount: number;
  lastUpdated: Date;
}

// Update logic
function updateCalibration(checkId: string, approved: boolean) {
  const state = getCalibration(checkId);

  if (approved) {
    state.approvalCount++;
    state.currentFactor = Math.min(1.1, state.currentFactor + 0.01);
  } else {
    state.rejectionCount++;
    state.currentFactor = Math.max(0.8, state.currentFactor * 0.95);
  }

  state.lastUpdated = new Date();
  saveCalibration(state);
}
```

### 11.4 Drift Prevention

**Monitoring:**
- Track precision/recall per check type weekly
- Alert if metrics drop >5% from baseline
- Require human review of learning if flagged

**Guardrails:**
- Pattern must have ≥3 occurrences before being applied
- Pattern must have ≥90% success rate
- Calibration factor bounded [0.8, 1.1]
- Full pattern audit logged

---

## 12. Data Models & Schemas

### 12.1 Queue Item

```typescript
interface QueueItem {
  sortPriority: number;  // priority * 1000 + (1 - hygieneScore) * 100
  entityId: string;
  entityName: string;
  entityBrand: string | null;
  entityCategory: string | null;
  priority: "P1" | "P2" | "P3" | "P4" | "P5";
  hygieneScore: number;  // 0.0 (needs work) to 1.0 (clean)
  checksToRun: string[];
  graphContext: {
    hasSources: boolean;
    hasInsights: boolean;
    relationshipCount: number;
  };
}
```

### 12.2 Evaluation Result

```typescript
interface EvaluationResult {
  entityId: string;
  checkId: string;
  issueFound: boolean;
  confidence: number;
  reasoning: string;
  recommendedFix: Fix | null;
  graphContext: Record<string, unknown>;
  webResearchUsed: boolean;
}
```

### 12.3 Fix

```typescript
interface Fix {
  type: "field_update" | "relationship_create" | "brand_standardize" | "merge";
  entityId: string;
  field?: string;
  oldValue?: unknown;
  newValue?: unknown;
  targetEntityId?: string;  // For merge
  relationshipType?: string;  // For relationship_create
}
```

### 12.4 Decision

```typescript
interface Decision {
  action: "auto_fix" | "flag_for_review" | "skip";
  reason: string;
  fix?: Fix;
  requiresApproval: boolean;
}
```

### 12.5 Learned Pattern

```typescript
interface LearnedPattern {
  id: string;
  patternType: "transcription_error" | "brand_canonical" | "confidence_adjustment";
  sourcePattern: string;
  targetPattern: string;
  occurrences: number;
  successRate: number;
  lastUsed: Date;
  createdFrom: string[];  // Decision IDs
  active: boolean;
}
```

---

## 13. API & Admin Interface

### 13.1 Health Endpoints (Port 8080)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Overall health status |
| `/health/storage` | GET | Storage health |
| `/health/memgraph` | GET | Memgraph connection |
| `/health/memory` | GET | Memory system |
| `/ready` | GET | Readiness probe |
| `/live` | GET | Liveness probe |

**Health Response:**
```json
{
  "status": "healthy",
  "timestamp": "2026-01-06T12:00:00Z",
  "components": {
    "storage": { "status": "ok", "latency": 5 },
    "memgraph": { "status": "ok", "latency": 12 },
    "memory": { "status": "ok", "size": "256MB" }
  },
  "metrics": {
    "uptime": 86400,
    "workflowsCompleted": 24,
    "itemsProcessed": 1200,
    "autoFixed": 450,
    "flagged": 150
  }
}
```

### 13.2 Admin Endpoints (Port 8081)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/admin/workflows` | GET | List workflow runs |
| `/admin/workflows/:id` | GET | Get workflow details |
| `/admin/workflows/:id/resume` | POST | Resume suspended workflow |
| `/admin/trigger/:workflow` | POST | Manually trigger workflow |
| `/admin/review-queue` | GET | List items awaiting review |
| `/admin/review/:id/approve` | POST | Approve a fix |
| `/admin/review/:id/reject` | POST | Reject a fix |
| `/admin/metrics` | GET | Prometheus metrics |
| `/admin/config` | GET | Current configuration |
| `/admin/config` | PATCH | Update configuration |
| `/admin/patterns` | GET | List learned patterns |
| `/admin/calibration` | GET | Confidence calibration state |

### 13.3 Metrics (Prometheus Format)

```
# HELP hygiene_items_processed Total items processed
# TYPE hygiene_items_processed counter
hygiene_items_processed{priority="P1"} 450
hygiene_items_processed{priority="P2"} 320
hygiene_items_processed{priority="P3"} 180
hygiene_items_processed{priority="P4"} 90
hygiene_items_processed{priority="P5"} 60

# HELP hygiene_auto_fixed Total items auto-fixed
# TYPE hygiene_auto_fixed counter
hygiene_auto_fixed{check="whitespace"} 120
hygiene_auto_fixed{check="case"} 85
hygiene_auto_fixed{check="brand_validity"} 45

# HELP hygiene_flagged_for_review Items flagged for human review
# TYPE hygiene_flagged_for_review counter
hygiene_flagged_for_review{check="duplicate"} 45
hygiene_flagged_for_review{check="merge"} 12

# HELP hygiene_confidence_calibration Current calibration factor
# TYPE hygiene_confidence_calibration gauge
hygiene_confidence_calibration{check="brand_validity"} 0.95
hygiene_confidence_calibration{check="brand_in_name"} 1.02

# HELP hygiene_workflow_duration_seconds Workflow execution time
# TYPE hygiene_workflow_duration_seconds histogram
hygiene_workflow_duration_seconds_bucket{workflow="hygiene_cycle",le="60"} 2
hygiene_workflow_duration_seconds_bucket{workflow="hygiene_cycle",le="300"} 15
hygiene_workflow_duration_seconds_bucket{workflow="hygiene_cycle",le="600"} 24
```

---

## 14. Deployment Architecture

### 14.1 Docker Configuration

**Dockerfile:**
```dockerfile
FROM node:20-slim AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-slim AS runner

WORKDIR /app

# Create data directory
RUN mkdir -p /data

# Copy built application
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# Copy prompts
COPY prompts ./prompts

# Environment
ENV NODE_ENV=production
ENV DATA_DIR=/data

# Expose ports
EXPOSE 8080 8081

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s \
  CMD curl -f http://localhost:8080/health || exit 1

# Run
CMD ["node", "dist/index.js"]
```

**docker-compose.yml:**
```yaml
version: '3.8'

services:
  hygiene-daemon:
    build: .
    container_name: gearcrew-mastra
    restart: unless-stopped
    ports:
      - "8080:8080"  # Health
      - "8081:8081"  # Admin
    volumes:
      - hygiene-data:/data
    environment:
      - NODE_ENV=production
      - MEMGRAPH_URI=bolt://localhost:7687
      - MEMGRAPH_USER=${MEMGRAPH_USER}
      - MEMGRAPH_PASSWORD=${MEMGRAPH_PASSWORD}
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      - FIRECRAWL_API_KEY=${FIRECRAWL_API_KEY}
      - LANGWATCH_API_KEY=${LANGWATCH_API_KEY}
      - NOTIFICATION_EMAIL=${NOTIFICATION_EMAIL}
      - SLACK_WEBHOOK_URL=${SLACK_WEBHOOK_URL}
    network_mode: host  # Same network as Memgraph
    logging:
      driver: json-file
      options:
        max-size: "100m"
        max-file: "3"

volumes:
  hygiene-data:
```

### 14.2 Network Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Server (same machine)                     │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌───────────────────────┐   ┌───────────────────────────┐ │
│  │   Memgraph            │   │   gearcrew-mastra         │ │
│  │   (existing)          │   │   (new daemon)            │ │
│  │                       │   │                           │ │
│  │   bolt://localhost:7687│◄──│   bolt://localhost:7687  │ │
│  │                       │   │                           │ │
│  │   :7444 (Lab)         │   │   :8080 (Health)          │ │
│  │                       │   │   :8081 (Admin)           │ │
│  └───────────────────────┘   └───────────────────────────┘ │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 14.3 Resource Requirements

| Resource | Minimum | Recommended |
|----------|---------|-------------|
| CPU | 1 core | 2 cores |
| Memory | 512 MB | 1 GB |
| Disk | 1 GB | 5 GB |

### 14.4 Monitoring Setup

```yaml
# prometheus.yml addition
scrape_configs:
  - job_name: 'hygiene-daemon'
    static_configs:
      - targets: ['localhost:8081']
    metrics_path: '/admin/metrics'
```

---

## 15. Migration Strategy

### Phase 1: Foundation (Week 1-2)
- [ ] Initialize TypeScript project with Mastra
- [ ] Configure PostgresStore for workflow state
- [ ] Configure LibSQL + Vector for memory
- [ ] Implement Memgraph client (neo4j-driver)
- [ ] Port checklist definitions
- [ ] Port known patterns (transcription errors, brands)
- [ ] Set up Docker build

### Phase 2: Core Agents (Week 3-4)
- [ ] Implement Orchestrator Agent
- [ ] Implement Triage Agent
- [ ] Implement Evaluator Agent
- [ ] Implement Fixer Agent
- [ ] Create hygiene-cycle workflow
- [ ] Implement P1/P2 evaluation tools

### Phase 3: Memory & Learning (Week 5-6)
- [ ] Design working memory template
- [ ] Implement episodic memory logging
- [ ] Implement semantic memory storage
- [ ] Build Learner Agent
- [ ] Create learning-cycle workflow
- [ ] Implement confidence calibration

### Phase 4: Graph Algorithms (Week 7-8)
- [ ] Implement degree centrality
- [ ] Implement betweenness centrality
- [ ] Implement WCC (orphan detection)
- [ ] Implement Louvain community detection
- [ ] Build SHACL-style schema validator
- [ ] Implement contradiction detection
- [ ] Create graph-analysis workflow

### Phase 5: Research & Integration (Week 9-10)
- [ ] Implement Researcher Agent
- [ ] Integrate Firecrawl tools
- [ ] Implement Reviewer Agent
- [ ] Set up email notifications
- [ ] Set up Slack notifications
- [ ] Integrate LangWatch observability
- [ ] Build admin API endpoints

### Phase 6: Daemon & Operations (Week 11-12)
- [ ] Implement cron scheduler
- [ ] Build health endpoints
- [ ] Add Prometheus metrics
- [ ] Implement graceful shutdown
- [ ] Add error recovery / self-healing
- [ ] Add circuit breakers

### Phase 7: Testing & Hardening (Week 13-14)
- [ ] Write Scenario tests for workflows
- [ ] Create confidence calibration evaluation
- [ ] Load testing
- [ ] Security review
- [ ] Documentation

### Phase 8: Deployment (Week 15-16)
- [ ] Finalize Docker image
- [ ] Deploy to server
- [ ] Parallel run with old system (shadow mode)
- [ ] Compare results
- [ ] Go live
- [ ] Deprecate Python system

---

## 16. Success Criteria

### 16.1 Functional Requirements

- [ ] Runs 24/7 without human intervention
- [ ] Processes ≥50 items per hygiene cycle
- [ ] Auto-fixes P1/P2 issues with ≥95% accuracy
- [ ] Flags uncertain issues for weekly batch review
- [ ] Sends weekly review notification (email + Slack)
- [ ] Learns from human feedback (confidence calibration)
- [ ] Extracts patterns from successful fixes
- [ ] Detects structural issues (supernodes, orphans, misclassified)
- [ ] Validates schema constraints
- [ ] Resolves contradictions (temporal + source weighting)

### 16.2 Non-Functional Requirements

- [ ] Survives process restarts (durable execution)
- [ ] Recovers from transient failures (retries)
- [ ] Operates within rate limits (no API bans)
- [ ] Full audit trail of all decisions
- [ ] Metrics exposed for monitoring
- [ ] Health endpoints for orchestration
- [ ] Admin API for manual intervention
- [ ] Memory usage <1GB
- [ ] Latency <5s per item evaluation

### 16.3 Quality Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Auto-fix precision | ≥95% | Approved / (Approved + Rejected) |
| Weekly review queue | ≤50 items | Count of flagged items |
| Pattern extraction rate | ≥5/week | New patterns stored |
| Uptime | ≥99.5% | Health check success rate |
| Error rate | <1% | Errors / Items processed |

---

## 17. Technology Stack

| Component | Technology | Version | Purpose |
|-----------|------------|---------|---------|
| Runtime | Node.js | 20+ | JavaScript runtime |
| Framework | Mastra | Latest | Agent framework |
| Language | TypeScript | 5.x | Type safety |
| Database | Memgraph | Latest | Graph database |
| Workflow State | SQLite | 3.x | Durable execution |
| Memory | LibSQL | Latest | Episodic + Semantic |
| Vector DB | LibSQL Vector | Latest | Embeddings |
| LLM | Claude Sonnet/Haiku | Latest | Evaluation + Learning |
| Web Research | Firecrawl | Latest | Web scraping |
| Observability | LangWatch | Latest | LLM monitoring |
| Scheduler | node-cron | 3.x | Task scheduling |
| HTTP | Express | 4.x | Admin/Health APIs |
| Container | Docker | Latest | Deployment |

---

## 18. Project Structure

```
gearcrew-mastra/
├── src/
│   ├── index.ts                    # Daemon entry point
│   ├── mastra.ts                   # Mastra instance configuration
│   │
│   ├── agents/
│   │   ├── index.ts                # Export all agents
│   │   ├── orchestrator.ts         # Network coordinator
│   │   ├── triage.ts               # Priority assignment (Haiku)
│   │   ├── evaluator.ts            # Issue evaluation (Sonnet)
│   │   ├── fixer.ts                # Fix application (Sonnet)
│   │   ├── researcher.ts           # Web research (Sonnet)
│   │   ├── reviewer.ts             # Batch review queue (Sonnet)
│   │   ├── learner.ts              # Pattern extraction (Sonnet)
│   │   └── analyst.ts              # Graph algorithms (No LLM)
│   │
│   ├── workflows/
│   │   ├── index.ts                # Export all workflows
│   │   ├── hygiene-cycle.ts        # Main processing loop
│   │   ├── graph-analysis.ts       # Structural integrity checks
│   │   ├── batch-review.ts         # Weekly review workflow
│   │   └── learning-cycle.ts       # Self-improvement workflow
│   │
│   ├── tools/
│   │   ├── index.ts                # Export all tools
│   │   ├── evaluation/
│   │   │   ├── whitespace.ts
│   │   │   ├── case-normalization.ts
│   │   │   ├── brand-validity.ts
│   │   │   ├── brand-in-name.ts
│   │   │   ├── transcription-errors.ts
│   │   │   ├── duplicate-detection.ts
│   │   │   ├── data-completeness.ts
│   │   │   ├── orphaned-node.ts
│   │   │   └── provenance.ts
│   │   │
│   │   ├── fix/
│   │   │   ├── field-update.ts
│   │   │   ├── brand-standardization.ts
│   │   │   ├── relationship-create.ts
│   │   │   ├── clear-field.ts
│   │   │   └── merge-duplicates.ts
│   │   │
│   │   ├── research/
│   │   │   ├── search-web.ts
│   │   │   ├── verify-brand.ts
│   │   │   ├── find-specs.ts
│   │   │   └── scrape-page.ts
│   │   │
│   │   ├── database/
│   │   │   ├── client.ts           # Memgraph connection
│   │   │   ├── query-items.ts
│   │   │   ├── update-item.ts
│   │   │   └── find-duplicates.ts
│   │   │
│   │   └── graph-algorithms/
│   │       ├── centrality.ts       # Degree, betweenness
│   │       ├── components.ts       # WCC, orphan detection
│   │       ├── community.ts        # Louvain clustering
│   │       ├── schema-validator.ts # SHACL-style constraints
│   │       └── contradictions.ts   # Conflict detection
│   │
│   ├── memory/
│   │   ├── index.ts                # Memory configuration
│   │   ├── schemas/
│   │   │   ├── decision-log.ts
│   │   │   ├── learned-patterns.ts
│   │   │   └── calibration.ts
│   │   └── templates/
│   │       └── working-memory.ts
│   │
│   ├── storage/
│   │   ├── index.ts                # Storage configuration
│   │   └── migrations/
│   │
│   ├── config/
│   │   ├── index.ts                # Configuration management
│   │   ├── checklist.ts            # Check definitions
│   │   ├── thresholds.ts           # Confidence thresholds
│   │   ├── guardrails.ts           # Safety configuration
│   │   ├── shapes.ts               # Schema shapes
│   │   └── patterns.ts             # Known patterns to port
│   │
│   ├── daemon/
│   │   ├── scheduler.ts            # Cron scheduler
│   │   ├── health.ts               # Health endpoints
│   │   ├── admin.ts                # Admin API
│   │   ├── metrics.ts              # Prometheus metrics
│   │   └── graceful-shutdown.ts    # Shutdown handling
│   │
│   ├── types/
│   │   ├── index.ts
│   │   ├── hygiene.ts
│   │   ├── memgraph.ts
│   │   ├── decisions.ts
│   │   └── patterns.ts
│   │
│   └── utils/
│       ├── logger.ts
│       ├── notifications.ts
│       └── rate-limiter.ts
│
├── prompts/
│   ├── prompts.json                # LangWatch registry
│   ├── hygiene-evaluator.yaml
│   ├── triage-agent.yaml
│   ├── fixer-agent.yaml
│   ├── reviewer-agent.yaml
│   └── learner-agent.yaml
│
├── tests/
│   ├── scenarios/
│   │   ├── hygiene-cycle.test.ts
│   │   ├── auto-fix.test.ts
│   │   ├── flag-for-review.test.ts
│   │   └── learning.test.ts
│   │
│   └── evaluations/
│       ├── confidence-calibration.ipynb
│       └── pattern-extraction.ipynb
│
├── docker/
│   ├── Dockerfile
│   └── docker-compose.yml
│
├── .env.example
├── package.json
├── tsconfig.json
├── README.md
└── CLAUDE.md
```

---

## 19. Configuration Reference

### 19.1 Environment Variables

```bash
# Database
MEMGRAPH_URI=bolt://localhost:7687
MEMGRAPH_USER=memgraph
MEMGRAPH_PASSWORD=

# LLM APIs
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...  # For embeddings

# Web Research
FIRECRAWL_API_KEY=fc-...

# Observability
LANGWATCH_API_KEY=lw-...

# Notifications
NOTIFICATION_EMAIL=admin@example.com
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=
SMTP_PASSWORD=
SLACK_WEBHOOK_URL=https://hooks.slack.com/...

# Daemon
NODE_ENV=production
DATA_DIR=/data
HEALTH_PORT=8080
ADMIN_PORT=8081
LOG_LEVEL=info
```

### 19.2 Configuration Files

**thresholds.json:**
```json
{
  "P1": 0.95,
  "P2": 0.90,
  "P3": 1.0,
  "P4": 1.0,
  "P5": 1.0
}
```

**guardrails.json:**
```json
{
  "requireApproval": ["mergeDuplicates", "deleteEntity"],
  "maxAutoFixesPerRun": 100,
  "circuitBreakers": {
    "errorRateThreshold": 0.1,
    "errorWindow": 300
  },
  "rateLimits": {
    "anthropic": { "rpm": 60 },
    "firecrawl": { "rpm": 20 },
    "memgraph": { "qps": 100 }
  }
}
```

---

## 20. Appendix: Code to Port

### 20.1 From `app/hygiene/issues.py`

**KNOWN_TRANSCRIPTION_ERRORS:**
```python
KNOWN_TRANSCRIPTION_ERRORS = {
    "thermorest": "Therm-a-Rest",
    "thermarest": "Therm-a-Rest",
    "thermo rest": "Therm-a-Rest",
    "zpack": "Zpacks",
    "z-packs": "Zpacks",
    "big agnus": "Big Agnes",
    "big agnes": "Big Agnes",  # case normalization
    "gossamer": "Gossamer Gear",
    "gg": "Gossamer Gear",
    "hmg": "Hyperlite Mountain Gear",
    "hyperlite": "Hyperlite Mountain Gear",
    "durst": "Durston",
    "dan durst": "Dan Durston",
    "arc'o": "Arc Haul",
    # ... more
}
```

**CANONICAL_BRANDS:**
```python
CANONICAL_BRANDS = {
    "zpacks": "Zpacks",
    "nemo": "NEMO Equipment",
    "gg": "Gossamer Gear",
    "hmg": "Hyperlite Mountain Gear",
    "ba": "Big Agnes",
    "msr": "MSR",
    "sea to summit": "Sea to Summit",
    "s2s": "Sea to Summit",
    # ... more
}
```

**INVALID_BRAND_PATTERNS:**
```python
INVALID_BRAND_PATTERNS = [
    "sleeping bag", "tent", "tarp", "shelter",
    "backpack", "pack", "rucksack",
    "down jacket", "puffy", "insulated jacket",
    "hiking", "trekking", "camping",
    "gear", "equipment", "outdoor",
    "ultralight", "lightweight",
    # ... more
]
```

### 20.2 From `app/hygiene/checklist.py`

**Check Definitions:**
```python
HYGIENE_CHECKLIST = [
    # P1 - Instant (auto-fix)
    CheckItem(id="whitespace_check", priority=P1, requires_llm=False),
    CheckItem(id="case_check", priority=P1, requires_llm=False),

    # P2 - Quick judgment (LLM)
    CheckItem(id="invalid_brand", priority=P2, requires_llm=True),
    CheckItem(id="brand_in_name", priority=P2, requires_llm=True),

    # P3 - Context (graph query + LLM)
    CheckItem(id="brand_exists", priority=P3, requires_llm=False),
    CheckItem(id="potential_duplicate", priority=P3, requires_llm=False),
    CheckItem(id="transcription_error", priority=P3, requires_llm=False),

    # P4 - Research (web calls)
    CheckItem(id="verify_brand", priority=P4, requires_llm=True),
    CheckItem(id="missing_weight", priority=P4, requires_llm=True),
    CheckItem(id="missing_price", priority=P4, requires_llm=True),

    # P5 - Deep (comprehensive)
    CheckItem(id="orphaned_node", priority=P5, requires_llm=False),
    CheckItem(id="missing_provenance", priority=P5, requires_llm=False),
    CheckItem(id="data_completeness", priority=P5, requires_llm=False),
    CheckItem(id="copyright_concern", priority=P5, requires_llm=True),
]
```

### 20.3 From `app/db/memgraph.py`

**Key Queries to Port:**
- `find_potential_duplicates()` - Fuzzy matching with RapidFuzz
- `find_similar_nodes()` - Substring matching
- `get_enrichment_stats()` - Data quality metrics
- `calculate_completeness_score()` - Per-item score
- `scan_for_duplicates()` - Batch duplicate detection

---

*End of Scope Document*
