/**
 * T085: Prometheus Metrics Collection
 * Implements FR-029: Metrics collection for monitoring
 */

// ============================================================================
// Types
// ============================================================================

export type MetricType = 'counter' | 'gauge' | 'histogram';

export interface MetricDefinition {
  name: string;
  help: string;
  type: MetricType;
  labelNames?: string[];
}

export interface MetricValue {
  value: number;
  labels?: Record<string, string>;
  timestamp?: number;
}

// ============================================================================
// Metric Definitions
// ============================================================================

export const METRIC_DEFINITIONS: Record<string, MetricDefinition> = {
  // Workflow metrics
  workflow_runs_total: {
    name: 'geargraph_workflow_runs_total',
    help: 'Total number of workflow runs',
    type: 'counter',
    labelNames: ['workflow_name', 'status'],
  },
  workflow_duration_seconds: {
    name: 'geargraph_workflow_duration_seconds',
    help: 'Workflow run duration in seconds',
    type: 'histogram',
    labelNames: ['workflow_name'],
  },

  // Graph metrics
  graph_nodes_total: {
    name: 'geargraph_nodes_total',
    help: 'Total number of nodes in the graph',
    type: 'gauge',
    labelNames: ['label'],
  },
  graph_relationships_total: {
    name: 'geargraph_relationships_total',
    help: 'Total number of relationships in the graph',
    type: 'gauge',
    labelNames: ['type'],
  },
  graph_orphans_total: {
    name: 'geargraph_orphans_total',
    help: 'Number of orphan nodes',
    type: 'gauge',
  },
  graph_duplicates_detected: {
    name: 'geargraph_duplicates_detected_total',
    help: 'Number of duplicate pairs detected',
    type: 'counter',
  },

  // Operation metrics
  merges_executed_total: {
    name: 'geargraph_merges_executed_total',
    help: 'Total number of merge operations executed',
    type: 'counter',
    labelNames: ['confidence_level'],
  },
  deletions_executed_total: {
    name: 'geargraph_deletions_executed_total',
    help: 'Total number of delete operations executed',
    type: 'counter',
    labelNames: ['entity_type'],
  },
  enrichments_executed_total: {
    name: 'geargraph_enrichments_executed_total',
    help: 'Total number of enrichment operations executed',
    type: 'counter',
    labelNames: ['field'],
  },

  // Approval metrics
  approvals_pending: {
    name: 'geargraph_approvals_pending',
    help: 'Number of pending approvals',
    type: 'gauge',
  },
  approvals_processed_total: {
    name: 'geargraph_approvals_processed_total',
    help: 'Total approvals processed',
    type: 'counter',
    labelNames: ['decision'],
  },

  // Performance metrics
  evaluation_duration_seconds: {
    name: 'geargraph_evaluation_duration_seconds',
    help: 'Duration of duplicate evaluation in seconds',
    type: 'histogram',
  },
  embedding_generation_duration_seconds: {
    name: 'geargraph_embedding_generation_seconds',
    help: 'Duration of embedding generation',
    type: 'histogram',
  },

  // Error metrics
  errors_total: {
    name: 'geargraph_errors_total',
    help: 'Total number of errors',
    type: 'counter',
    labelNames: ['workflow_name', 'error_type'],
  },

  // Memory metrics
  correction_rules_active: {
    name: 'geargraph_correction_rules_active',
    help: 'Number of active correction rules',
    type: 'gauge',
  },

  // External API metrics
  external_api_requests_total: {
    name: 'geargraph_external_api_requests_total',
    help: 'Total external API requests',
    type: 'counter',
    labelNames: ['api', 'status'],
  },
  external_api_duration_seconds: {
    name: 'geargraph_external_api_duration_seconds',
    help: 'External API request duration',
    type: 'histogram',
    labelNames: ['api'],
  },
};

// ============================================================================
// Metrics Collector
// ============================================================================

class MetricsCollector {
  private counters: Map<string, Map<string, number>> = new Map();
  private gauges: Map<string, Map<string, number>> = new Map();
  private histograms: Map<string, Map<string, number[]>> = new Map();

  /**
   * Increment a counter
   */
  increment(name: string, labels?: Record<string, string>, value = 1): void {
    const labelKey = this.formatLabels(labels);
    const counters = this.counters.get(name) || new Map();
    counters.set(labelKey, (counters.get(labelKey) || 0) + value);
    this.counters.set(name, counters);
  }

  /**
   * Set a gauge value
   */
  set(name: string, value: number, labels?: Record<string, string>): void {
    const labelKey = this.formatLabels(labels);
    const gauges = this.gauges.get(name) || new Map();
    gauges.set(labelKey, value);
    this.gauges.set(name, gauges);
  }

  /**
   * Observe a histogram value
   */
  observe(name: string, value: number, labels?: Record<string, string>): void {
    const labelKey = this.formatLabels(labels);
    const histograms = this.histograms.get(name) || new Map();
    const values = histograms.get(labelKey) || [];
    values.push(value);
    histograms.set(labelKey, values);
    this.histograms.set(name, histograms);
  }

  /**
   * Get all metrics in Prometheus format
   */
  getPrometheusMetrics(): string {
    const lines: string[] = [];

    // Export counters
    for (const [name, values] of this.counters) {
      const def = Object.values(METRIC_DEFINITIONS).find((d) => d.name === name);
      if (def) {
        lines.push(`# HELP ${def.name} ${def.help}`);
        lines.push(`# TYPE ${def.name} counter`);
      }
      for (const [labels, value] of values) {
        lines.push(`${name}${labels} ${value}`);
      }
    }

    // Export gauges
    for (const [name, values] of this.gauges) {
      const def = Object.values(METRIC_DEFINITIONS).find((d) => d.name === name);
      if (def) {
        lines.push(`# HELP ${def.name} ${def.help}`);
        lines.push(`# TYPE ${def.name} gauge`);
      }
      for (const [labels, value] of values) {
        lines.push(`${name}${labels} ${value}`);
      }
    }

    // Export histograms (simplified - just sum and count)
    for (const [name, values] of this.histograms) {
      const def = Object.values(METRIC_DEFINITIONS).find((d) => d.name === name);
      if (def) {
        lines.push(`# HELP ${def.name} ${def.help}`);
        lines.push(`# TYPE ${def.name} histogram`);
      }
      for (const [labels, observations] of values) {
        const sum = observations.reduce((a, b) => a + b, 0);
        const count = observations.length;
        lines.push(`${name}_sum${labels} ${sum}`);
        lines.push(`${name}_count${labels} ${count}`);

        // Add buckets
        const buckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
        for (const bucket of buckets) {
          const bucketCount = observations.filter((v) => v <= bucket).length;
          lines.push(`${name}_bucket${this.addLabel(labels, 'le', bucket.toString())} ${bucketCount}`);
        }
        lines.push(`${name}_bucket${this.addLabel(labels, 'le', '+Inf')} ${count}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Get metrics as JSON
   */
  getMetricsJson(): Record<string, unknown> {
    const result: Record<string, unknown> = {
      counters: {},
      gauges: {},
      histograms: {},
    };

    for (const [name, values] of this.counters) {
      (result.counters as Record<string, unknown>)[name] = Object.fromEntries(values);
    }

    for (const [name, values] of this.gauges) {
      (result.gauges as Record<string, unknown>)[name] = Object.fromEntries(values);
    }

    for (const [name, values] of this.histograms) {
      const histData: Record<string, unknown> = {};
      for (const [labels, observations] of values) {
        histData[labels] = {
          count: observations.length,
          sum: observations.reduce((a, b) => a + b, 0),
          avg:
            observations.length > 0
              ? observations.reduce((a, b) => a + b, 0) / observations.length
              : 0,
          min: observations.length > 0 ? Math.min(...observations) : 0,
          max: observations.length > 0 ? Math.max(...observations) : 0,
        };
      }
      (result.histograms as Record<string, unknown>)[name] = histData;
    }

    return result;
  }

  /**
   * Reset all metrics
   */
  reset(): void {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
  }

  /**
   * Format labels as Prometheus label string
   */
  private formatLabels(labels?: Record<string, string>): string {
    if (!labels || Object.keys(labels).length === 0) {
      return '';
    }

    const parts = Object.entries(labels)
      .map(([key, value]) => `${key}="${value}"`)
      .join(',');

    return `{${parts}}`;
  }

  /**
   * Add a label to an existing label string
   */
  private addLabel(existing: string, key: string, value: string): string {
    if (!existing) {
      return `{${key}="${value}"}`;
    }
    // Remove closing brace, add new label
    return existing.slice(0, -1) + `,${key}="${value}"}`;
  }
}

// ============================================================================
// Convenience Functions
// ============================================================================

const collector = new MetricsCollector();

/**
 * Increment a counter metric
 */
export function incrementCounter(
  metric: keyof typeof METRIC_DEFINITIONS,
  labels?: Record<string, string>
): void {
  const def = METRIC_DEFINITIONS[metric];
  if (def && def.type === 'counter') {
    collector.increment(def.name, labels);
  }
}

/**
 * Set a gauge metric
 */
export function setGauge(
  metric: keyof typeof METRIC_DEFINITIONS,
  value: number,
  labels?: Record<string, string>
): void {
  const def = METRIC_DEFINITIONS[metric];
  if (def && def.type === 'gauge') {
    collector.set(def.name, value, labels);
  }
}

/**
 * Observe a histogram metric
 */
export function observeHistogram(
  metric: keyof typeof METRIC_DEFINITIONS,
  value: number,
  labels?: Record<string, string>
): void {
  const def = METRIC_DEFINITIONS[metric];
  if (def && def.type === 'histogram') {
    collector.observe(def.name, value, labels);
  }
}

/**
 * Create a timer for measuring duration
 */
export function startTimer(
  metric: keyof typeof METRIC_DEFINITIONS,
  labels?: Record<string, string>
): () => void {
  const start = Date.now();
  return () => {
    const duration = (Date.now() - start) / 1000;
    observeHistogram(metric, duration, labels);
  };
}

/**
 * Get metrics in Prometheus format
 */
export function getPrometheusMetrics(): string {
  return collector.getPrometheusMetrics();
}

/**
 * Get metrics as JSON
 */
export function getMetricsJson(): Record<string, unknown> {
  return collector.getMetricsJson();
}

/**
 * Reset all metrics
 */
export function resetMetrics(): void {
  collector.reset();
}

/**
 * Get the collector instance (for testing)
 */
export function getMetricsCollector(): MetricsCollector {
  return collector;
}

export default {
  incrementCounter,
  setGauge,
  observeHistogram,
  startTimer,
  getPrometheusMetrics,
  getMetricsJson,
  resetMetrics,
};
