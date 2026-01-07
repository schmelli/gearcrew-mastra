# Research: Autonomous Graph Gardening System

**Date**: 2026-01-07
**Feature**: 001-graph-gardening

## Technology Decisions

### 1. Agent Framework: Mastra AI

**Decision**: Use Mastra AI as the primary agent orchestration framework.

**Rationale**:
- Native TypeScript support aligns with project stack
- Built-in workflow suspend/resume for human-in-the-loop patterns
- LibSQL storage for durable workflow state
- Agent network patterns support supervisor + worker architecture
- MCP server integration for standardized database access

**Alternatives Considered**:
- LangChain: More Python-focused, TypeScript support less mature
- CrewAI: Python-only, would require separate service
- Custom implementation: Higher development cost, no durable execution

### 2. Workflow Suspend/Resume Pattern

**Decision**: Use Mastra's `step.suspend()` for human-in-the-loop approval workflows.

**Pattern**:
```typescript
execute: async ({ inputData, resumeData, suspend }) => {
  const { approved } = resumeData ?? {};

  if (!approved) {
    return await suspend({
      reason: "Awaiting human approval",
      context: { candidateA: inputData.nodeA, candidateB: inputData.nodeB }
    });
  }

  // Continue with merge after approval
  return { success: true, merged: true };
}
```

**Resume from API**:
```typescript
await run.resume({
  step: 'approval-step',
  resumeData: { approved: true, decision: 'merge' }
});
```

**Rationale**: Enables FR-007 (suspend when confidence 80-98%) and FR-013 (resume on decision). Workflow state persists across container restarts (FR-028).

### 3. State Persistence: LibSQL

**Decision**: Use LibSQL (SQLite-compatible) for workflow state, audit logs, and memory.

**Configuration**:
```typescript
import { LibSQLStore } from "@mastra/libsql";

const storage = new LibSQLStore({
  url: "file:/data/memory.db"
});
```

**Rationale**:
- Single file storage simplifies Docker volume management
- SQLite compatibility enables standard tooling for debugging
- Supports Mastra's three-layer memory (working, episodic, semantic)
- Low overhead for ~3,000 item scale

**Alternatives Considered**:
- PostgreSQL: Overkill for single-admin use case
- Redis: No built-in persistence, separate service required

### 4. Graph Algorithms: Memgraph MAGE

**Decision**: Use Memgraph's MAGE library for structural analysis algorithms.

**Algorithms Mapped to Requirements**:

| Requirement | Algorithm | Cypher Pattern |
|-------------|-----------|----------------|
| FR-002 (Orphan detection) | WCC | `CALL weakly_connected_components.get()` |
| FR-019 (Supernode detection) | Degree Centrality | `CALL degree_centrality.get("undirected")` |
| FR-009 (Bridge node protection) | Betweenness Centrality | `CALL betweenness_centrality.get(TRUE, TRUE)` |
| FR-005 (Duplicate detection) | Vector Search | `CALL vector_search.search(...)` |

**Orphan Island Detection**:
```cypher
CALL weakly_connected_components.get()
YIELD node, component_id
WITH component_id, COUNT(node) as size, COLLECT(node) as nodes
WHERE component_id > 0  -- Component 0 is main graph
RETURN component_id, size,
       [n IN nodes[..5] | n.name] as sample_names
ORDER BY size ASC;
```

**Supernode Detection (>3σ above mean)**:
```cypher
CALL degree_centrality.get("undirected")
YIELD node, degree
WITH AVG(degree) as mean_deg, STDEV(degree) as std_deg
MATCH (n)
CALL degree_centrality.get("undirected")
YIELD node, degree
WHERE degree > mean_deg + 3 * std_deg
RETURN node.name, degree
ORDER BY degree DESC;
```

**Bridge Node Detection**:
```cypher
CALL betweenness_centrality.get(TRUE, TRUE)
YIELD node, betweenness_centrality
WHERE betweenness_centrality > 0.1
RETURN node.id, node.name, betweenness_centrality
ORDER BY betweenness_centrality DESC;
```

**Vector Similarity for Duplicates**:
```cypher
-- Assumes embeddings already exist on nodes
CALL vector_search.search("gear_embeddings", 10, $query_embedding)
YIELD node, similarity
WHERE similarity > 0.80
RETURN node.id, node.name, similarity
ORDER BY similarity DESC;
```

**Rationale**: Graph algorithms provide deterministic, explainable results per Constitution Principle V. No LLM involved in structural analysis.

### 5. Agent Network Architecture

**Decision**: Four-agent network with Head Gardener as supervisor.

| Agent | Role | Model | LLM? |
|-------|------|-------|------|
| Head Gardener | Supervisor, chat interface | Claude Sonnet | Yes |
| Analyst | Graph algorithms, structural checks | None | No |
| Resolver | Duplicate evaluation, merge planning | Claude Sonnet | Yes |
| Enricher | Web research, data gap filling | Claude Sonnet | Yes |

**Supervisor Pattern**:
```typescript
export const headGardener = new Agent({
  name: "head-gardener",
  instructions: `You are the Head Gardener supervising graph maintenance.
  - Answer status queries from audit logs
  - Present pending approvals clearly
  - Execute manual workflow triggers
  - Route complex decisions to appropriate workers`,
  model: claude("claude-sonnet-4-20250514"),
  tools: {
    getWorkflowStatus,
    listPendingDecisions,
    submitDecision,
    queryGraphReadonly,
    triggerWorkflow
  },
  memory: hygieneMemory
});
```

**Rationale**: Clear separation of concerns. Analyst has no LLM (pure algorithms). Head Gardener coordinates workers and handles admin interaction.

### 6. Admin Interface: Next.js App Router

**Decision**: Use Next.js App Router with streaming API routes for chat interface.

**Chat Endpoint**:
```typescript
// app/api/chat/route.ts
export async function POST(req: Request) {
  const { messages } = await req.json();

  const stream = await headGardener.stream(messages);

  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream' }
  });
}
```

**Rationale**:
- Integrates naturally with Mastra agent streaming
- Single deployment unit (daemon + UI)
- React Server Components for status dashboards

### 7. Scheduling: node-cron

**Decision**: Use node-cron for workflow scheduling.

**Configuration**:
```typescript
import cron from 'node-cron';

// Daily hygiene at 04:00 UTC
cron.schedule('0 4 * * *', async () => {
  await mastra.getWorkflow('morning-hygiene').execute({});
});

// Weekly deduplication on Sundays at 02:00 UTC
cron.schedule('0 2 * * 0', async () => {
  await mastra.getWorkflow('deep-deduplication').execute({});
});
```

**Rationale**: Simple, well-tested, runs in-process. No external scheduler dependency.

### 8. Audit Logging: Append-Only JSONL

**Decision**: Store audit logs as append-only JSONL files with yearly rotation.

**Format**:
```jsonl
{"ts":"2026-01-07T04:00:00Z","workflow":"morning-hygiene","action":"delete","entity":"node-123","before":{"name":""},"after":null,"confidence":0.99}
{"ts":"2026-01-07T04:00:01Z","workflow":"morning-hygiene","action":"skip","entity":"node-456","reason":"valuable_keywords","confidence":0.45}
```

**Retention**: 1 year per FR-026a, automatic purge per FR-026b.

**Rationale**:
- Immutable (append-only) per Constitution Principle III
- Easily queryable with standard tools (jq, grep)
- Low storage overhead for ~3,000 items

## Best Practices Applied

### Mastra Workflow Design

1. **Checkpoint after each step**: Enable resume from any point
2. **Define resumeSchema**: Match expected input on resume
3. **Separate suspend context**: Include all data needed for admin review
4. **Use step IDs**: Reference in resume calls

### Memgraph Query Optimization

1. **Index frequently queried properties**: `CREATE INDEX ON :GearItem(id)`
2. **Batch WCC calls**: Run once per workflow, cache results
3. **Limit centrality calculations**: Run daily (3am), not per-item

### Rate Limit Handling

1. **Exponential backoff**: 1s, 2s, 4s, 8s up to 64s
2. **Circuit breaker**: Pause if >10% error rate in 5 minutes
3. **Queue external calls**: Don't block workflow on API waits

## Open Questions Resolved

| Question | Resolution |
|----------|------------|
| Embedding source | Embeddings pre-exist in graph (no generation needed) |
| Approval expiration | Never expire (indefinite retention) |
| External retry policy | 3 retries with exponential backoff, then alert |
| Merge semantics | Transfer relationships, merge properties with conflict flagging |
| Audit retention | 1 year, then purge |
