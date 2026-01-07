/**
 * Memgraph Bolt Client Wrapper
 * Provides connection management and query execution for Memgraph database
 */

import neo4j, { Driver, Session, Record as Neo4jRecord, QueryResult } from 'neo4j-driver';

export interface MemgraphConfig {
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export interface QueryOptions {
  timeout?: number;
  readOnly?: boolean;
}

export class MemgraphClient {
  private driver: Driver | null = null;
  private config: MemgraphConfig;

  constructor(config?: Partial<MemgraphConfig>) {
    this.config = {
      host: config?.host ?? process.env.MEMGRAPH_HOST ?? 'localhost',
      port: config?.port ?? parseInt(process.env.MEMGRAPH_PORT ?? '7687', 10),
      username: config?.username ?? process.env.MEMGRAPH_USER ?? 'memgraph',
      password: config?.password ?? process.env.MEMGRAPH_PASSWORD ?? '',
    };
  }

  /**
   * Get or create the Neo4j driver instance
   */
  private getDriver(): Driver {
    if (!this.driver) {
      const uri = `bolt://${this.config.host}:${this.config.port}`;
      this.driver = neo4j.driver(
        uri,
        neo4j.auth.basic(this.config.username ?? '', this.config.password ?? ''),
        {
          maxConnectionLifetime: 3 * 60 * 60 * 1000, // 3 hours
          maxConnectionPoolSize: 50,
          connectionAcquisitionTimeout: 2 * 60 * 1000, // 2 minutes
        }
      );
    }
    return this.driver;
  }

  /**
   * Execute a Cypher query with parameters
   */
  async query<T = Record<string, unknown>>(
    cypher: string,
    params: Record<string, unknown> = {},
    options: QueryOptions = {}
  ): Promise<T[]> {
    const driver = this.getDriver();
    const session: Session = driver.session({
      defaultAccessMode: options.readOnly ? neo4j.session.READ : neo4j.session.WRITE,
    });

    try {
      const result: QueryResult = await session.run(cypher, params);
      return result.records.map((record: Neo4jRecord) => {
        const obj: Record<string, unknown> = {};
        record.keys.forEach((key) => {
          const value = record.get(key);
          obj[key] = this.convertNeo4jValue(value);
        });
        return obj as T;
      });
    } finally {
      await session.close();
    }
  }

  /**
   * Execute a read-only query (for chat interface queries per FR-031)
   */
  async readOnlyQuery<T = Record<string, unknown>>(
    cypher: string,
    params: Record<string, unknown> = {}
  ): Promise<T[]> {
    return this.query<T>(cypher, params, { readOnly: true });
  }

  /**
   * Execute a write query with transaction
   */
  async writeTransaction<T = Record<string, unknown>>(
    cypher: string,
    params: Record<string, unknown> = {}
  ): Promise<T[]> {
    const driver = this.getDriver();
    const session = driver.session({
      defaultAccessMode: neo4j.session.WRITE,
    });

    try {
      const result = await session.executeWrite(async (tx) => {
        return tx.run(cypher, params);
      });
      return result.records.map((record: Neo4jRecord) => {
        const obj: Record<string, unknown> = {};
        record.keys.forEach((key) => {
          obj[key] = this.convertNeo4jValue(record.get(key));
        });
        return obj as T;
      });
    } finally {
      await session.close();
    }
  }

  /**
   * Convert Neo4j-specific types to JavaScript types
   */
  private convertNeo4jValue(value: unknown): unknown {
    if (value === null || value === undefined) {
      return value;
    }

    // Handle Neo4j Integer
    if (neo4j.isInt(value)) {
      return neo4j.integer.toNumber(value);
    }

    // Handle Neo4j Node
    if (this.isNeo4jNode(value)) {
      return {
        id: neo4j.integer.toNumber(value.identity),
        labels: value.labels,
        properties: this.convertProperties(value.properties),
      };
    }

    // Handle Neo4j Relationship
    if (this.isNeo4jRelationship(value)) {
      return {
        id: neo4j.integer.toNumber(value.identity),
        type: value.type,
        startNodeId: neo4j.integer.toNumber(value.start),
        endNodeId: neo4j.integer.toNumber(value.end),
        properties: this.convertProperties(value.properties),
      };
    }

    // Handle arrays
    if (Array.isArray(value)) {
      return value.map((v) => this.convertNeo4jValue(v));
    }

    // Handle objects
    if (typeof value === 'object') {
      return this.convertProperties(value as Record<string, unknown>);
    }

    return value;
  }

  /**
   * Type guard for Neo4j Node
   */
  private isNeo4jNode(value: unknown): value is { identity: unknown; labels: string[]; properties: Record<string, unknown> } {
    return (
      typeof value === 'object' &&
      value !== null &&
      'identity' in value &&
      'labels' in value &&
      'properties' in value
    );
  }

  /**
   * Type guard for Neo4j Relationship
   */
  private isNeo4jRelationship(value: unknown): value is { identity: unknown; type: string; start: unknown; end: unknown; properties: Record<string, unknown> } {
    return (
      typeof value === 'object' &&
      value !== null &&
      'identity' in value &&
      'type' in value &&
      'start' in value &&
      'end' in value
    );
  }

  /**
   * Convert object properties recursively
   */
  private convertProperties(props: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(props)) {
      result[key] = this.convertNeo4jValue(value);
    }
    return result;
  }

  /**
   * Verify connection to Memgraph
   */
  async verifyConnection(): Promise<boolean> {
    try {
      await this.query('RETURN 1 AS connected');
      return true;
    } catch (error) {
      console.error('Failed to connect to Memgraph:', error);
      return false;
    }
  }

  /**
   * Verify MAGE algorithms are available
   */
  async verifyMageAlgorithms(): Promise<{ algorithm: string; available: boolean }[]> {
    const algorithms = [
      'weakly_connected_components',
      'degree_centrality',
      'betweenness_centrality',
    ];

    const results: { algorithm: string; available: boolean }[] = [];

    for (const algo of algorithms) {
      try {
        // Check if procedure exists
        const result = await this.query<{ name: string }>(
          `CALL mg.procedures() YIELD name WHERE name CONTAINS $algo RETURN name`,
          { algo }
        );
        results.push({ algorithm: algo, available: result.length > 0 });
      } catch {
        results.push({ algorithm: algo, available: false });
      }
    }

    return results;
  }

  /**
   * Close the driver connection
   */
  async close(): Promise<void> {
    if (this.driver) {
      await this.driver.close();
      this.driver = null;
    }
  }
}

// Singleton instance
let clientInstance: MemgraphClient | null = null;

export function getMemgraphClient(): MemgraphClient {
  if (!clientInstance) {
    clientInstance = new MemgraphClient();
  }
  return clientInstance;
}

export default MemgraphClient;
