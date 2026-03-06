/**
 * Image Discovery Workflow
 *
 * Bulk-discovers product images for GearItems missing imageUrl.
 * 1. Queries Memgraph for items without imageUrl
 * 2. Tries sourceUrl scrape for og:image (via Firecrawl)
 * 3. Falls back to Serper /images search
 * 4. Validates image URL with HEAD request
 * 5. Writes imageUrl back to Memgraph
 */

import { v4 as uuidv4 } from 'uuid';
import { getMemgraphClient } from '@/lib/memgraph-client';
import { getLibSQLClient } from '@/mastra/index';
import { FirecrawlClient } from '@/mastra/tools/firecrawl/web-search';

// Types
export interface ImageDiscoveryOptions {
  batchSize?: number;
  workflowRunId?: string;
}

export interface ImageDiscoveryResult {
  runId: string;
  status: 'completed' | 'failed';
  itemsProcessed: number;
  imagesFound: number;
  error?: string;
  duration: number;
}

// Step 1: Query items missing imageUrl
async function getItemsMissingImages(batchSize: number): Promise<Array<{
  gearId: string;
  name: string;
  brand: string | null;
  sourceUrl: string | null;
}>> {
  const db = getMemgraphClient();
  return db.query<{ gearId: string; name: string; brand: string | null; sourceUrl: string | null }>(
    `MATCH (g:GearItem) WHERE g.imageUrl IS NULL
     RETURN g.gearId AS gearId, g.name AS name, g.brand AS brand, g.sourceUrl AS sourceUrl
     LIMIT $batchSize`,
    { batchSize }
  );
}

// Step 2: Try to extract og:image from sourceUrl
async function tryOgImage(sourceUrl: string): Promise<string | null> {
  try {
    const client = new FirecrawlClient();
    const result = await client.scrape(sourceUrl, { onlyMainContent: false });
    if (!result.success || !result.data.metadata) return null;
    const metadata = result.data.metadata;
    const ogImage = metadata.ogImage ?? metadata['og:image'];
    if (typeof ogImage === 'string' && ogImage.startsWith('http')) return ogImage;
    return null;
  } catch {
    return null;
  }
}

// Step 3: Serper image search fallback
async function searchImage(brand: string | null, name: string): Promise<string | null> {
  const serperApiKey = process.env.SERPER_API_KEY;
  if (!serperApiKey) return null;

  try {
    const query = `${brand ? brand + ' ' : ''}${name} product`;
    const res = await fetch('https://google.serper.dev/images', {
      method: 'POST',
      headers: { 'X-API-KEY': serperApiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, num: 3 }),
    });

    if (!res.ok) return null;

    const data = await res.json() as { images?: Array<{ imageUrl?: string; imageWidth?: number }> };
    if (!data.images || data.images.length === 0) return null;

    // Prefer images >= 200px wide
    const suitable = data.images.find(
      (img) => img.imageUrl && img.imageWidth !== undefined && img.imageWidth >= 200
    );
    return suitable?.imageUrl ?? data.images[0]?.imageUrl ?? null;
  } catch {
    return null;
  }
}

// Step 4: Validate image URL with HEAD request
async function validateImageUrl(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return false;
    const contentType = res.headers.get('content-type') || '';
    const contentLength = parseInt(res.headers.get('content-length') || '0', 10);
    return contentType.startsWith('image/') && contentLength > 5000;
  } catch {
    return false;
  }
}

// Step 5: Write imageUrl to Memgraph
async function writeImageUrl(gearId: string, imageUrl: string, source: string): Promise<void> {
  const db = getMemgraphClient();
  await db.query(
    `MATCH (g:GearItem {gearId: $gearId})
     SET g.imageUrl = $imageUrl, g.imageUrlSource = $source, g.imageUrlUpdatedAt = localDateTime()`,
    { gearId, imageUrl, source }
  );
}

// Main workflow
export async function executeImageDiscoveryWorkflow(
  options: ImageDiscoveryOptions = {}
): Promise<ImageDiscoveryResult> {
  const { batchSize = 50 } = options;
  const hasExistingRun = !!options.workflowRunId;
  const runId = options.workflowRunId ?? uuidv4();
  const startTime = Date.now();
  const db = getLibSQLClient();

  // Only create a run record if not already created by the trigger-workflow caller
  if (!hasExistingRun) {
    await db.execute({
      sql: `INSERT INTO workflow_runs (id, workflow_name, triggered_by, started_at, status)
            VALUES (?, 'image-discovery', 'api', ?, 'running')`,
      args: [runId, new Date().toISOString()],
    });
  }

  try {
    console.info('[ImageDiscovery] Workflow started', { runId, batchSize });

    const items = await getItemsMissingImages(batchSize);
    console.info(`[ImageDiscovery] Found ${items.length} items missing images`);

    let imagesFound = 0;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];

      // Rate limiting: pause every 10 items
      if (i > 0 && i % 10 === 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, 60_000));
      }

      let imageUrl: string | null = null;
      let source = 'unknown';

      // Try og:image from sourceUrl first
      if (item.sourceUrl) {
        imageUrl = await tryOgImage(item.sourceUrl);
        if (imageUrl) source = 'og:image';
      }

      // Fallback: Serper image search
      if (!imageUrl) {
        imageUrl = await searchImage(item.brand, item.name);
        if (imageUrl) source = 'serper-images';
      }

      if (!imageUrl) continue;

      // Validate the image URL
      const valid = await validateImageUrl(imageUrl);
      if (!valid) {
        console.warn(`[ImageDiscovery] Invalid image for ${item.gearId}: ${imageUrl}`);
        continue;
      }

      await writeImageUrl(item.gearId, imageUrl, source);
      imagesFound++;
      console.info(`[ImageDiscovery] Found image for ${item.gearId} (${source})`);
    }

    const duration = Date.now() - startTime;

    // Only update run record if we created it (trigger-workflow handles its own status updates)
    if (!hasExistingRun) {
      await db.execute({
        sql: `UPDATE workflow_runs SET status = 'completed', completed_at = ?, result_summary = ? WHERE id = ?`,
        args: [new Date().toISOString(), JSON.stringify({ itemsProcessed: items.length, imagesFound }), runId],
      });
    }

    console.info('[ImageDiscovery] Workflow completed', { runId, itemsProcessed: items.length, imagesFound, duration });

    return { runId, status: 'completed', itemsProcessed: items.length, imagesFound, duration };
  } catch (error) {
    const duration = Date.now() - startTime;
    const errMsg = error instanceof Error ? error.message : String(error);

    if (!hasExistingRun) {
      await db.execute({
        sql: `UPDATE workflow_runs SET status = 'failed', completed_at = ?, error = ? WHERE id = ?`,
        args: [new Date().toISOString(), errMsg, runId],
      });
    }

    console.error('[ImageDiscovery] Workflow failed', { runId, error: errMsg });
    return { runId, status: 'failed', itemsProcessed: 0, imagesFound: 0, error: errMsg, duration };
  }
}
