/**
 * Insights Extractor — Quick-Task 260428-ke7 (enrichmentPremium / DATA-07)
 *
 * For a given gear_item_id:
 *   1. Query Memgraph for VideoSource nodes linked via :EXTRACTED_FROM that
 *      have a non-empty transcript_text (>100 chars).
 *   2. For each video, ask Gemini Flash to extract up to 3 actionable insights
 *      keyed as { text, category, sentiment }.
 *   3. Merge each Insight node into Memgraph under canonical (text, category)
 *      and connect: GearItem-[:HAS_INSIGHT]->Insight-[:DERIVED_FROM]->VideoSource.
 *
 * Returns: { item_id, videos_examined, insights_created, insights_existing,
 *            cost_cents, input_tokens, output_tokens, reasons[], samples[] }
 *
 * Skip semantics:
 *   - 0 linked VideoSource nodes  -> early-return skipped='no_videos'
 *   - 0 videos meet transcript-length floor -> skipped='no_transcript_videos'
 *
 * Pure-with-Memgraph: writes Insight nodes + edges to Memgraph but NOT to
 * Supabase — caller drives Supabase last_insights_enriched_at touch.
 */

import { z } from "zod";
import { getReadSession, getWriteSession, toNumber } from "./memgraph.js";

// ---------------------------------------------------------------------------
// Pricing (mirror enrichment-extractors.ts)
// ---------------------------------------------------------------------------

const DEFAULT_INPUT_PRICE_CENTS_PER_1M = 7.5;
const DEFAULT_OUTPUT_PRICE_CENTS_PER_1M = 30;

function inputPriceCentsPerMillion(): number {
  const fromEnv = process.env.ENRICHMENT_INPUT_PRICE_CENTS_PER_1M;
  return fromEnv ? parseFloat(fromEnv) : DEFAULT_INPUT_PRICE_CENTS_PER_1M;
}

function outputPriceCentsPerMillion(): number {
  const fromEnv = process.env.ENRICHMENT_OUTPUT_PRICE_CENTS_PER_1M;
  return fromEnv ? parseFloat(fromEnv) : DEFAULT_OUTPUT_PRICE_CENTS_PER_1M;
}

function costCents(inputTokens: number, outputTokens: number): number {
  const inputCost = (inputTokens / 1_000_000) * inputPriceCentsPerMillion();
  const outputCost = (outputTokens / 1_000_000) * outputPriceCentsPerMillion();
  return Math.ceil(inputCost + outputCost);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_TRANSCRIPT_LENGTH = 100;
const MAX_VIDEOS_PER_ITEM = 5;
const MAX_INSIGHTS_PER_VIDEO = 3;
const MAX_TRANSCRIPT_CHARS = 12_000; // soft cap input tokens per video

const INSIGHT_CATEGORIES = [
  "tip",
  "trick",
  "warning",
  "usage",
  "comparison",
  "alternative",
] as const;

const INSIGHT_SENTIMENTS = ["positive", "neutral", "negative"] as const;

type InsightCategory = (typeof INSIGHT_CATEGORIES)[number];
type InsightSentiment = (typeof INSIGHT_SENTIMENTS)[number];

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const InsightItemSchema = z.object({
  text: z.string().min(8).max(400),
  category: z.enum(INSIGHT_CATEGORIES),
  sentiment: z.enum(INSIGHT_SENTIMENTS),
});

const InsightsLLMResponseSchema = z.object({
  insights: z.array(InsightItemSchema).max(MAX_INSIGHTS_PER_VIDEO),
});

export type InsightItem = z.infer<typeof InsightItemSchema>;

export interface InsightsExtractInput {
  item_id: string;
  item_name: string;
  item_brand: string | null;
}

export interface VideoForInsights {
  url: string;
  title: string | null;
  channel: string | null;
  transcript: string;
}

export interface InsightSample {
  video_url: string;
  text: string;
  category: InsightCategory;
  sentiment: InsightSentiment;
  created: boolean; // false = already-existing edge
}

export interface InsightsExtractResult {
  item_id: string;
  videos_examined: number;
  insights_created: number;
  insights_existing: number;
  cost_cents: number;
  input_tokens: number;
  output_tokens: number;
  skipped: boolean;
  skip_reason?: string;
  samples: InsightSample[];
}

// ---------------------------------------------------------------------------
// Memgraph reads
// ---------------------------------------------------------------------------

/**
 * Query Memgraph for VideoSource nodes linked to the given gear_item via
 * :EXTRACTED_FROM. Filters out videos without a transcript (or transcripts
 * shorter than MIN_TRANSCRIPT_LENGTH).
 */
export async function fetchVideosForItem(
  itemId: string,
): Promise<VideoForInsights[]> {
  const session = getReadSession();
  try {
    const result = await session.run(
      `
      MATCH (g:GearItem {supabase_id: $itemId})-[:EXTRACTED_FROM]->(v:VideoSource)
      WHERE v.transcript_text IS NOT NULL
        AND size(v.transcript_text) > $minLen
      RETURN
        v.url AS url,
        v.title AS title,
        v.channel AS channel,
        v.transcript_text AS transcript
      ORDER BY size(v.transcript_text) DESC
      LIMIT $cap
      `,
      { itemId, minLen: MIN_TRANSCRIPT_LENGTH, cap: MAX_VIDEOS_PER_ITEM },
    );

    const videos: VideoForInsights[] = [];
    for (const rec of result.records) {
      const url = rec.get("url");
      const transcript = rec.get("transcript");
      if (typeof url !== "string" || typeof transcript !== "string") continue;
      videos.push({
        url,
        title: typeof rec.get("title") === "string" ? rec.get("title") : null,
        channel:
          typeof rec.get("channel") === "string" ? rec.get("channel") : null,
        transcript:
          transcript.length > MAX_TRANSCRIPT_CHARS
            ? transcript.slice(0, MAX_TRANSCRIPT_CHARS)
            : transcript,
      });
    }
    return videos;
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------
// Gemini extraction
// ---------------------------------------------------------------------------

const INSIGHTS_SYSTEM_PROMPT = `Du extrahierst praktische, aktionierbare Insights aus YouTube-Outdoor-Gear-Reviews.

Aufgabe: Lies Title + Channel + Transcript-Auszug und extrahiere bis zu 3 konkrete, praxisrelevante Aussagen ueber das genannte Gear-Item.

Eine Insight ist:
- Konkret + spezifisch (nicht "good product")
- Praxisbasiert (Erlebt-Aussage des Speakers, nicht Hersteller-Specs wiederholt)
- 30-300 Zeichen lang, in Englisch geschrieben
- Mit klarer Kategorie + Sentiment getaggt

CRITICAL RULES:
(1) Maximal 3 Insights pro Video. Bei <3 starken Insights lieber weniger ausgeben.
(2) category MUSS exakt eines sein:
    "tip"        — actionable usage advice ("turn the valve 1/4 turn before opening")
    "trick"      — clever workaround ("substitute the buckle with a wide rubber band")
    "warning"    — risk/failure mode ("zipper fails below -5C")
    "usage"      — typical scenario ("ideal for 3-day spring trips")
    "comparison" — vs. another product ("warmer than X but heavier")
    "alternative"— suggested replacement ("the Y is cheaper for casual use")
(3) sentiment MUSS exakt eines sein: "positive" | "neutral" | "negative".
(4) text MUSS in Englisch geschrieben sein, ein vollstaendiger Satz, ohne Anfuehrungszeichen drumherum.
(5) Wenn Transcript das Item nicht erwaehnt oder NUR Werbung ist -> insights: [].

Antworte AUSSCHLIESSLICH im JSON-Format:
{ "insights": [ { "text": "...", "category": "tip|trick|...", "sentiment": "positive|neutral|negative" }, ... ] }`;

function buildInsightsUserPrompt(
  item: InsightsExtractInput,
  video: VideoForInsights,
): string {
  const itemBrand = item.item_brand ? ` (brand: ${item.item_brand})` : "";
  const channel = video.channel ?? "?";
  const title = video.title ?? "?";
  return `Extrahiere bis zu 3 Insights zu "${item.item_name}"${itemBrand} aus diesem Review.

VIDEO:
title="${title.replace(/"/g, "'")}"
channel="${channel.replace(/"/g, "'")}"
url="${video.url}"

TRANSCRIPT (${video.transcript.length} chars):
${video.transcript}`;
}

interface OpenAIChatResponse {
  choices: Array<{ message: { role: string; content: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function parseJsonInsights(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    // Try fenced JSON
    const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced && fenced[1]) {
      try {
        return JSON.parse(fenced[1].trim());
      } catch {
        // fallthrough
      }
    }
    // Balanced braces
    const start = content.indexOf("{");
    if (start !== -1) {
      let depth = 0;
      let inString = false;
      let escape = false;
      for (let i = start; i < content.length; i += 1) {
        const ch = content[i];
        if (inString) {
          if (escape) escape = false;
          else if (ch === "\\") escape = true;
          else if (ch === '"') inString = false;
          continue;
        }
        if (ch === '"') {
          inString = true;
          continue;
        }
        if (ch === "{") depth += 1;
        else if (ch === "}") {
          depth -= 1;
          if (depth === 0) return JSON.parse(content.slice(start, i + 1));
        }
      }
    }
    throw new Error(
      `[insights] LLM response was not valid JSON: ${content.slice(0, 500)}`,
    );
  }
}

async function extractInsightsForVideo(
  item: InsightsExtractInput,
  video: VideoForInsights,
): Promise<{
  insights: InsightItem[];
  cost_cents: number;
  input_tokens: number;
  output_tokens: number;
}> {
  const apiKey = process.env.AI_GATEWAY_API_KEY;
  if (!apiKey) {
    throw new Error(
      "AI_GATEWAY_API_KEY env var is required for insights extraction",
    );
  }
  const rawBaseUrl =
    process.env.AI_GATEWAY_BASE_URL ?? "https://ai-gateway.vercel.sh/v1";
  const trimmed = rawBaseUrl.replace(/\/$/, "").replace(/\/ai$/, "");
  const endpoint = `${trimmed}/chat/completions`;

  const requestBody = {
    model: "google/gemini-2.5-flash",
    temperature: 0,
    max_tokens: 1024,
    messages: [
      { role: "system" as const, content: INSIGHTS_SYSTEM_PROMPT },
      { role: "user" as const, content: buildInsightsUserPrompt(item, video) },
    ],
  };

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(requestBody),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(
      `[insights] gateway HTTP ${res.status}: ${errText.slice(0, 500)}`,
    );
  }

  const json = (await res.json()) as OpenAIChatResponse;
  const content = json.choices[0]?.message?.content;
  if (!content) {
    throw new Error(
      `[insights] empty response: ${JSON.stringify(json).slice(0, 300)}`,
    );
  }

  const parsed = parseJsonInsights(content);
  const validated = InsightsLLMResponseSchema.parse(parsed);

  const usage = json.usage ?? {};
  const inputTokens = usage.prompt_tokens ?? 0;
  const outputTokens = usage.completion_tokens ?? 0;

  return {
    insights: validated.insights,
    cost_cents: costCents(inputTokens, outputTokens),
    input_tokens: inputTokens,
    output_tokens: outputTokens,
  };
}

// ---------------------------------------------------------------------------
// Memgraph writes
// ---------------------------------------------------------------------------

interface MergeResult {
  created: boolean;
}

/**
 * MERGE Insight node + GearItem-[:HAS_INSIGHT]->Insight + Insight-[:DERIVED_FROM]->VideoSource.
 *
 * Returns created=true when the GearItem-[:HAS_INSIGHT]->Insight edge did not
 * exist before this call (so caller can count net-new edges). The Insight
 * node + DERIVED_FROM edge are MERGEd idempotently.
 */
async function writeInsightToGraph(
  itemId: string,
  insight: InsightItem,
  videoUrl: string,
): Promise<MergeResult> {
  const session = getWriteSession();
  try {
    // Step 1: count existing :HAS_INSIGHT edges between item & insight (text+category).
    // Using a small numeric guard avoids a false "created" when the edge already exists.
    const existsResult = await session.run(
      `
      OPTIONAL MATCH (g:GearItem {supabase_id: $itemId})-[r:HAS_INSIGHT]->(i:Insight {text: $text, category: $category})
      RETURN count(r) AS existed
      `,
      { itemId, text: insight.text, category: insight.category },
    );
    const existed = toNumber(existsResult.records[0]?.get("existed")) > 0;

    // Step 2: idempotent MERGE — node, edge to item, edge to video.
    await session.run(
      `
      MERGE (i:Insight {text: $text, category: $category})
        ON CREATE SET
          i.source = 'youtube',
          i.sentiment = $sentiment,
          i.extracted_at = datetime(),
          i.extraction_version = 1
        ON MATCH SET
          i.last_seen_at = datetime()
      WITH i
      MATCH (g:GearItem {supabase_id: $itemId})
      MERGE (g)-[hi:HAS_INSIGHT]->(i)
        ON CREATE SET hi.created_at = datetime()
      WITH i
      MATCH (v:VideoSource {url: $videoUrl})
      MERGE (i)-[df:DERIVED_FROM]->(v)
        ON CREATE SET df.created_at = datetime()
      `,
      {
        itemId,
        text: insight.text,
        category: insight.category,
        sentiment: insight.sentiment,
        videoUrl,
      },
    );

    return { created: !existed };
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the full insights pipeline for one gear_item:
 *   videos -> per-video Gemini call -> Memgraph insight writes.
 *
 * Returns aggregated counts + cost. Never throws on LLM/graph errors —
 * partial failures are logged and surface as samples with `created=false`.
 */
export async function extractInsightsForItem(
  item: InsightsExtractInput,
): Promise<InsightsExtractResult> {
  const videos = await fetchVideosForItem(item.item_id);
  if (videos.length === 0) {
    return {
      item_id: item.item_id,
      videos_examined: 0,
      insights_created: 0,
      insights_existing: 0,
      cost_cents: 0,
      input_tokens: 0,
      output_tokens: 0,
      skipped: true,
      skip_reason: "no_videos",
      samples: [],
    };
  }

  let totalCost = 0;
  let totalIn = 0;
  let totalOut = 0;
  let created = 0;
  let existing = 0;
  const samples: InsightSample[] = [];

  for (const video of videos) {
    let extracted: {
      insights: InsightItem[];
      cost_cents: number;
      input_tokens: number;
      output_tokens: number;
    };
    try {
      extracted = await extractInsightsForVideo(item, video);
    } catch (err) {
      console.warn(
        `[insights] LLM extraction failed for ${item.item_id} <- ${video.url}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    totalCost += extracted.cost_cents;
    totalIn += extracted.input_tokens;
    totalOut += extracted.output_tokens;

    for (const insight of extracted.insights) {
      try {
        const merge = await writeInsightToGraph(
          item.item_id,
          insight,
          video.url,
        );
        if (merge.created) created += 1;
        else existing += 1;
        if (samples.length < 10) {
          samples.push({
            video_url: video.url,
            text: insight.text,
            category: insight.category,
            sentiment: insight.sentiment,
            created: merge.created,
          });
        }
      } catch (err) {
        console.warn(
          `[insights] Memgraph write failed for ${item.item_id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  return {
    item_id: item.item_id,
    videos_examined: videos.length,
    insights_created: created,
    insights_existing: existing,
    cost_cents: totalCost,
    input_tokens: totalIn,
    output_tokens: totalOut,
    skipped: false,
    samples,
  };
}
