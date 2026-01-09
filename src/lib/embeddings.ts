/**
 * Embeddings Utility using Vercel AI Gateway
 * Generates text embeddings for semantic similarity search
 */

// ============================================================================
// Configuration
// ============================================================================

const EMBEDDING_MODEL = 'openai/text-embedding-3-small';
const EMBEDDING_DIMENSIONS = 1536;
const BATCH_SIZE = 100; // Process in batches

// ============================================================================
// Types
// ============================================================================

interface EmbeddingResponse {
  data: Array<{
    embedding: number[];
    index: number;
  }>;
  usage?: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

export interface EmbeddingResult {
  text: string;
  embedding: number[];
}

// ============================================================================
// API Configuration
// ============================================================================

function getGatewayConfig(): { apiKey: string; baseURL: string } {
  const apiKey = process.env.AI_GATEWAY_API_KEY ?? process.env.AI_GATEWAY_KEY;
  if (!apiKey) {
    throw new Error(
      'AI_GATEWAY_API_KEY environment variable is required for embedding generation. ' +
        'Get an API key from Vercel AI Gateway.'
    );
  }

  // Note: Base URL should NOT include /ai - embeddings endpoint is at /v1/embeddings
  const baseURL = process.env.AI_GATEWAY_BASE_URL ?? 'https://ai-gateway.vercel.sh/v1';

  return { apiKey, baseURL };
}

// ============================================================================
// Embedding Generation
// ============================================================================

/**
 * Generate embedding for a single text
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const { apiKey, baseURL } = getGatewayConfig();

  const response = await fetch(`${baseURL}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: text,
      dimensions: EMBEDDING_DIMENSIONS,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`AI Gateway error: ${response.status} - ${error}`);
  }

  const data = (await response.json()) as EmbeddingResponse;
  return data.data[0]!.embedding;
}

/**
 * Generate embeddings for multiple texts in batches
 */
export async function generateEmbeddingsBatch(
  texts: string[]
): Promise<EmbeddingResult[]> {
  const { apiKey, baseURL } = getGatewayConfig();
  const results: EmbeddingResult[] = [];

  // Process in batches
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);

    const response = await fetch(`${baseURL}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: batch,
        dimensions: EMBEDDING_DIMENSIONS,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`AI Gateway error: ${response.status} - ${error}`);
    }

    const data = (await response.json()) as EmbeddingResponse;

    // Sort by index to maintain order
    const sortedData = data.data.sort((a, b) => a.index - b.index);

    for (let j = 0; j < batch.length; j++) {
      results.push({
        text: batch[j]!,
        embedding: sortedData[j]!.embedding,
      });
    }
  }

  return results;
}

/**
 * Create embedding text from gear item properties
 * Combines relevant fields for semantic representation
 */
export function createGearItemEmbeddingText(item: {
  name: string;
  description?: string | null;
  category?: string | null;
  brand?: string | null;
  type?: string | null;
}): string {
  const parts: string[] = [];

  // Always include name
  parts.push(item.name);

  // Add category context
  if (item.category) {
    parts.push(`Category: ${item.category}`);
  }

  // Add brand context
  if (item.brand) {
    parts.push(`Brand: ${item.brand}`);
  }

  // Add type context
  if (item.type) {
    parts.push(`Type: ${item.type}`);
  }

  // Add description if available (truncated to avoid token limits)
  if (item.description) {
    const truncatedDesc = item.description.substring(0, 500);
    parts.push(truncatedDesc);
  }

  return parts.join('. ');
}

// ============================================================================
// Exports
// ============================================================================

export const EMBEDDING_CONFIG = {
  model: EMBEDDING_MODEL,
  dimensions: EMBEDDING_DIMENSIONS,
  batchSize: BATCH_SIZE,
};
