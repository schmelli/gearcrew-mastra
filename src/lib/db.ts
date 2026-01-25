/**
 * LibSQL Database Client
 *
 * Separate module to avoid circular imports with mastra/index.
 * All database access should use this module.
 */

import { createClient } from '@libsql/client';

const LIBSQL_URL = process.env.LIBSQL_URL ?? 'file:/data/memory.db';

let libsqlClient: ReturnType<typeof createClient> | null = null;

/**
 * Get the LibSQL client instance.
 * Uses lazy initialization to avoid issues during Next.js build.
 */
export function getLibSQLClient(): ReturnType<typeof createClient> {
  if (!libsqlClient) {
    libsqlClient = createClient({
      url: LIBSQL_URL,
    });
  }
  return libsqlClient;
}

/**
 * Reset the client (useful for testing)
 */
export function resetLibSQLClient(): void {
  libsqlClient = null;
}
