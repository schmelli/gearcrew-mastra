/**
 * TubeonAI API Client
 *
 * Typed HTTP wrapper for the TubeonAI transcription service.
 * Handles transcription creation, status polling, and rate limiting (60 req/min, 5 concurrent).
 *
 * Docs: https://app.tubeonai.com/api/developer/v1
 */

const BASE_URL = "https://app.tubeonai.com/api/developer/v1";
const RATE_LIMIT_PER_MINUTE = 60;
const DEFAULT_POLL_INTERVAL_MS = 8_000;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TranscriptionResult {
  uuid: string;
  status: "pending" | "processing" | "completed" | "failed";
  title?: string;
  transcription?: string;
  duration?: number;
  language?: string;
  wordCount?: number;
  cached: boolean;
  creditsUsed: number;
  error?: string;
  errorCode?: string;
}

interface TubeonAiEnvelope {
  success: boolean;
  data: {
    id: string;
    status: TranscriptionResult["status"];
    title?: string;
    transcription?: string | null;
    duration?: number;
    language?: string;
    word_count?: number;
    cached?: boolean;
    error?: string;
    error_code?: string;
  };
  usage?: {
    credits_used?: number;
    remaining_credits?: number;
  };
  message?: string;
}

// ---------------------------------------------------------------------------
// Rate Limiter — simple sliding-window over the last 60 seconds.
// ---------------------------------------------------------------------------

const recentCallTimestamps: number[] = [];

async function throttle(): Promise<void> {
  const now = Date.now();
  const windowStart = now - 60_000;

  // Drop timestamps older than 60 s
  while (recentCallTimestamps.length > 0 && recentCallTimestamps[0]! < windowStart) {
    recentCallTimestamps.shift();
  }

  if (recentCallTimestamps.length >= RATE_LIMIT_PER_MINUTE) {
    const oldest = recentCallTimestamps[0]!;
    const waitMs = oldest + 60_000 - now + 50; // small buffer
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  recentCallTimestamps.push(Date.now());
}

// ---------------------------------------------------------------------------
// Auth helper — fail-fast on missing API key when actually called.
// ---------------------------------------------------------------------------

function getApiKey(): string {
  const key = process.env.TUBEONAI_API_KEY;
  if (!key || key.trim() === "") {
    throw new Error(
      "TUBEONAI_API_KEY environment variable is required to call TubeonAI",
    );
  }
  return key;
}

// ---------------------------------------------------------------------------
// Internal request wrapper
// ---------------------------------------------------------------------------

async function tubeonaiFetch(
  path: string,
  init: RequestInit = {},
): Promise<TubeonAiEnvelope> {
  await throttle();

  const apiKey = getApiKey();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
    ...((init.headers as Record<string, string>) ?? {}),
  };

  if (init.body && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers,
  });

  let payload: TubeonAiEnvelope | null = null;
  let rawText = "";
  try {
    rawText = await response.text();
    payload = rawText ? (JSON.parse(rawText) as TubeonAiEnvelope) : null;
  } catch {
    // ignore — handled below
  }

  if (!response.ok) {
    const excerpt = (rawText || "").slice(0, 500);
    throw new Error(
      `TubeonAI request failed (${response.status} ${response.statusText}) for ${path}: ${excerpt}`,
    );
  }

  if (!payload || payload.success === false) {
    const message = payload?.message ?? "Unknown TubeonAI error";
    throw new Error(`TubeonAI returned non-success response for ${path}: ${message}`);
  }

  return payload;
}

// ---------------------------------------------------------------------------
// Mapping helper
// ---------------------------------------------------------------------------

function mapEnvelope(envelope: TubeonAiEnvelope): TranscriptionResult {
  const data = envelope.data;
  return {
    uuid: data.id,
    status: data.status,
    title: data.title,
    transcription: data.transcription ?? undefined,
    duration: data.duration,
    language: data.language,
    wordCount: data.word_count,
    cached: data.cached ?? false,
    creditsUsed: envelope.usage?.credits_used ?? 0,
    error: data.error,
    errorCode: data.error_code,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create (or fetch from cache) a transcription job for a YouTube URL.
 * Returns immediately with status `completed` when cached or `processing`/`pending` when queued.
 */
export async function createTranscription(
  url: string,
  opts: { webhookUrl?: string } = {},
): Promise<TranscriptionResult> {
  const body: Record<string, unknown> = {
    url,
    type: "youtube",
    options: {
      output_format: "text",
      include_timestamps: false,
    },
  };

  if (opts.webhookUrl) {
    body.webhook_url = opts.webhookUrl;
  }

  const envelope = await tubeonaiFetch("/transcriptions", {
    method: "POST",
    body: JSON.stringify(body),
  });

  return mapEnvelope(envelope);
}

/** Fetch the current state of a transcription by uuid. */
export async function getTranscription(uuid: string): Promise<TranscriptionResult> {
  const envelope = await tubeonaiFetch(`/transcriptions/${uuid}`);
  return mapEnvelope(envelope);
}

/**
 * Poll a transcription until it reaches a terminal state (`completed` or `failed`)
 * or the timeout is exceeded.
 */
export async function waitForCompletion(
  uuid: string,
  opts: { pollIntervalMs?: number; timeoutMs?: number } = {},
): Promise<TranscriptionResult> {
  const interval = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const result = await getTranscription(uuid);
    if (result.status === "completed" || result.status === "failed") {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }

  throw new Error(
    `TubeonAI transcription ${uuid} did not finish within ${Math.round(timeout / 1000)}s`,
  );
}
