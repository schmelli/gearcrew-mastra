/**
 * Initialize the local LibSQL database with the required schema
 * Run with: npx tsx scripts/init-db.ts
 */

import { createClient } from '@libsql/client';
import { LIBSQL_SCHEMA } from '../src/mastra/memory/schemas';

async function main() {
  const dbUrl = process.env.LIBSQL_URL ?? 'file:./data/memory.db';
  console.log(`Connecting to: ${dbUrl}`);

  const client = createClient({ url: dbUrl });

  console.log('Initializing database schema...');

  // Split and execute each statement
  const statements = LIBSQL_SCHEMA.split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0);

  let success = 0;
  let errors = 0;

  for (const stmt of statements) {
    try {
      await client.execute(stmt + ';');
      success++;
    } catch (e) {
      errors++;
      console.log('Statement failed:', stmt.substring(0, 60) + '...');
      console.error('Error:', (e as Error).message);
    }
  }

  console.log(`\nExecuted ${success} statements successfully, ${errors} errors`);

  // Verify tables
  const tables = await client.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
  console.log('\nTables created:');
  tables.rows.forEach(r => console.log(`  - ${r.name}`));

  client.close();
}

main().catch(console.error);
