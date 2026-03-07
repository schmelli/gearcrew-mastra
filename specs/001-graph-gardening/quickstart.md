# Quickstart: Graph Gardening System

**Date**: 2026-01-07
**Feature**: 001-graph-gardening

## Prerequisites

- Node.js 20+
- Docker & Docker Compose (for Memgraph)
- Memgraph instance with MAGE algorithms installed
- Anthropic API key (for Claude Sonnet agents)
- Firecrawl API key (for web enrichment)

## Environment Setup

1. **Clone and install dependencies**:
   ```bash
   cd gearcrew-mastra
   npm install
   ```

2. **Configure environment variables**:
   ```bash
   cp .env.example .env
   ```

   Required variables:
   ```env
   # LLM
   ANTHROPIC_API_KEY=sk-ant-...

   # Graph Database
   MEMGRAPH_HOST=localhost
   MEMGRAPH_PORT=7687
   MEMGRAPH_USER=memgraph
   MEMGRAPH_PASSWORD=

   # Web Research
   FIRECRAWL_API_KEY=fc-...

   # Storage (LibSQL)
   LIBSQL_URL=file:/data/memory.db

   # Audit Log
   AUDIT_LOG_PATH=/data/audit.jsonl
   ```

3. **Start Memgraph** (if not running):
   ```bash
   docker run -d \
     --name memgraph \
     -p 7687:7687 \
     -p 7444:7444 \
     memgraph/memgraph-mage
   ```

4. **Verify MAGE algorithms**:
   ```bash
   npm run verify:memgraph
   ```

   Expected output:
   ```
   ✓ Connected to Memgraph
   ✓ MAGE weakly_connected_components available
   ✓ MAGE degree_centrality available
   ✓ MAGE betweenness_centrality available
   ✓ MAGE vector_search available
   ```

## Running the System

### Development Mode

```bash
npm run dev
```

This starts:
- Next.js admin UI on `http://localhost:3000`
- Mastra agent framework with scheduled workflows
- Cron scheduler for automated maintenance

### Production Mode

```bash
npm run build
npm start
```

Or with Docker:
```bash
docker compose up -d
```

## Interacting with the System

### Chat Interface

Open `http://localhost:3000` to access the Head Gardener chat interface.

**Example queries**:
```
"How many orphans did you find today?"
"Show me pending approvals"
"Run hygiene check now"
"What did you fix last week?"
```

### API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/chat` | POST | Streaming chat with Head Gardener |
| `/api/system/status` | GET | System health metrics |
| `/api/approvals` | GET | List pending approvals |
| `/api/approvals/:runId/resume` | POST | Resume suspended workflow |
| `/api/workflows` | GET/POST | List/trigger workflows |
| `/api/audit` | GET | Query audit logs |
| `/api/issues` | GET | List detected issues |

### Manual Workflow Triggers

```bash
# Trigger hygiene check
curl -X POST http://localhost:3000/api/workflows \
  -H "Content-Type: application/json" \
  -d '{"workflowType": "morning-hygiene"}'

# Trigger targeted deduplication
curl -X POST http://localhost:3000/api/workflows \
  -H "Content-Type: application/json" \
  -d '{"workflowType": "deep-deduplication", "scope": {"category": "Sleeping Bags"}}'
```

### Resuming Suspended Workflows

When a workflow suspends for human approval:

```bash
# List pending approvals
curl http://localhost:3000/api/approvals

# Approve a merge
curl -X POST http://localhost:3000/api/approvals/{runId}/resume \
  -H "Content-Type: application/json" \
  -d '{"stepId": "approval-step", "decision": "approve"}'

# Reject with notes
curl -X POST http://localhost:3000/api/approvals/{runId}/resume \
  -H "Content-Type: application/json" \
  -d '{"stepId": "approval-step", "decision": "reject", "notes": "These are distinct products"}'
```

## Scheduled Workflows

| Workflow | Schedule | Description |
|----------|----------|-------------|
| morning-hygiene | 04:00 UTC daily | Orphan detection, schema validation |
| deep-deduplication | 02:00 UTC Sundays | Semantic duplicate detection |
| gap-filling | On-demand | Data enrichment from web sources |

## Monitoring

### System Status

```bash
curl http://localhost:3000/api/system/status
```

Response:
```json
{
  "timestamp": "2026-01-07T10:00:00Z",
  "workflows": {
    "completed": 42,
    "failed": 1,
    "suspended": 3
  },
  "items": {
    "processed": 3000,
    "autoFixed": 150,
    "flagged": 45
  },
  "approvals": {
    "pending": 3,
    "approved": 38,
    "rejected": 4
  },
  "uptime": 604800
}
```

### Audit Log Queries

```bash
# Last 24 hours of actions
curl "http://localhost:3000/api/audit?from=2026-01-06T00:00:00Z"

# All merges this week
curl "http://localhost:3000/api/audit?action=merge&from=2026-01-01T00:00:00Z"

# Actions on specific entity
curl "http://localhost:3000/api/audit?entityId=gear-123"
```

## Troubleshooting

### Common Issues

1. **Memgraph connection failed**:
   - Verify Memgraph is running: `docker ps | grep memgraph`
   - Check connection settings in `.env`
   - Ensure port 7687 is not blocked

2. **MAGE algorithms not found**:
   - Use `memgraph/memgraph-mage` image (not plain `memgraph`)
   - Verify with: `CALL mg.procedures() YIELD name WHERE name CONTAINS 'wcc'`

3. **Workflow stuck in suspended state**:
   - Check pending approvals: `GET /api/approvals`
   - Resume with decision: `POST /api/approvals/:runId/resume`

4. **Rate limit errors (Anthropic/Firecrawl)**:
   - System automatically backs off with exponential retry
   - Check `AUDIT_LOG_PATH` for error entries
   - Reduce batch sizes if persistent

### Log Locations

| Log | Location | Format |
|-----|----------|--------|
| Application | stdout | Structured JSON |
| Audit trail | `/data/audit.jsonl` | JSONL (append-only) |
| Workflow state | `/data/memory.db` | SQLite (LibSQL) |

## Next Steps

1. Review the [Data Model](./data-model.md) for entity schemas
2. Check [API Contracts](./contracts/openapi.yaml) for full endpoint documentation
3. Read [Research Notes](./research.md) for technology decisions
4. Run the test suite: `npm test`
