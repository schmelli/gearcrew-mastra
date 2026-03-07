# Feature Specification: Autonomous Graph Gardening System

**Feature Branch**: `001-graph-gardening`
**Created**: 2026-01-07
**Status**: Draft
**Input**: Functional Specification v2.0.0 - Autonomous Graph Gardening System (GearGraph Daemon)

## Clarifications

### Session 2026-01-07

- Q: How long should pending approval requests be retained before expiration? → A: Pending approvals never expire (indefinite retention)
- Q: Do embeddings already exist in the graph, or must the system generate them? → A: Embeddings already exist in the graph (no generation needed)
- Q: What is the retry policy for external enrichment service failures? → A: Retry 3 times with exponential backoff, then skip and alert admin
- Q: What happens to relationships and properties when duplicate nodes are merged? → A: Transfer all relationships to survivor; merge properties with conflict flagging
- Q: How long should audit logs be retained? → A: Retain for 1 year, then purge

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Autonomous Orphan Cleanup (Priority: P1)

As a system administrator, I want the system to automatically detect and remove disconnected "orphan" nodes with no meaningful content, so that the graph database remains clean without requiring my daily intervention.

**Why this priority**: This is the foundational autonomous capability. Without automatic orphan detection and removal, the database accumulates garbage data that degrades query performance and data quality. This directly addresses the core value proposition of eliminating 2-3 hours/week of manual maintenance.

**Independent Test**: Can be fully tested by introducing a disconnected empty node and verifying the daily workflow detects and removes it automatically, delivering immediate database hygiene value.

**Acceptance Scenarios**:

1. **Given** a node exists with no relationships and no meaningful properties (empty or generic content), **When** the daily hygiene workflow runs, **Then** the node is automatically deleted and the action is logged.

2. **Given** a disconnected node contains potentially valuable keywords (brand names, product specifications), **When** the daily hygiene workflow runs, **Then** the node is NOT deleted but queued for entity resolution review.

3. **Given** the daily hygiene workflow completes, **When** an administrator queries the system, **Then** a summary report shows the count of nodes deleted in that run.

---

### User Story 2 - Interactive Duplicate Resolution (Priority: P2)

As a system administrator, I want to review and approve proposed duplicate merges via a conversational interface when the system is uncertain, so that I can prevent incorrect automatic merges while still benefiting from automation for clear-cut cases.

**Why this priority**: Deduplication is critical for data quality, but incorrect merges cause data loss. The human-in-the-loop pattern protects data integrity while maximizing automation for high-confidence cases.

**Independent Test**: Can be fully tested by introducing two near-duplicate nodes, triggering deduplication, observing the workflow suspend, and completing the merge via chat interface.

**Acceptance Scenarios**:

1. **Given** two nodes have >98% semantic similarity, **When** the weekly deduplication workflow runs, **Then** the nodes are automatically merged without human intervention and the merge is logged.

2. **Given** two nodes have 80-98% semantic similarity, **When** the weekly deduplication workflow runs, **Then** the workflow suspends and queues the merge decision for human review.

3. **Given** a pending merge decision exists, **When** the administrator chats with the system ("Show me the pending merges"), **Then** the system displays both node candidates with their properties and relationships.

4. **Given** the administrator approves a merge via chat ("Merge these nodes"), **When** the decision is submitted, **Then** the suspended workflow resumes and executes the merge.

5. **Given** the administrator rejects a merge via chat ("Do not merge these"), **When** the decision is submitted, **Then** the rejection is recorded and the system does NOT propose the same merge in future runs.

---

### User Story 3 - System Health Inquiries (Priority: P3)

As a system administrator, I want to ask natural language questions about the graph's health status, so that I can understand what maintenance has occurred and what issues require attention without writing queries.

**Why this priority**: Visibility into autonomous operations builds trust and enables informed decision-making. This transforms an opaque background process into an interactive, accountable assistant.

**Independent Test**: Can be fully tested by asking the system about orphan counts, recent actions, or pending decisions and receiving accurate, current information.

**Acceptance Scenarios**:

1. **Given** the administrator asks "How many orphans did you find today?", **When** the system processes the query, **Then** it returns the count of orphan nodes detected in the most recent hygiene run.

2. **Given** the administrator asks "What did you fix last week?", **When** the system processes the query, **Then** it returns a summary of all automated actions (deletes, merges, enrichments) from the past 7 days.

3. **Given** the administrator asks "Show me high-degree nodes", **When** the system processes the query, **Then** it returns nodes with abnormally high connection counts (supernodes) that may indicate data quality issues.

---

### User Story 4 - Manual Workflow Triggering (Priority: P4)

As a system administrator, I want to manually trigger specific maintenance workflows on demand, so that I can address urgent issues or focus maintenance on specific areas of the graph.

**Why this priority**: While automation handles routine maintenance, administrators need the ability to intervene for urgent issues or targeted cleanups.

**Independent Test**: Can be fully tested by issuing a command like "Run a deep scan on the Tents category" and observing the targeted workflow execution.

**Acceptance Scenarios**:

1. **Given** the administrator says "Run hygiene check now", **When** the system processes the command, **Then** the daily hygiene workflow runs immediately outside its scheduled time.

2. **Given** the administrator says "Scan the Sleeping Bags category for duplicates", **When** the system processes the command, **Then** a targeted deduplication workflow runs only on nodes in that category.

3. **Given** a manual workflow is running, **When** the administrator asks "What's the status?", **Then** the system reports the workflow's progress and any findings so far.

---

### User Story 5 - Automatic Data Enrichment (Priority: P5)

As a system administrator, I want the system to automatically find and fill missing product data from external sources, so that the knowledge base becomes more complete over time.

**Why this priority**: Enrichment adds value to existing data but is lower priority than core hygiene and deduplication. It also has external dependencies (web search APIs) and higher complexity.

**Independent Test**: Can be fully tested by flagging a node as incomplete (missing weight field), triggering enrichment, and verifying the missing data is populated from web sources.

**Acceptance Scenarios**:

1. **Given** a product node is missing the "weight" field, **When** the enrichment workflow runs, **Then** the system searches for the product specifications online and populates the field if found.

2. **Given** the system finds product data from an external source, **When** updating the graph, **Then** the system validates the data format (e.g., converts "12 oz" to grams if schema requires integers).

3. **Given** multiple incomplete nodes exist, **When** the enrichment workflow runs, **Then** nodes with higher popularity (more connections) are prioritized for enrichment.

---

### Edge Cases

- What happens when an orphan island contains multiple interconnected nodes but is disconnected from the main graph?
  - *Behavior*: Islands with 4+ nodes are flagged for human review rather than auto-deleted, as they may represent valid sub-graphs.

- What happens when the external enrichment source is unavailable?
  - *Behavior*: The system retries 3 times with exponential backoff. If all retries fail, it logs the failure, alerts the administrator, skips the node, and continues with the next item in the queue. The node remains incomplete for the next enrichment run.

- What happens when a duplicate merge would affect a high-centrality "bridge" node?
  - *Behavior*: The system requires human approval regardless of confidence score, as modifying bridge nodes may fragment graph connectivity.

- What happens when the system detects a "supernode" with abnormally high connections (e.g., 50,000+ edges)?
  - *Behavior*: The system flags the supernode for investigation as it may indicate a generic catch-all entity (e.g., brand: "Other") that should be decomposed.

- What happens if multiple workflows try to modify the same node simultaneously?
  - *Behavior*: Workflows operate on checkpointed state with conflict detection; concurrent modifications trigger a human review queue entry.

- What happens if a node is missing its text embedding?
  - *Behavior*: The node is excluded from semantic similarity comparisons for duplicate detection; it may still be processed for orphan detection and schema validation.

- What happens when merged nodes have conflicting property values (e.g., different weights)?
  - *Behavior*: The system flags the conflict and presents both values to the administrator for resolution before completing the merge.

## Requirements *(mandatory)*

### Functional Requirements

**Core Autonomous Operations**

- **FR-001**: System MUST run scheduled maintenance workflows without human intervention (daily hygiene at 04:00 UTC, weekly deduplication on Sundays at 02:00 UTC).

- **FR-002**: System MUST detect disconnected nodes (orphan islands) using graph connectivity analysis.

- **FR-003**: System MUST automatically delete orphan nodes that have size=1 AND contain only empty or generic content.

- **FR-004**: System MUST preserve orphan nodes that contain potentially valuable keywords (brand names, product specifications) and queue them for resolution.

- **FR-005**: System MUST identify potential duplicate nodes using semantic similarity comparison on text embeddings.

**Confidence-Based Decision Routing**

- **FR-006**: System MUST automatically execute merges when duplicate confidence exceeds 98%.

- **FR-007**: System MUST suspend workflow and require human approval when duplicate confidence is between 80-98%.

- **FR-008**: System MUST take no action on potential duplicates below 80% confidence.

- **FR-009**: System MUST require human approval for all destructive actions (merge, delete) on high-centrality bridge nodes regardless of confidence.

- **FR-009a**: System MUST transfer all relationships from the absorbed node to the survivor node during a merge operation.

- **FR-009b**: System MUST merge properties from both nodes, flagging conflicts when the same property has different values.

- **FR-009c**: System MUST present property conflicts to the administrator for resolution when they occur during a merge.

**Interactive Supervisor Interface**

- **FR-010**: System MUST provide a conversational interface for administrators to query system status.

- **FR-011**: System MUST display pending approval decisions to administrators upon request.

- **FR-012**: System MUST allow administrators to approve or reject proposed actions via natural language commands.

- **FR-013**: System MUST resume suspended workflows when human decisions are submitted.

- **FR-014**: System MUST allow administrators to manually trigger workflows on demand.

- **FR-015**: System MUST support targeted workflows on specific graph categories or node types.

**Learning and Memory**

- **FR-016**: System MUST remember rejected merge decisions and NOT propose the same merge in future runs.

- **FR-017**: System MUST store learned patterns (e.g., "Do not merge Pro and Non-Pro product variants") for future reference.

- **FR-018**: System MUST share learned context between the interactive supervisor and automated workers.

**Structural Analysis**

- **FR-019**: System MUST detect "supernode" anomalies (nodes with connection count >3 standard deviations above mean).

- **FR-020**: System MUST validate nodes against schema requirements (required properties, valid value ranges).

- **FR-021**: System MUST identify nodes that violate schema constraints (e.g., Product missing brand reference).

**Data Enrichment**

- **FR-022**: System MUST identify nodes with missing required or recommended properties.

- **FR-023**: System MUST search external sources for missing product specifications.

- **FR-024**: System MUST validate and transform enriched data to match schema requirements (e.g., unit conversion).

- **FR-025**: System MUST prioritize enrichment for nodes with higher graph centrality (more popular/connected items).

- **FR-025a**: System MUST retry failed external enrichment requests 3 times with exponential backoff before skipping the node.

- **FR-025b**: System MUST alert the administrator when an enrichment request fails after all retry attempts.

**Observability and Auditability**

- **FR-026**: System MUST log all automated actions (creates, updates, deletes) to a persistent audit trail.

- **FR-026a**: System MUST retain audit log entries for 1 year from creation date.

- **FR-026b**: System MUST automatically purge audit log entries older than 1 year.

- **FR-027**: System MUST report workflow health and run statistics via status endpoint.

- **FR-028**: System MUST maintain workflow state persistently to survive system restarts.

- **FR-029**: System MUST provide metrics for monitoring (items processed, actions taken, approvals pending).

- **FR-029a**: System MUST retain pending approval requests indefinitely until explicitly resolved by an administrator (no automatic expiration).

**Safety Guardrails**

- **FR-030**: System MUST prevent execution of catastrophic operations (e.g., dropping the entire database or removing all labels from nodes).

- **FR-031**: System MUST enforce read-only access for investigative queries initiated through the chat interface.

### Key Entities

- **Graph Node (GearItem, OutdoorBrand, etc.)**: Represents entities in the knowledge graph with properties, labels, and relationships. Key attributes: ID, name, properties, completeness score.

- **Gardening Issue**: A detected problem requiring action. Types: orphan, duplicate, missing_data, schema_violation. Attributes: severity, affected entities, suggested action, confidence score, status.

- **Approval Request**: A suspended workflow decision awaiting human input. Attributes: workflow run ID, candidates involved, reasoning, proposed action, creation timestamp.

- **Correction Rule**: A learned constraint from rejected actions. Attributes: pattern description, source decision ID, creation date, applicability scope.

- **Audit Entry**: An immutable record of system actions. Attributes: timestamp, action type, affected entities, before/after states, triggering workflow.

- **Workflow Run**: An execution instance of a scheduled or manual workflow. Attributes: workflow type, start time, status (running/suspended/completed/failed), statistics.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: System runs autonomously for 7 consecutive days without requiring manual intervention for routine maintenance.

- **SC-002**: Orphan nodes with empty/generic content are detected and removed within 24 hours of creation.

- **SC-003**: High-confidence duplicate merges (>98% similarity) complete automatically with 95%+ accuracy (validated against human review of sample).

- **SC-004**: Administrator manual review time reduces by 80% compared to current manual hygiene process (from 2-3 hours/week to under 30 minutes/week).

- **SC-005**: All automated actions are logged with complete audit trail, queryable for compliance review.

- **SC-006**: Rejected merge decisions are never re-proposed (100% retention of correction rules).

- **SC-007**: Chat interface responds to status queries within 3 seconds.

- **SC-008**: System survives container restarts without losing suspended workflow state.

- **SC-009**: Administrators can complete a pending approval decision in under 1 minute via chat interface.

- **SC-010**: Weekly health summary provides accurate counts of: orphans removed, duplicates merged, enrichments completed, decisions pending.

## Assumptions

- The existing GearGraph database in Memgraph contains approximately 3,000+ gear items with established schema for products and brands.

- Graph nodes already have text embeddings suitable for semantic similarity comparison; embedding generation is not required.

- External web search capabilities (Firecrawl or equivalent) are available for data enrichment.

- A single administrator will interact with the system; multi-user access control is not required for MVP.

- The system runs on the same server as Memgraph with direct network access.

## Out of Scope

- **Data Ingestion**: This system only maintains data already present in the graph. New data extraction from YouTube videos, web sources, or other origins is handled by separate ingestion pipelines.

- **User Authentication**: The admin interface assumes a trusted environment; authentication mechanisms are not included.

- **Multi-tenant Support**: The system manages a single graph instance.

- **Real-time Processing**: Maintenance operates on scheduled or manual triggers, not real-time streaming.
