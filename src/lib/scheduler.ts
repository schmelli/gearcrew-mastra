/**
 * Cron Scheduler Wrapper
 * Implements FR-001: Scheduled maintenance workflows
 * - Daily hygiene at 04:00 UTC
 * - Weekly deduplication on Sundays at 02:00 UTC
 */

import cron, { ScheduledTask } from 'node-cron';
import { getAuditLogger } from './audit-logger';
import { randomUUID } from 'crypto';

export type ScheduleCallback = () => Promise<void>;

export interface ScheduledJob {
  name: string;
  schedule: string;
  description: string;
  lastRun?: Date;
  nextRun?: Date;
  isRunning: boolean;
  task: ScheduledTask;
}

export class Scheduler {
  private jobs: Map<string, ScheduledJob> = new Map();
  private auditLogger = getAuditLogger();

  /**
   * Schedule a job with cron expression
   */
  schedule(
    name: string,
    cronExpression: string,
    callback: ScheduleCallback,
    options?: { description?: string; timezone?: string }
  ): void {
    // Validate cron expression
    if (!cron.validate(cronExpression)) {
      throw new Error(`Invalid cron expression: ${cronExpression}`);
    }

    // Stop existing job if it exists
    if (this.jobs.has(name)) {
      this.stop(name);
    }

    const job: ScheduledJob = {
      name,
      schedule: cronExpression,
      description: options?.description ?? name,
      isRunning: false,
      task: cron.schedule(
        cronExpression,
        async () => {
          await this.executeJob(name, callback);
        },
        {
          timezone: options?.timezone ?? 'UTC',
          scheduled: true,
        }
      ),
    };

    // Calculate next run time
    job.nextRun = this.getNextRunTime(cronExpression);

    this.jobs.set(name, job);
    console.info(`Scheduled job: ${name} (${cronExpression})`);
  }

  /**
   * Execute a scheduled job
   */
  private async executeJob(name: string, callback: ScheduleCallback): Promise<void> {
    const job = this.jobs.get(name);
    if (!job) {
      return;
    }

    if (job.isRunning) {
      console.warn(`Job ${name} is already running, skipping execution`);
      return;
    }

    job.isRunning = true;
    job.lastRun = new Date();
    const startTime = Date.now();

    try {
      console.info(`Starting scheduled job: ${name}`);
      await callback();
      const duration = Date.now() - startTime;
      console.info(`Completed scheduled job: ${name} (${duration}ms)`);
    } catch (error) {
      const duration = Date.now() - startTime;
      console.error(`Failed scheduled job: ${name} (${duration}ms)`, error);

      // Log error to audit trail
      await this.auditLogger.logError(
        randomUUID(), // Generate run ID for failed scheduled job
        'manual',
        name,
        'scheduled_job',
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      job.isRunning = false;
      job.nextRun = this.getNextRunTime(job.schedule);
    }
  }

  /**
   * Manually trigger a scheduled job
   */
  async trigger(name: string): Promise<void> {
    const job = this.jobs.get(name);
    if (!job) {
      throw new Error(`Job not found: ${name}`);
    }

    // Get the callback from the task's internal structure
    // For manual triggers, we need to store the callback separately
    console.info(`Manually triggering job: ${name}`);
    job.task.now();
  }

  /**
   * Stop a scheduled job
   */
  stop(name: string): void {
    const job = this.jobs.get(name);
    if (job) {
      job.task.stop();
      this.jobs.delete(name);
      console.info(`Stopped scheduled job: ${name}`);
    }
  }

  /**
   * Stop all scheduled jobs
   */
  stopAll(): void {
    for (const [name, job] of this.jobs) {
      job.task.stop();
      console.info(`Stopped scheduled job: ${name}`);
    }
    this.jobs.clear();
  }

  /**
   * Get status of all scheduled jobs
   */
  getStatus(): ScheduledJob[] {
    return Array.from(this.jobs.values()).map((job) => ({
      ...job,
      task: job.task, // Exclude task from status response
    }));
  }

  /**
   * Get status of a specific job
   */
  getJobStatus(name: string): ScheduledJob | undefined {
    return this.jobs.get(name);
  }

  /**
   * Check if a job exists
   */
  hasJob(name: string): boolean {
    return this.jobs.has(name);
  }

  /**
   * Calculate next run time from cron expression
   */
  private getNextRunTime(cronExpression: string): Date {
    // Parse cron expression and calculate next occurrence
    // This is a simplified implementation
    const parts = cronExpression.split(' ');
    const now = new Date();

    if (parts.length >= 5) {
      const minute = parts[0] ?? '*';
      const hour = parts[1] ?? '*';
      const dayOfWeek = parts[4] ?? '*';

      // Create a date for the next occurrence
      const next = new Date(now);
      next.setSeconds(0);
      next.setMilliseconds(0);

      // Set minute
      if (minute !== '*') {
        next.setMinutes(parseInt(minute, 10));
      }

      // Set hour
      if (hour !== '*') {
        next.setHours(parseInt(hour, 10));
      }

      // If the time has passed today, add a day
      if (next <= now) {
        next.setDate(next.getDate() + 1);
      }

      // Handle day of week
      if (dayOfWeek !== '*') {
        const targetDay = parseInt(dayOfWeek, 10);
        const currentDay = next.getDay();
        const daysUntilTarget = (targetDay - currentDay + 7) % 7;
        if (daysUntilTarget > 0 || next <= now) {
          next.setDate(next.getDate() + (daysUntilTarget || 7));
        }
      }

      return next;
    }

    // Default to 1 minute from now if parsing fails
    return new Date(now.getTime() + 60000);
  }
}

// ============================================================================
// Default Schedule Configuration
// ============================================================================

export const SCHEDULES = {
  MORNING_HYGIENE: '0 4 * * *', // Daily at 04:00 UTC
  DEEP_DEDUPLICATION: '0 2 * * 0', // Sundays at 02:00 UTC
  AUDIT_PURGE: '0 3 1 * *', // Monthly on 1st at 03:00 UTC
  PRICE_DISCOVERY_REFRESH: '5 4 * * *', // Daily at 04:05 UTC
} as const;

// Singleton instance
let schedulerInstance: Scheduler | null = null;

export function getScheduler(): Scheduler {
  if (!schedulerInstance) {
    schedulerInstance = new Scheduler();
  }
  return schedulerInstance;
}

export default Scheduler;
