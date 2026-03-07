# Tasks: Autonomous Graph Gardening System

**Input**: Design documents from `/specs/001-graph-gardening/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/

**Tests**: Tests are included as the specification requires validation of autonomous operations and human-in-the-loop workflows.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions

Based on plan.md structure:
- **Mastra agents/workflows**: `src/mastra/`
- **Library code**: `src/lib/`
- **Types**: `src/types/`
- **Next.js UI**: `app/`
- **Tests**: `tests/`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization and basic structure

- [x] T001 Create project directory structure per plan.md (src/mastra/, src/lib/, src/types/, app/, tests/)
- [x] T002 Initialize TypeScript project with package.json and tsconfig.json
- [x] T003 [P] Install core dependencies: @mastra/core, @mastra/libsql, next, zod
- [x] T004 [P] Install development dependencies: vitest, typescript, @types/node
- [x] T005 [P] Configure ESLint and Prettier in .eslintrc.json and .prettierrc
- [x] T006 [P] Create .env.example with required environment variables per quickstart.md
- [x] T007 Create Docker Compose configuration for local development in docker-compose.yml

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure that MUST be complete before ANY user story can be implemented

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [x] T008 Define shared Zod schemas in src/types/index.ts (GardeningIssue, ApprovalRequest, CorrectionRule, AuditEntry, WorkflowRun, SystemMetrics per data-model.md)
- [x] T009 Implement Memgraph Bolt client wrapper in src/lib/memgraph-client.ts
- [x] T010 [P] Implement append-only audit logger in src/lib/audit-logger.ts (JSONL format per research.md)
- [x] T011 [P] Configure LibSQL storage for Mastra in src/mastra/memory/schemas.ts
- [x] T012 Create Mastra instance configuration in src/mastra/index.ts with LibSQL storage
- [x] T013 [P] Implement cron scheduler wrapper in src/lib/scheduler.ts (node-cron integration)
- [x] T014 Create base Next.js app structure in app/layout.tsx and app/page.tsx
- [x] T015 [P] Implement error handling utilities in src/lib/errors.ts (retry with exponential backoff per FR-025a)

**Checkpoint**: Foundation ready - user story implementation can now begin in parallel

---

## Phase 3: User Story 1 - Autonomous Orphan Cleanup (Priority: P1) 🎯 MVP

**Goal**: System automatically detects and removes disconnected orphan nodes with no meaningful content during daily hygiene workflow (FR-002, FR-003, FR-004)

**Independent Test**: Introduce a disconnected empty node and verify the daily workflow detects and removes it automatically; verify nodes with brand keywords are preserved and queued for review

### Tests for User Story 1

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [x] T016 [P] [US1] Create scenario test for empty orphan deletion in tests/scenarios/orphan-cleanup.test.ts
- [x] T017 [P] [US1] Create scenario test for valuable orphan preservation in tests/scenarios/orphan-preservation.test.ts
- [x] T018 [P] [US1] Create unit test for WCC algorithm wrapper in tests/unit/wcc-analysis.test.ts

### Implementation for User Story 1

- [x] T019 [P] [US1] Implement WCC graph algorithm tool in src/mastra/tools/analysis/wcc.ts (CALL weakly_connected_components.get per research.md)
- [x] T020 [P] [US1] Implement orphan classification tool in src/mastra/tools/analysis/orphan-classifier.ts (empty/generic/valuable per data-model.md)
- [x] T021 [US1] Create Analyst agent (no LLM) in src/mastra/agents/analyst.ts with graph algorithm tools
- [x] T022 [US1] Implement morning-hygiene workflow in src/mastra/workflows/morning-hygiene.ts with orphan detection step
- [x] T023 [US1] Add orphan deletion step to morning-hygiene workflow (auto-delete size=1 empty orphans per FR-003)
- [x] T024 [US1] Add valuable orphan flagging step to morning-hygiene workflow (queue for resolution per FR-004)
- [x] T025 [US1] Register morning-hygiene workflow with cron scheduler (04:00 UTC daily per FR-001)
- [x] T026 [US1] Add audit logging for all orphan actions in morning-hygiene workflow

**Checkpoint**: At this point, User Story 1 should be fully functional and testable independently

---

## Phase 4: User Story 2 - Interactive Duplicate Resolution (Priority: P2)

**Goal**: System detects duplicate nodes via semantic similarity, auto-merges high-confidence matches (>98%), and suspends workflow for human approval on mid-confidence matches (80-98%) (FR-005 through FR-009c)

**Independent Test**: Introduce two near-duplicate nodes, trigger deduplication, observe workflow suspend for 80-98% confidence, complete merge via API

### Tests for User Story 2

- [x] T027 [P] [US2] Create scenario test for auto-merge >98% confidence in tests/scenarios/auto-merge.test.ts
- [x] T028 [P] [US2] Create scenario test for workflow suspend 80-98% confidence in tests/scenarios/suspend-for-approval.test.ts
- [x] T029 [P] [US2] Create contract test for POST /api/approvals/:runId/resume in tests/contract/resume-workflow.test.ts

### Implementation for User Story 2

- [x] T030 [P] [US2] Implement vector similarity tool in src/mastra/tools/analysis/vector-similarity.ts (CALL vector_search.search per research.md)
- [x] T031 [US2] Create Resolver agent with duplicate evaluation in src/mastra/agents/resolver.ts
- [x] T032 [US2] Implement deep-deduplication workflow skeleton in src/mastra/workflows/deep-deduplication.ts
- [x] T033 [US2] Add duplicate detection step using vector similarity in deep-deduplication workflow
- [x] T034 [US2] Add confidence-based routing step (>98% auto-merge, 80-98% suspend, <80% skip per FR-006/007/008)
- [x] T035 [US2] Implement workflow suspend with approval context in deep-deduplication (step.suspend per research.md)
- [x] T036 [US2] Implement merge execution step (transfer relationships, merge properties per FR-009a/b)
- [x] T037 [US2] Add property conflict detection and flagging step (per FR-009c)
- [x] T038 [US2] Register deep-deduplication workflow with cron scheduler (02:00 UTC Sundays per FR-001)
- [x] T039 [P] [US2] Implement GET /api/approvals endpoint in app/api/approvals/route.ts
- [x] T040 [US2] Implement POST /api/approvals/[runId]/resume endpoint in app/api/approvals/[runId]/resume/route.ts
- [x] T041 [US2] Add audit logging for all merge actions in deep-deduplication workflow

**Checkpoint**: At this point, User Stories 1 AND 2 should both work independently

---

## Phase 5: User Story 3 - System Health Inquiries (Priority: P3)

**Goal**: Administrator can ask natural language questions about graph health and get accurate current information (FR-010, FR-011, FR-027, FR-029)

**Independent Test**: Ask "How many orphans did you find today?" and verify response matches audit log data

### Tests for User Story 3

- [x] T042 [P] [US3] Create integration test for status query via chat in tests/integration/chat-status.test.ts
- [x] T043 [P] [US3] Create contract test for GET /api/system/status in tests/contract/system-status.test.ts

### Implementation for User Story 3

- [x] T044 [P] [US3] Implement getWorkflowStatus tool in src/mastra/tools/memgraph/workflow-status.ts
- [x] T045 [P] [US3] Implement listPendingDecisions tool in src/mastra/tools/memgraph/pending-decisions.ts
- [x] T046 [P] [US3] Implement queryAuditLog tool in src/mastra/tools/memgraph/audit-query.ts
- [x] T047 [P] [US3] Implement supernode detection tool in src/mastra/tools/analysis/supernode-detector.ts (degree centrality per FR-019)
- [x] T048 [US3] Create Head Gardener agent in src/mastra/agents/head-gardener.ts with status query tools
- [x] T049 [US3] Add memory configuration to Head Gardener (LibSQL three-layer memory per research.md)
- [x] T050 [US3] Implement streaming chat endpoint in app/api/chat/route.ts (SSE response per contracts)
- [x] T051 [US3] Implement GET /api/system/status endpoint in app/api/system/status/route.ts
- [x] T052 [P] [US3] Implement GET /api/audit endpoint in app/api/audit/route.ts
- [x] T053 [P] [US3] Implement GET /api/issues endpoint in app/api/issues/route.ts
- [x] T054 [US3] Create chat UI component in app/page.tsx with streaming support

**Checkpoint**: User Stories 1, 2, AND 3 should all work independently

---

## Phase 6: User Story 4 - Manual Workflow Triggering (Priority: P4)

**Goal**: Administrator can manually trigger workflows on demand and target specific graph categories (FR-014, FR-015)

**Independent Test**: Say "Run hygiene check now" via chat and verify workflow executes immediately

### Tests for User Story 4

- [x] T055 [P] [US4] Create integration test for manual trigger via chat in tests/integration/manual-trigger.test.ts
- [x] T056 [P] [US4] Create contract test for POST /api/workflows in tests/contract/trigger-workflow.test.ts

### Implementation for User Story 4

- [x] T057 [P] [US4] Implement triggerWorkflow tool in src/mastra/tools/memgraph/trigger-workflow.ts
- [x] T058 [US4] Add scope filter parameter to workflow triggers (category, brand per FR-015)
- [x] T059 [US4] Connect triggerWorkflow tool to Head Gardener agent in src/mastra/agents/head-gardener.ts
- [x] T060 [US4] Implement GET /api/workflows endpoint in app/api/workflows/route.ts
- [x] T061 [US4] Implement POST /api/workflows endpoint (trigger) in app/api/workflows/route.ts
- [x] T062 [US4] Implement GET /api/workflows/[runId] endpoint in app/api/workflows/[runId]/route.ts

**Checkpoint**: User Stories 1-4 should all work independently

---

## Phase 7: User Story 5 - Automatic Data Enrichment (Priority: P5)

**Goal**: System automatically finds and fills missing product data from external sources, prioritizing high-centrality nodes (FR-022 through FR-025b)

**Independent Test**: Flag a node as incomplete (missing weight), trigger enrichment, verify missing data is populated from web sources

### Tests for User Story 5

- [ ] T063 [P] [US5] Create scenario test for enrichment with unit conversion in tests/scenarios/enrichment-conversion.test.ts
- [ ] T064 [P] [US5] Create scenario test for prioritization by centrality in tests/scenarios/enrichment-priority.test.ts
- [ ] T065 [P] [US5] Create unit test for retry with backoff in tests/unit/retry-backoff.test.ts

### Implementation for User Story 5

- [ ] T066 [P] [US5] Implement Firecrawl web scraping tool in src/mastra/tools/firecrawl/web-search.ts
- [ ] T067 [P] [US5] Implement data validation and unit conversion tool in src/mastra/tools/firecrawl/data-validator.ts
- [ ] T068 [US5] Create Enricher agent in src/mastra/agents/enricher.ts with Firecrawl tools
- [ ] T069 [US5] Implement gap-filling workflow in src/mastra/workflows/gap-filling.ts
- [ ] T070 [US5] Add incomplete node detection step to gap-filling workflow (FR-022)
- [ ] T071 [US5] Add centrality-based prioritization step (FR-025)
- [ ] T072 [US5] Add external search step with retry logic (3x exponential backoff per FR-025a)
- [ ] T073 [US5] Add admin alerting on enrichment failure step (FR-025b)
- [ ] T074 [US5] Add audit logging for all enrichment actions in gap-filling workflow

**Checkpoint**: All user stories (1-5) should now be independently functional

---

## Phase 8: Learning & Memory (Cross-Cutting)

**Purpose**: Implement learning from feedback capabilities (FR-016, FR-017, FR-018)

- [ ] T075 [P] Implement CorrectionRule storage in src/mastra/memory/correction-rules.ts
- [ ] T076 Implement rejected merge pattern learning in Resolver agent (FR-016)
- [ ] T077 Add pattern matching check before proposing merges in deep-deduplication workflow (FR-017)
- [ ] T078 Configure shared memory context between agents in src/mastra/index.ts (FR-018)

---

## Phase 9: Safety Guardrails (Cross-Cutting)

**Purpose**: Implement safety checks per FR-030, FR-031

- [ ] T079 [P] Implement catastrophic operation detection in src/lib/safety-guards.ts (prevent DROP DATABASE etc. per FR-030)
- [ ] T080 Implement read-only query mode for chat interface queries (FR-031)
- [ ] T081 [P] Implement bridge node detection tool in src/mastra/tools/analysis/bridge-detector.ts (betweenness centrality per FR-009)
- [ ] T082 Add bridge node protection check to merge operations (require approval regardless of confidence)

---

## Phase 10: Polish & Cross-Cutting Concerns

**Purpose**: Improvements that affect multiple user stories

- [ ] T083 [P] Add schema validation step to morning-hygiene workflow (FR-020, FR-021)
- [ ] T084 [P] Implement audit log retention purge (1-year per FR-026a/b)
- [ ] T085 [P] Add metrics collection for Prometheus in src/lib/metrics.ts (FR-029)
- [ ] T086 Implement workflow state persistence recovery on restart (FR-028)
- [ ] T087 [P] Add circuit breaker pattern to external API calls in src/lib/circuit-breaker.ts
- [ ] T088 Code cleanup and TypeScript strict mode validation
- [ ] T089 Performance optimization (ensure <5s per item evaluation per plan.md)
- [ ] T090 Run quickstart.md validation (end-to-end smoke test)
- [ ] T091 Security review of all API endpoints

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion - BLOCKS all user stories
- **User Stories (Phase 3-7)**: All depend on Foundational phase completion
  - User stories can proceed in parallel (if staffed)
  - Or sequentially in priority order (P1 → P2 → P3 → P4 → P5)
- **Learning & Memory (Phase 8)**: Depends on US2 (duplicate resolution) for pattern learning
- **Safety Guardrails (Phase 9)**: Can run parallel to Phase 8
- **Polish (Phase 10)**: Depends on all user stories being complete

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Foundational - No dependencies on other stories
- **User Story 2 (P2)**: Can start after Foundational - Shares analyst agent with US1
- **User Story 3 (P3)**: Can start after Foundational - Uses audit logs from US1/US2
- **User Story 4 (P4)**: Depends on US3 (Head Gardener agent) - Extends chat interface
- **User Story 5 (P5)**: Can start after Foundational - Independent enrichment workflow

### Within Each User Story

- Tests MUST be written and FAIL before implementation
- Tools before agents
- Agents before workflows
- Workflows before API endpoints
- API endpoints before UI
- Story complete before moving to next priority

### Parallel Opportunities

- All Setup tasks marked [P] can run in parallel
- All Foundational tasks marked [P] can run in parallel
- Once Foundational phase completes:
  - US1 and US2 can start in parallel
  - US3 can start in parallel (uses different agent)
  - US5 can start in parallel (independent workflow)
- Within each story, all tasks marked [P] can run in parallel
- Different team members can work on different stories simultaneously

---

## Parallel Example: User Story 1

```bash
# Launch all tests for User Story 1 together:
Task: T016 "Create scenario test for empty orphan deletion in tests/scenarios/orphan-cleanup.test.ts"
Task: T017 "Create scenario test for valuable orphan preservation in tests/scenarios/orphan-preservation.test.ts"
Task: T018 "Create unit test for WCC algorithm wrapper in tests/unit/wcc-analysis.test.ts"

# After tests written, launch parallel tool implementations:
Task: T019 "Implement WCC graph algorithm tool in src/mastra/tools/analysis/wcc.ts"
Task: T020 "Implement orphan classification tool in src/mastra/tools/analysis/orphan-classifier.ts"
```

## Parallel Example: Foundational Phase

```bash
# Launch all parallelizable foundational tasks:
Task: T010 "Implement append-only audit logger in src/lib/audit-logger.ts"
Task: T011 "Configure LibSQL storage for Mastra in src/mastra/memory/schemas.ts"
Task: T013 "Implement cron scheduler wrapper in src/lib/scheduler.ts"
Task: T015 "Implement error handling utilities in src/lib/errors.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (T001-T007)
2. Complete Phase 2: Foundational (T008-T015) **CRITICAL**
3. Complete Phase 3: User Story 1 (T016-T026)
4. **STOP and VALIDATE**: Test orphan cleanup independently
5. Deploy/demo if ready - System can clean orphans automatically!

### Incremental Delivery

1. Complete Setup + Foundational → Foundation ready
2. Add User Story 1 → Test independently → Deploy (MVP: Autonomous Orphan Cleanup)
3. Add User Story 2 → Test independently → Deploy (Human-in-the-loop Deduplication)
4. Add User Story 3 → Test independently → Deploy (Status Queries)
5. Add User Story 4 → Test independently → Deploy (Manual Triggers)
6. Add User Story 5 → Test independently → Deploy (Data Enrichment)
7. Complete Phases 8-10 → Full feature complete

### Parallel Team Strategy

With multiple developers:

1. Team completes Setup + Foundational together (T001-T015)
2. Once Foundational is done:
   - Developer A: User Story 1 (orphan cleanup)
   - Developer B: User Story 2 (duplicate resolution)
   - Developer C: User Story 5 (enrichment)
3. After US1/US2 complete:
   - Developer A: User Story 3 (status queries)
   - Developer B: User Story 4 (manual triggers)
4. All: Phases 8-10 (learning, safety, polish)

---

## Summary

| Phase | Tasks | Parallel Tasks |
|-------|-------|----------------|
| Phase 1: Setup | 7 | 4 |
| Phase 2: Foundational | 8 | 5 |
| Phase 3: US1 - Orphan Cleanup | 11 | 5 |
| Phase 4: US2 - Duplicate Resolution | 15 | 5 |
| Phase 5: US3 - Health Inquiries | 13 | 8 |
| Phase 6: US4 - Manual Triggers | 8 | 3 |
| Phase 7: US5 - Enrichment | 12 | 5 |
| Phase 8: Learning | 4 | 1 |
| Phase 9: Safety | 4 | 2 |
| Phase 10: Polish | 9 | 5 |
| **Total** | **91** | **43** |

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Each user story should be independently completable and testable
- Verify tests fail before implementing
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
- Avoid: vague tasks, same file conflicts, cross-story dependencies that break independence
