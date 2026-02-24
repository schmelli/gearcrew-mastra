/**
 * Price Discovery API Endpoint
 *
 * POST /api/price-discovery
 *   Triggers the price-discovery workflow (async, fire-and-forget).
 *   Returns 202 Accepted with { runId }.
 *
 * GET /api/price-discovery?runId=xxx
 *   Returns workflow run status.
 *
 * Authorization: Bearer {GEARGRAPH_API_KEY}
 */

import { NextRequest, NextResponse } from 'next/server';

// Force dynamic rendering — never pre-render at build time
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { z } from 'zod';
import { executePriceDiscoveryWorkflow } from '@/mastra/workflows/price-discovery';
import { getLibSQLClient } from '@/mastra/index';

// ============================================================================
// Auth
// ============================================================================

function authenticate(request: NextRequest): boolean {
  const apiKey = process.env.GEARGRAPH_API_KEY;
  if (!apiKey) return false;
  const auth = request.headers.get('Authorization');
  return auth === `Bearer ${apiKey}`;
}

// ============================================================================
// POST /api/price-discovery
// ============================================================================

const TriggerRequestSchema = z.object({
  gearItemId: z.string().min(1),
  brand: z.string().nullable().optional(),
  name: z.string().min(1),
  productUrl: z.string().url().nullable().optional(),
});

export async function POST(request: NextRequest) {
  if (!authenticate(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = TriggerRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.issues },
      { status: 400 }
    );
  }

  const { gearItemId, brand, name, productUrl } = parsed.data;

  // Start workflow asynchronously — do not await
  let pendingRunId: string | null = null;

  const workflowPromise = executePriceDiscoveryWorkflow({
    gearItemId,
    brand: brand ?? null,
    name,
    productUrl: productUrl ?? null,
  });

  // Brief wait to let workflow record its runId in DB
  await new Promise<void>((resolve) => setTimeout(resolve, 80));

  // Get the runId from DB
  try {
    const db = getLibSQLClient();
    const result = await db.execute({
      sql: `SELECT id FROM workflow_runs
            WHERE workflow_name = 'price-discovery' AND status = 'running'
            ORDER BY started_at DESC LIMIT 1`,
      args: [],
    });
    pendingRunId = result.rows[0]?.id as string | null;
  } catch {
    // Non-critical — we'll just return without a runId
  }

  // Handle case where workflow completed immediately (unlikely but possible)
  if (!pendingRunId) {
    try {
      const result = await workflowPromise;
      return NextResponse.json({ runId: result.runId, status: result.status }, { status: 202 });
    } catch {
      return NextResponse.json({ error: 'Price discovery workflow failed to start' }, { status: 500 });
    }
  }

  // Keep the promise alive but don't block the response
  workflowPromise.catch((err: unknown) => {
    console.error(`[PriceDiscovery] Workflow ${pendingRunId} failed:`, err);
  });

  return NextResponse.json({ runId: pendingRunId }, { status: 202 });
}

// ============================================================================
// GET /api/price-discovery?runId=xxx
// ============================================================================

export async function GET(request: NextRequest) {
  if (!authenticate(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const runId = request.nextUrl.searchParams.get('runId');
  if (!runId) {
    return NextResponse.json({ error: 'runId query parameter is required' }, { status: 400 });
  }

  try {
    const db = getLibSQLClient();
    const result = await db.execute({
      sql: `SELECT id, status, started_at, completed_at, result_summary, error
            FROM workflow_runs
            WHERE id = ? AND workflow_name = 'price-discovery'`,
      args: [runId],
    });

    if (result.rows.length === 0) {
      return NextResponse.json({ error: 'Run not found' }, { status: 404 });
    }

    const row = result.rows[0];
    return NextResponse.json({
      runId: row.id,
      status: row.status,
      startedAt: row.started_at,
      completedAt: row.completed_at ?? null,
      result: row.result_summary ? JSON.parse(row.result_summary as string) : null,
      error: row.error ?? null,
    });
  } catch (error) {
    console.error('[PriceDiscovery] GET failed:', error);
    return NextResponse.json({ error: 'Failed to get run status' }, { status: 500 });
  }
}
