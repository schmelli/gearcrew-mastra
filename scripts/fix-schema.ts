/**
 * Fix schema mismatch - add missing columns
 */

import { createClient } from '@libsql/client';

async function main() {
  const client = createClient({ url: 'file:./data/memory.db' });

  try {
    // Check current columns
    const before = await client.execute("PRAGMA table_info(workflow_runs)");
    const existingCols = before.rows.map(r => r.name as string);
    console.log('Existing columns:', existingCols.join(', '));

    // Columns the API expects
    const neededColumns = [
      { name: 'workflow_name', type: 'TEXT' },
      { name: 'result_summary', type: 'TEXT' },
      { name: 'started_at', type: 'TEXT' },
    ];

    for (const col of neededColumns) {
      if (!existingCols.includes(col.name)) {
        await client.execute(`ALTER TABLE workflow_runs ADD COLUMN ${col.name} ${col.type}`);
        console.log(`Added ${col.name} column`);
      }
    }

    // Verify
    const after = await client.execute("PRAGMA table_info(workflow_runs)");
    console.log('\nFinal columns:', after.rows.map(r => r.name).join(', '));
  } finally {
    client.close();
  }
}

main().catch(console.error);
