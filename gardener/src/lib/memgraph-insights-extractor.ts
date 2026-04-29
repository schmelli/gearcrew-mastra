/**
 * Memgraph-native Insights Extractor (companion to insights-extractor.ts).
 *
 * Differences vs. insights-extractor.ts:
 *   - Looks up GearItem by Memgraph internal ID (toInteger) instead of supabase_id
 *   - Writes :ProductInsight nodes with extraction_version=2 + source='youtube'
 *   - Edge label remains :HAS_INSIGHT (matches schema in CLAUDE-context: "new"
 *     hierarchy uses :ProductInsight + :HAS_INSIGHT)
 *
 * Mirrors the Gemini Flash extraction prompt + cost model so a Memgraph-only
 * GearItem (no Supabase row) can still receive insights.
 */

import { z } from "zod";
import { getReadSession, getWriteSession, toNumber } from "./memgraph.js";

// ---------------------------------------------------------------------------
// Pricing (mirror of insights-extractor.ts so cost reporting stays consistent)
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

const MIN_TRANSCRIPT_LENGTH = 1_000; // tighter floor — we only run with quality videos
const MAX_VIDEOS_PER_ITEM = 5;
const MAX_INSIGHTS_PER_VIDEO = 3;
const MAX_TRANSCRIPT_CHARS = 12_000;

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

const InsightItemSchema = z.object({
  text: z.string().min(8).max(400),
  category: z.enum(INSIGHT_CATEGORIES),
  sentiment: z.enum(INSIGHT_SENTIMENTS),
});

const InsightsLLMResponseSchema = z.object({
  insights: z.array(InsightItemSchema).max(MAX_INSIGHTS_PER_VIDEO),
});

export type InsightItem = z.infer<typeof InsightItemSchema>;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface MemgraphInsightsItem {
  node_id: number; // Memgraph internal ID(g)
  brand: string | null;
  name: string;
}

export interface VideoForInsights {
  url: string;
  title: string | null;
  channel: string | null;
  transcript: string;
}

export interface MemgraphInsightSample {
  video_url: string;
  text: string;
  category: InsightCategory;
  sentiment: InsightSentiment;
  created: boolean;
}

export interface MemgraphInsightsExtractResult {
  node_id: number;
  videos_examined: number;
  insights_created: number;
  insights_existing: number;
  cost_cents: number;
  input_tokens: number;
  output_tokens: number;
  skipped: boolean;
  skip_reason?: string;
  samples: MemgraphInsightSample[];
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Fetch GearItems with EXTRACTED_FROM links to videos with usable transcripts
 * but NO existing :HAS_INSIGHT edge. Returns highest-video-count items first
 * (highest-yield candidates).
 */
export async function fetchCandidateItems(
  limit: number,
): Promise<MemgraphInsightsItem[]> {
  const session = getReadSession();
  try {
    const result = await session.run(
      `
      MATCH (g:GearItem)-[:EXTRACTED_FROM]->(v:VideoSource)
      WHERE NOT (g)-[:HAS_INSIGHT]->()
        AND v.transcript_text IS NOT NULL
        AND size(v.transcript_text) > ${MIN_TRANSCRIPT_LENGTH}
      WITH g, count(DISTINCT v) AS video_count
      ORDER BY video_count DESC
      LIMIT ${limit}
      RETURN ID(g) AS node_id, g.brand AS brand, g.name AS name
      `,
    );
    const items: MemgraphInsightsItem[] = [];
    for (const rec of result.records) {
      const nodeId = toNumber(rec.get("node_id"));
      const name = rec.get("name");
      if (typeof name !== "string") continue;
      items.push({
        node_id: nodeId,
        brand: typeof rec.get("brand") === "string" ? rec.get("brand") : null,
        name,
      });
    }
    return items;
  } finally {
    await session.close();
  }
}

/**
 * Fetch up to MAX_VIDEOS_PER_ITEM transcripts for a given GearItem looked up
 * by Memgraph internal node ID.
 */
export async function fetchVideosForNodeId(
  nodeId: number,
): Promise<VideoForInsights[]> {
  const session = getReadSession();
  try {
    const result = await session.run(
      `
      MATCH (g:GearItem)-[:EXTRACTED_FROM]->(v:VideoSource)
      WHERE ID(g) = $nodeId
        AND v.transcript_text IS NOT NULL
        AND size(v.transcript_text) > $minLen
      RETURN
        v.url AS url,
        v.title AS title,
        v.channel AS channel,
        v.transcript_text AS transcript
      ORDER BY size(v.transcript_text) DESC
      LIMIT ${MAX_VIDEOS_PER_ITEM}
      `,
      { nodeId, minLen: MIN_TRANSCRIPT_LENGTH },
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
// LLM call (Gemini Flash via Vercel AI Gateway, OpenAI-compat)
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

function buildUserPrompt(
  item: MemgraphInsightsItem,
  video: VideoForInsights,
): string {
  const itemBrand = item.brand ? ` (brand: ${item.brand})` : "";
  const channel = video.channel ?? "?";
  const title = video.title ?? "?";
  return `Extrahiere bis zu 3 Insights zu "${item.name}"${itemBrand} aus diesem Review.

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
    const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced && fenced[1]) {
      try {
        return JSON.parse(fenced[1].trim());
      } catch {
        // fallthrough
      }
    }
    // Fallback: opened-but-not-closed fence (response truncated by max_tokens)
    const openOnly = content.match(/```(?:json)?\s*\n?([\s\S]+)$/i);
    if (openOnly && openOnly[1]) {
      try {
        return JSON.parse(openOnly[1].trim());
      } catch {
        // fallthrough
      }
    }
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
      `[memgraph-insights] LLM response was not valid JSON: ${content.slice(0, 500)}`,
    );
  }
}

async function extractInsightsForVideo(
  item: MemgraphInsightsItem,
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
      "AI_GATEWAY_API_KEY env var is required for memgraph-insights extraction",
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
      { role: "user" as const, content: buildUserPrompt(item, video) },
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
      `[memgraph-insights] gateway HTTP ${res.status}: ${errText.slice(0, 500)}`,
    );
  }

  const json = (await res.json()) as OpenAIChatResponse;
  const content = json.choices[0]?.message?.content;
  if (!content) {
    throw new Error(
      `[memgraph-insights] empty response: ${JSON.stringify(json).slice(0, 300)}`,
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
// Writes
// ---------------------------------------------------------------------------

interface MergeResult {
  created: boolean;
}

/**
 * MERGE :ProductInsight node + GearItem-[:HAS_INSIGHT]->ProductInsight +
 * ProductInsight-[:DERIVED_FROM]->VideoSource.
 *
 * Idempotent: re-runs do not create duplicate edges. Returns created=true
 * when the GearItem-[:HAS_INSIGHT]->ProductInsight edge did not exist before.
 *
 * Schema:
 *   :ProductInsight { text, category, sentiment, source, extraction_version,
 *                     extracted_at, last_seen_at }
 */
async function writeProductInsight(
  nodeId: number,
  insight: InsightItem,
  videoUrl: string,
): Promise<MergeResult> {
  const session = getWriteSession();
  try {
    const existsResult = await session.run(
      `
      OPTIONAL MATCH (g:GearItem)-[r:HAS_INSIGHT]->(i:ProductInsight {text: $text, category: $category})
      WHERE ID(g) = $nodeId
      RETURN count(r) AS existed
      `,
      { nodeId, text: insight.text, category: insight.category },
    );
    const existed = toNumber(existsResult.records[0]?.get("existed")) > 0;

    await session.run(
      `
      MERGE (i:ProductInsight {text: $text, category: $category})
        ON CREATE SET
          i.source = 'youtube',
          i.sentiment = $sentiment,
          i.extracted_at = datetime(),
          i.extraction_version = 2
        ON MATCH SET
          i.last_seen_at = datetime()
      WITH i
      MATCH (g:GearItem) WHERE ID(g) = $nodeId
      MERGE (g)-[hi:HAS_INSIGHT]->(i)
        ON CREATE SET hi.created_at = datetime()
      WITH i
      MATCH (v:VideoSource {url: $videoUrl})
      MERGE (i)-[df:DERIVED_FROM]->(v)
        ON CREATE SET df.created_at = datetime()
      `,
      {
        nodeId,
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
// Public orchestration
// ---------------------------------------------------------------------------

/**
 * Run the full insights pipeline for one Memgraph-only GearItem (no Supabase row):
 *   videos -> per-video Gemini call -> :ProductInsight writes.
 *
 * Never throws on per-video LLM/graph errors — surface as samples only.
 */
export async function extractInsightsForNodeId(
  item: MemgraphInsightsItem,
): Promise<MemgraphInsightsExtractResult> {
  const videos = await fetchVideosForNodeId(item.node_id);
  if (videos.length === 0) {
    return {
      node_id: item.node_id,
      videos_examined: 0,
      insights_created: 0,
      insights_existing: 0,
      cost_cents: 0,
      input_tokens: 0,
      output_tokens: 0,
      skipped: true,
      skip_reason: "no_videos_with_transcript",
      samples: [],
    };
  }

  let totalCost = 0;
  let totalIn = 0;
  let totalOut = 0;
  let created = 0;
  let existing = 0;
  const samples: MemgraphInsightSample[] = [];

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
        `[memgraph-insights] LLM extraction failed for node=${item.node_id} <- ${video.url}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    totalCost += extracted.cost_cents;
    totalIn += extracted.input_tokens;
    totalOut += extracted.output_tokens;

    for (const insight of extracted.insights) {
      try {
        const merge = await writeProductInsight(
          item.node_id,
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
          `[memgraph-insights] write failed for node=${item.node_id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  return {
    node_id: item.node_id,
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
