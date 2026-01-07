/**
 * Append-Only Audit Logger
 * Implements FR-026: Log all automated actions to persistent audit trail
 * Format: JSONL (JSON Lines) for efficient append and query
 */

import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import {
  AuditEntry,
  AuditEntrySchema,
  AuditAction,
  WorkflowType,
} from '@/types';

export interface AuditLogConfig {
  logPath: string;
  retentionDays: number;
}

export class AuditLogger {
  private config: AuditLogConfig;
  private writeQueue: AuditEntry[] = [];
  private isWriting = false;

  constructor(config?: Partial<AuditLogConfig>) {
    this.config = {
      logPath: config?.logPath ?? process.env.AUDIT_LOG_PATH ?? '/data/audit.jsonl',
      retentionDays: config?.retentionDays ?? 365, // 1 year per FR-026a
    };
  }

  /**
   * Log an audit entry (append-only)
   */
  async log(entry: Omit<AuditEntry, 'id' | 'timestamp'>): Promise<AuditEntry> {
    const fullEntry: AuditEntry = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      ...entry,
    };

    // Validate entry
    AuditEntrySchema.parse(fullEntry);

    // Add to queue
    this.writeQueue.push(fullEntry);

    // Process queue
    await this.flushQueue();

    return fullEntry;
  }

  /**
   * Convenience method for logging create actions
   */
  async logCreate(
    workflowRunId: string,
    workflowType: WorkflowType,
    entityId: string,
    entityType: string,
    after: Record<string, unknown>,
    options?: { confidence?: number; reasoning?: string; issueId?: string }
  ): Promise<AuditEntry> {
    return this.log({
      workflowRunId,
      workflowType,
      action: 'create',
      entityId,
      entityType,
      before: null,
      after,
      ...options,
    });
  }

  /**
   * Convenience method for logging update actions
   */
  async logUpdate(
    workflowRunId: string,
    workflowType: WorkflowType,
    entityId: string,
    entityType: string,
    before: Record<string, unknown>,
    after: Record<string, unknown>,
    options?: { confidence?: number; reasoning?: string; issueId?: string }
  ): Promise<AuditEntry> {
    return this.log({
      workflowRunId,
      workflowType,
      action: 'update',
      entityId,
      entityType,
      before,
      after,
      ...options,
    });
  }

  /**
   * Convenience method for logging delete actions
   */
  async logDelete(
    workflowRunId: string,
    workflowType: WorkflowType,
    entityId: string,
    entityType: string,
    before: Record<string, unknown>,
    options?: { confidence?: number; reasoning?: string; issueId?: string }
  ): Promise<AuditEntry> {
    return this.log({
      workflowRunId,
      workflowType,
      action: 'delete',
      entityId,
      entityType,
      before,
      after: null,
      ...options,
    });
  }

  /**
   * Convenience method for logging merge actions
   */
  async logMerge(
    workflowRunId: string,
    workflowType: WorkflowType,
    entityId: string,
    entityType: string,
    before: Record<string, unknown>,
    after: Record<string, unknown>,
    options?: { confidence?: number; reasoning?: string; issueId?: string; approvalId?: string }
  ): Promise<AuditEntry> {
    return this.log({
      workflowRunId,
      workflowType,
      action: 'merge',
      entityId,
      entityType,
      before,
      after,
      ...options,
    });
  }

  /**
   * Convenience method for logging skip actions
   * Supports single entityId or array for multi-entity skips (e.g., rejected merges)
   */
  async logSkip(
    workflowRunId: string,
    workflowType: WorkflowType,
    entityId: string | string[],
    entityType: string,
    reasoning?: string,
    options?: { confidence?: number; issueId?: string; correctionRuleId?: string }
  ): Promise<AuditEntry> {
    const id = Array.isArray(entityId) ? entityId.join('|') : entityId;
    return this.log({
      workflowRunId,
      workflowType,
      action: 'skip',
      entityId: id,
      entityType,
      before: null,
      after: Array.isArray(entityId) ? { skippedIds: entityId } : null,
      reasoning,
      ...options,
    });
  }

  /**
   * Convenience method for logging flag actions (queued for review)
   */
  async logFlag(
    workflowRunId: string,
    workflowType: WorkflowType,
    entityId: string,
    entityType: string,
    options?: { confidence?: number; reasoning?: string; issueId?: string }
  ): Promise<AuditEntry> {
    return this.log({
      workflowRunId,
      workflowType,
      action: 'flag',
      entityId,
      entityType,
      before: null,
      after: null,
      ...options,
    });
  }

  /**
   * Convenience method for logging error actions
   */
  async logError(
    workflowRunId: string,
    workflowType: WorkflowType,
    entityId: string,
    entityType: string,
    reasoning: string,
    options?: { issueId?: string }
  ): Promise<AuditEntry> {
    return this.log({
      workflowRunId,
      workflowType,
      action: 'error',
      entityId,
      entityType,
      before: null,
      after: null,
      reasoning,
      ...options,
    });
  }

  /**
   * Flush write queue to disk
   */
  private async flushQueue(): Promise<void> {
    if (this.isWriting || this.writeQueue.length === 0) {
      return;
    }

    this.isWriting = true;

    try {
      const entries = [...this.writeQueue];
      this.writeQueue = [];

      // Ensure directory exists
      const dir = path.dirname(this.config.logPath);
      await fs.mkdir(dir, { recursive: true });

      // Append entries as JSONL
      const lines = entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
      await fs.appendFile(this.config.logPath, lines, 'utf-8');
    } finally {
      this.isWriting = false;

      // Process any entries added during write
      if (this.writeQueue.length > 0) {
        await this.flushQueue();
      }
    }
  }

  /**
   * Query audit log entries
   */
  async query(options: {
    from?: Date;
    to?: Date;
    action?: AuditAction;
    entityId?: string;
    workflowType?: WorkflowType;
    workflowRunId?: string;
    limit?: number;
  }): Promise<AuditEntry[]> {
    try {
      const content = await fs.readFile(this.config.logPath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);

      let entries: AuditEntry[] = lines.map((line) => {
        const parsed = JSON.parse(line);
        return AuditEntrySchema.parse(parsed);
      });

      // Apply filters
      if (options.from) {
        const fromTime = options.from.getTime();
        entries = entries.filter((e) => new Date(e.timestamp).getTime() >= fromTime);
      }

      if (options.to) {
        const toTime = options.to.getTime();
        entries = entries.filter((e) => new Date(e.timestamp).getTime() <= toTime);
      }

      if (options.action) {
        entries = entries.filter((e) => e.action === options.action);
      }

      if (options.entityId) {
        entries = entries.filter((e) => e.entityId === options.entityId);
      }

      if (options.workflowType) {
        entries = entries.filter((e) => e.workflowType === options.workflowType);
      }

      if (options.workflowRunId) {
        entries = entries.filter((e) => e.workflowRunId === options.workflowRunId);
      }

      // Sort by timestamp descending (most recent first)
      entries.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

      // Apply limit
      if (options.limit) {
        entries = entries.slice(0, options.limit);
      }

      return entries;
    } catch (error) {
      // If file doesn't exist, return empty array
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  /**
   * Get summary statistics for a time period
   */
  async getSummary(from: Date, to: Date): Promise<{
    totalActions: number;
    byAction: Record<AuditAction, number>;
    byWorkflowType: Record<WorkflowType, number>;
    uniqueEntities: number;
  }> {
    const entries = await this.query({ from, to });

    const byAction: Record<string, number> = {};
    const byWorkflowType: Record<string, number> = {};
    const uniqueEntityIds = new Set<string>();

    for (const entry of entries) {
      byAction[entry.action] = (byAction[entry.action] ?? 0) + 1;
      byWorkflowType[entry.workflowType] = (byWorkflowType[entry.workflowType] ?? 0) + 1;
      uniqueEntityIds.add(entry.entityId);
    }

    return {
      totalActions: entries.length,
      byAction: byAction as Record<AuditAction, number>,
      byWorkflowType: byWorkflowType as Record<WorkflowType, number>,
      uniqueEntities: uniqueEntityIds.size,
    };
  }

  /**
   * Purge entries older than retention period (FR-026b)
   */
  async purgeOldEntries(): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - this.config.retentionDays);

    try {
      const content = await fs.readFile(this.config.logPath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);

      const cutoffTime = cutoffDate.getTime();
      let purgedCount = 0;

      const keptEntries = lines.filter((line) => {
        try {
          const entry = JSON.parse(line);
          const entryTime = new Date(entry.timestamp).getTime();
          if (entryTime < cutoffTime) {
            purgedCount++;
            return false;
          }
          return true;
        } catch {
          // Keep malformed entries
          return true;
        }
      });

      if (purgedCount > 0) {
        // Write back kept entries
        const newContent = keptEntries.join('\n') + (keptEntries.length > 0 ? '\n' : '');
        await fs.writeFile(this.config.logPath, newContent, 'utf-8');
      }

      return purgedCount;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return 0;
      }
      throw error;
    }
  }
}

// Singleton instance
let loggerInstance: AuditLogger | null = null;

export function getAuditLogger(): AuditLogger {
  if (!loggerInstance) {
    loggerInstance = new AuditLogger();
  }
  return loggerInstance;
}

export default AuditLogger;
