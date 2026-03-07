<!--
SYNC IMPACT REPORT
==================
Version Change: N/A (initial) → 1.0.0
Modified Principles: N/A (initial constitution)
Added Sections:
  - Core Principles (6 principles from scope.md)
  - Safety & Guardrails
  - Development Workflow
  - Governance
Removed Sections: N/A
Templates Requiring Updates:
  - .specify/templates/plan-template.md: Constitution Check section pending update
  - .specify/templates/spec-template.md: No changes required
  - .specify/templates/tasks-template.md: No changes required
Follow-up TODOs: None
-->

# GearGraph Hygiene Daemon Constitution

## Core Principles

### I. Autonomous by Default

The system MUST operate 24/7 without human intervention under normal conditions.

- Scheduled workflows (hygiene cycles, graph analysis, learning cycles) MUST execute automatically via cron
- Human review MUST be batched to weekly summaries, not per-item blocking
- Rate limits and circuit breakers MUST be handled automatically with exponential backoff
- System MUST self-recover from transient failures without manual intervention

**Rationale**: The core value proposition is eliminating the 2-3 hours/week of manual data hygiene work. Any design requiring routine human intervention defeats this purpose.

### II. Conservative Fixes

The system MUST only auto-fix when confidence exceeds defined thresholds; uncertain cases MUST be flagged for human review.

- P1 (deterministic) checks: Auto-fix when confidence >= 95%
- P2 (LLM judgment) checks: Auto-fix when confidence >= 90%
- P3-P5 checks: MUST always flag for human review
- Destructive actions (merge, delete) MUST require explicit human approval regardless of confidence
- High-betweenness graph nodes MUST require human approval before modification

**Rationale**: Data quality is paramount. False positives damage user trust. The cost of flagging a correct fix for review is far lower than auto-applying an incorrect fix.

### III. Full Auditability

Every decision MUST be logged with complete context and reasoning.

- All decisions MUST include: timestamp, entity ID, check ID, confidence score, reasoning, graph context
- Fixes MUST include: old value, new value, fix type
- Human reviews MUST be recorded with: reviewer, outcome, notes
- Audit logs MUST be immutable (append-only JSONL)
- Logs MUST be queryable by entity, check type, date range, and outcome

**Rationale**: Auditability enables learning, debugging, and accountability. Without complete decision logs, the system cannot improve or explain its actions.

### IV. Self-Improvement

The system MUST learn from human feedback to improve future decisions.

- Approved fixes MUST increase confidence calibration factor (max 1.1)
- Rejected fixes MUST decrease confidence calibration factor (dampening 0.95, min 0.8)
- Patterns MUST be extracted only when: occurrences >= 3 AND success rate >= 90%
- Learned patterns MUST be stored in semantic memory with provenance
- Drift prevention: Alert if precision/recall drops >5% from baseline

**Rationale**: Manual curation of transcription errors and brand mappings doesn't scale. The system must learn from corrections to reduce future review burden.

### V. Mathematical Rigor

Structural integrity MUST be verified using graph algorithms, not LLM intuition alone.

- Supernode detection: Flag nodes with degree > mean + 3 standard deviations
- Bridge node detection: Use betweenness centrality (>0.1 threshold)
- Orphan detection: Use Weakly Connected Components algorithm
- Schema validation: SHACL-style constraint checking (required fields, cardinality, value ranges)
- Contradiction resolution: Temporal ordering + source trust ranking (not LLM judgment)

**Rationale**: Graph-theoretic algorithms provide deterministic, explainable results. LLMs are valuable for judgment calls but should not be the sole authority on structural integrity.

### VI. Graceful Degradation

The system MUST continue operating in degraded mode when components fail.

- API failures (Anthropic, Firecrawl): Queue with exponential backoff, continue processing other items
- Circuit breaker: Pause processing if error rate >10% in 5 minutes
- Memory pressure (>80%): Flush caches, trigger garbage collection
- Memgraph unavailable: Enter read-only mode, queue writes for retry
- Always log degradation events and send alerts

**Rationale**: A hygiene daemon that crashes on transient errors provides less value than a manual process. Partial operation is better than no operation.

## Safety & Guardrails

### Actions Requiring Human Approval

| Action | Risk Level | Reason |
|--------|------------|--------|
| `mergeDuplicates` | High | Potential data loss if incorrect |
| `deleteEntity` | Critical | Irreversible |
| `reassignBrand` | Medium | Major property change affecting entity identity |
| `changeCategory` | Medium | Major property change affecting classification |
| `modifyBridgeNode` | High | May fragment graph connectivity |

### Rate Limits

| Service | Limit | Behavior on Exceed |
|---------|-------|-------------------|
| Anthropic API | 60 req/min | Queue with exponential backoff |
| Firecrawl | 20 req/min | Queue with backoff |
| Memgraph | 100 queries/sec | Batch queries |

### Resource Constraints

- Maximum auto-fixes per run: 100
- Memory usage target: < 1GB
- Latency target: < 5s per item evaluation
- Uptime target: >= 99.5%

## Development Workflow

### Test-First Requirement

All new checks, tools, and workflows MUST follow test-first development:

1. Write scenario tests defining expected behavior
2. Verify tests fail
3. Implement functionality
4. Verify tests pass

### Code Quality Gates

- TypeScript strict mode enabled
- All agents MUST have defined input/output schemas (Zod)
- All tools MUST have typed parameters and return values
- Workflow steps MUST be checkpointable for durable execution
- All decisions MUST emit structured logs

### Agent Design Standards

- Each agent MUST have a single, clearly defined responsibility
- Algorithmic operations (graph algorithms, validation) MUST NOT use LLM calls
- LLM-based judgment MUST include confidence scores
- Agent instructions MUST include domain-specific examples (e.g., "Big Agnes Big House" is valid)

## Governance

### Amendment Process

1. Propose change with rationale
2. Document impact on dependent artifacts (templates, agents, workflows)
3. Implement migration plan if breaking change
4. Update version following semantic versioning:
   - MAJOR: Principle removal or fundamental redefinition
   - MINOR: New principle or section added
   - PATCH: Clarification or wording refinement

### Compliance Review

- All PRs MUST verify compliance with these principles
- New features MUST justify any additional complexity
- Violations MUST be documented with rationale in Complexity Tracking section of plans

### Runtime Guidance

Refer to `CLAUDE.md` for development guidance and `scope.md` for architectural context.

**Version**: 1.0.0 | **Ratified**: 2026-01-07 | **Last Amended**: 2026-01-07
