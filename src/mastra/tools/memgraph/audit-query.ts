/**
 * T046: Audit Query Tool
 * Implements FR-010: Query audit log for historical actions
 */

import { getAuditLogger } from '@/lib/audit-logger';
import { AuditEntry, AuditAction, WorkflowType } from '@/types';

export interface AuditQueryOptions {
  from?: Date;
  to?: Date;
  action?: AuditAction;
  entityId?: string;
  workflowType?: WorkflowType;
  workflowRunId?: string;
  limit?: number;
}

export interface AuditQueryResult {
  entries: AuditEntry[];
  total: number;
  summary: {
    byAction: Record<string, number>;
    byWorkflowType: Record<string, number>;
    uniqueEntities: number;
  };
}

export interface TimeRangeSummary {
  period: string;
  totalActions: number;
  creates: number;
  updates: number;
  deletes: number;
  merges: number;
  skips: number;
  flags: number;
  errors: number;
  uniqueEntities: number;
}

/**
 * Query audit log entries with filtering
 */
export async function queryAuditLog(options: AuditQueryOptions): Promise<AuditQueryResult> {
  const logger = getAuditLogger();

  const entries = await logger.query({
    from: options.from,
    to: options.to,
    action: options.action,
    entityId: options.entityId,
    workflowType: options.workflowType,
    workflowRunId: options.workflowRunId,
    limit: options.limit,
  });

  // Calculate summary
  const byAction: Record<string, number> = {};
  const byWorkflowType: Record<string, number> = {};
  const uniqueEntityIds = new Set<string>();

  for (const entry of entries) {
    byAction[entry.action] = (byAction[entry.action] ?? 0) + 1;
    byWorkflowType[entry.workflowType] = (byWorkflowType[entry.workflowType] ?? 0) + 1;
    uniqueEntityIds.add(entry.entityId);
  }

  return {
    entries,
    total: entries.length,
    summary: {
      byAction,
      byWorkflowType,
      uniqueEntities: uniqueEntityIds.size,
    },
  };
}

/**
 * Get today's audit summary
 */
export async function getTodaySummary(): Promise<TimeRangeSummary> {
  const now = new Date();
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);

  return getTimeRangeSummary(startOfDay, now, 'today');
}

/**
 * Get this week's audit summary
 */
export async function getWeekSummary(): Promise<TimeRangeSummary> {
  const now = new Date();
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - now.getDay());
  startOfWeek.setHours(0, 0, 0, 0);

  return getTimeRangeSummary(startOfWeek, now, 'this week');
}

/**
 * Get last 24 hours summary
 */
export async function getLast24HoursSummary(): Promise<TimeRangeSummary> {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  return getTimeRangeSummary(yesterday, now, 'last 24 hours');
}

/**
 * Get summary for a specific time range
 */
async function getTimeRangeSummary(
  from: Date,
  to: Date,
  period: string
): Promise<TimeRangeSummary> {
  const logger = getAuditLogger();
  const summary = await logger.getSummary(from, to);

  return {
    period,
    totalActions: summary.totalActions,
    creates: summary.byAction.create ?? 0,
    updates: summary.byAction.update ?? 0,
    deletes: summary.byAction.delete ?? 0,
    merges: summary.byAction.merge ?? 0,
    skips: summary.byAction.skip ?? 0,
    flags: summary.byAction.flag ?? 0,
    errors: summary.byAction.error ?? 0,
    uniqueEntities: summary.uniqueEntities,
  };
}

/**
 * Get actions for a specific entity
 */
export async function getEntityHistory(entityId: string): Promise<AuditEntry[]> {
  const logger = getAuditLogger();
  return logger.query({ entityId });
}

/**
 * Get actions from a specific workflow run
 */
export async function getWorkflowRunActions(workflowRunId: string): Promise<AuditEntry[]> {
  const logger = getAuditLogger();
  return logger.query({ workflowRunId });
}

/**
 * Search audit log by entity type
 */
export async function searchByEntityType(
  entityType: string,
  options?: { from?: Date; to?: Date; limit?: number }
): Promise<AuditEntry[]> {
  const logger = getAuditLogger();
  const entries = await logger.query({
    from: options?.from,
    to: options?.to,
    limit: options?.limit,
  });

  return entries.filter((e) => e.entityType === entityType);
}

/**
 * Get recent errors from audit log
 */
export async function getRecentErrors(limit: number = 10): Promise<AuditEntry[]> {
  const logger = getAuditLogger();
  return logger.query({ action: 'error', limit });
}

/**
 * Format audit entries for human-readable output
 */
export function formatAuditEntry(entry: AuditEntry): string {
  const timestamp = new Date(entry.timestamp).toLocaleString();
  const action = entry.action.toUpperCase();

  let description = `[${timestamp}] ${action} ${entry.entityType} ${entry.entityId}`;

  if (entry.reasoning) {
    description += ` - ${entry.reasoning}`;
  }

  if (entry.confidence !== undefined) {
    description += ` (confidence: ${(entry.confidence * 100).toFixed(1)}%)`;
  }

  return description;
}

/**
 * Format summary for chat response
 */
export function formatSummaryForChat(summary: TimeRangeSummary): string {
  const parts: string[] = [];

  parts.push(`**${summary.period.charAt(0).toUpperCase() + summary.period.slice(1)} Summary**`);
  parts.push(`Total actions: ${summary.totalActions}`);

  if (summary.merges > 0) {
    parts.push(`- Merges: ${summary.merges}`);
  }
  if (summary.deletes > 0) {
    parts.push(`- Deletions: ${summary.deletes}`);
  }
  if (summary.flags > 0) {
    parts.push(`- Flagged for review: ${summary.flags}`);
  }
  if (summary.errors > 0) {
    parts.push(`- Errors: ${summary.errors}`);
  }

  parts.push(`Unique entities affected: ${summary.uniqueEntities}`);

  return parts.join('\n');
}

export default {
  queryAuditLog,
  getTodaySummary,
  getWeekSummary,
  getLast24HoursSummary,
  getEntityHistory,
  getWorkflowRunActions,
  searchByEntityType,
  getRecentErrors,
  formatAuditEntry,
  formatSummaryForChat,
};
