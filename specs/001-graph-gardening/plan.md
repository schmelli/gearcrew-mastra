# Implementation Plan: Autonomous Graph Gardening System

**Branch**: `001-graph-gardening` | **Date**: 2026-01-07 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/001-graph-gardening/spec.md`

## Summary

Build an autonomous "graph gardening" daemon that continuously maintains the GearGraph database in Memgraph. The system operates as a background service with scheduled workflows (daily hygiene, weekly deduplication) that detect and fix data quality issues. Key capabilities include orphan node cleanup, semantic duplicate detection with confidence-based routing (auto-merge >98%, human review 80-98%), and an interactive "Head Gardener" chat interface for status queries and approval decisions. The system uses graph algorithms (WCC, centrality) for structural analysis and learns from human feedback to improve over time.

## Technical Context

**Language/Version**: TypeScript 5.x (Node.js 20+)
**Primary Dependencies**: Mastra AI (agent framework), Memgraph (graph DB via MCP), Next.js (admin UI), Firecrawl (web research)
**Storage**: Memgraph (graph data), LibSQL/SQLite (workflow state, audit logs, memory)
**Testing**: Vitest (unit/integration), Mastra scenarios (workflow tests)
**Target Platform**: Linux server (Docker container), same host as Memgraph
**Project Type**: Web application (backend daemon + Next.js admin frontend)
**Performance Goals**: <5s per item evaluation, <3s chat response time, 99.5% uptime
**Constraints**: <1GB memory, max 100 auto-fixes per run, rate limits (60 req/min Anthropic, 20 req/min Firecrawl)
**Scale/Scope**: ~3,000 gear items, single administrator, daily/weekly batch processing

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Gate | Status |
|-----------|------|--------|
| I. Autonomous by Default | Does this feature operate without routine human intervention? | [x] Pass - Daily/weekly scheduled workflows run automatically via cron |
| II. Conservative Fixes | Are confidence thresholds defined? Are destructive actions flagged for approval? | [x] Pass - 98%/80% thresholds defined; merges/deletes require approval |
| III. Full Auditability | Are all decisions logged with context and reasoning? | [x] Pass - FR-026 requires complete audit trail with 1-year retention |
| IV. Self-Improvement | Does this feature support learning from feedback? | [x] Pass - FR-016/017 require pattern learning from rejected decisions |
| V. Mathematical Rigor | Are graph algorithms used for structural checks (not LLM alone)? | [x] Pass - WCC for orphans, centrality for bridge nodes per FR-002/019 |
| VI. Graceful Degradation | Does the feature handle failures without crashing? | [x] Pass - Retry with backoff per FR-025a, circuit breaker pattern |

## Project Structure

### Documentation (this feature)

```text
specs/001-graph-gardening/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output (API schemas)
└── tasks.md             # Phase 2 output (/speckit.tasks command)
```

### Source Code (repository root)

```text
src/
├── mastra/
│   ├── index.ts              # Mastra instance configuration
│   ├── agents/
│   │   ├── head-gardener.ts  # Supervisor/chat agent
│   │   ├── analyst.ts        # Graph algorithms (no LLM)
│   │   ├── resolver.ts       # Duplicate detection
│   │   └── enricher.ts       # Web research agent
│   ├── workflows/
│   │   ├── morning-hygiene.ts    # Daily orphan cleanup
│   │   ├── deep-deduplication.ts # Weekly duplicate scan
│   │   └── gap-filling.ts        # Enrichment workflow
│   ├── tools/
│   │   ├── memgraph/         # Graph query tools
│   │   ├── analysis/         # Centrality, WCC algorithms
│   │   └── firecrawl/        # Web scraping tools
│   └── memory/
│       ├── schemas.ts        # Zod schemas for memory
│       └── correction-rules.ts
├── lib/
│   ├── memgraph-client.ts    # Bolt connection wrapper
│   ├── audit-logger.ts       # Append-only audit trail
│   └── scheduler.ts          # Cron scheduling
└── types/
    └── index.ts              # Shared type definitions

app/                          # Next.js admin UI
├── api/
│   ├── chat/route.ts         # Streaming chat endpoint
│   ├── system/status/route.ts
│   └── approvals/
│       ├── route.ts          # List pending
│       └── [runId]/resume/route.ts
├── page.tsx                  # Chat interface
└── layout.tsx

tests/
├── scenarios/                # Mastra workflow tests
├── integration/              # End-to-end tests
└── unit/                     # Component tests
```

**Structure Decision**: Web application structure with Mastra backend daemon + Next.js frontend for admin chat interface. The Mastra agents handle autonomous operations while Next.js provides the interactive supervisor interface.

## Constitution Re-Check (Post-Design)

*GATE: Validate design decisions against constitution principles.*

| Principle | Design Implementation | Status |
|-----------|----------------------|--------|
| I. Autonomous by Default | node-cron schedules daily hygiene (04:00 UTC) and weekly dedup (Sundays 02:00 UTC) | [x] Pass |
| II. Conservative Fixes | Confidence thresholds: >98% auto-merge, 80-98% suspend for approval, <80% skip | [x] Pass |
| III. Full Auditability | JSONL append-only audit log at `/data/audit.jsonl` with 1-year retention | [x] Pass |
| IV. Self-Improvement | CorrectionRule entity stores rejected patterns; shared via LibSQL | [x] Pass |
| V. Mathematical Rigor | MAGE algorithms: WCC, degree_centrality, betweenness_centrality, vector_search | [x] Pass |
| VI. Graceful Degradation | Exponential backoff (1s→64s), circuit breaker at 10% error rate | [x] Pass |

## Complexity Tracking

> No constitution violations requiring justification.
