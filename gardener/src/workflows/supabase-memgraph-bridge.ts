/**
 * Supabase ↔ Memgraph Bridge Workflow
 *
 * Stamps `g.supabase_id` on Memgraph GearItem nodes that match a Supabase
 * gear_items row by case-insensitive (brand, name).
 *
 * Two modes:
 *   - "dry-run": report match counts only, no Memgraph writes
 *   - "apply":   stamp supabase_id on matched nodes
 *
 * No LLM calls, no cost. Read Supabase + Memgraph, write Memgraph only.
 *
 * Mastra v3 single-step pattern (matches brand-dedup, enrichment-premium).
 */

import { createWorkflow, createStep } from "@mastra/core/workflows";
import { z } from "zod";
import { getSupabase } from "../lib/supabase.js";
import { getReadSession, getWriteSession } from "../lib/memgraph.js";
import {
  findMemgraphMatch,
  stampSupabaseId,
  ensureBridgeIndex,
  type SupabaseGearItem,
  type BridgeMatchResult,
} from "../lib/bridge-matcher.js";

const triggerSchema = z.object({
  mode: z.enum(["dry-run", "apply"]),
  limit: z.number().int().positive().optional(),
});

const sampleSchema = z.object({
  supabase_id: z.string(),
  brand: z.string(),
  name: z.string(),
  outcome: z.enum(["matched", "unmatched", "ambiguous"]),
  match_count: z.number(),
});

const outputSchema = z.object({
  mode: z.enum(["dry-run", "apply"]),
  total_supabase_items: z.number(),
  matched: z.number(),
  unmatched: z.number(),
  ambiguous: z.number(),
  stamped: z.number(),
  index_created: z.boolean(),
  sample_unmatched: z.array(sampleSchema),
  sample_ambiguous: z.array(sampleSchema),
});

const matchAndStampStep = createStep({
  id: "match-and-stamp",
  description:
    "Fetch Supabase gear_items, find Memgraph matches by (brand, name), stamp supabase_id on matched nodes",
  inputSchema: triggerSchema,
  outputSchema,
  async execute({ inputData }) {
    const supa = getSupabase();
    const startedAt = new Date().toISOString();

    // 1. Fetch Supabase gear_items
    let query = supa
      .from("gear_items")
      .select("id, brand, name")
      .not("name", "is", null)
      .order("created_at", { ascending: true });
    if (inputData.limit) query = query.limit(inputData.limit);

    const { data: supaItems, error: fetchErr } = await query;
    if (fetchErr) {
      throw new Error(
        `[bridge] Supabase fetch failed: ${fetchErr.message}`,
      );
    }
    const items = (supaItems ?? []) as SupabaseGearItem[];

    console.log(
      `[bridge] starting mode=${inputData.mode} items=${items.length} at=${startedAt}`,
    );

    let matched = 0;
    let unmatched = 0;
    let ambiguous = 0;
    let stamped = 0;
    let indexCreated = false;
    const sampleUnmatched: BridgeMatchResult[] = [];
    const sampleAmbiguous: BridgeMatchResult[] = [];

    // 2. Apply-mode prep: ensure Memgraph index
    if (inputData.mode === "apply") {
      const writeSess = getWriteSession();
      try {
        await ensureBridgeIndex(writeSess);
        indexCreated = true;
      } finally {
        await writeSess.close();
      }
    }

    // 3. Match each Supabase item against Memgraph
    const readSess = getReadSession();
    let writeSess = inputData.mode === "apply" ? getWriteSession() : null;

    try {
      for (let i = 0; i < items.length; i += 1) {
        const item = items[i]!;
        const result = await findMemgraphMatch(readSess, item);

        switch (result.outcome) {
          case "matched":
            matched += 1;
            if (inputData.mode === "apply" && writeSess) {
              await stampSupabaseId(
                writeSess,
                result.memgraph_node_id!,
                item.id,
              );
              stamped += 1;
            }
            break;
          case "unmatched":
            unmatched += 1;
            if (sampleUnmatched.length < 20) sampleUnmatched.push(result);
            break;
          case "ambiguous":
            ambiguous += 1;
            if (sampleAmbiguous.length < 20) sampleAmbiguous.push(result);
            // Skip stamping for ambiguous to avoid corrupting graph
            break;
        }

        if ((i + 1) % 25 === 0 || i === items.length - 1) {
          console.log(
            `[bridge] progress ${i + 1}/${items.length} matched=${matched} unmatched=${unmatched} ambiguous=${ambiguous} stamped=${stamped}`,
          );
        }
      }
    } finally {
      await readSess.close();
      if (writeSess) await writeSess.close();
    }

    console.log(
      `[bridge] done mode=${inputData.mode} matched=${matched} unmatched=${unmatched} ambiguous=${ambiguous} stamped=${stamped}`,
    );

    return {
      mode: inputData.mode,
      total_supabase_items: items.length,
      matched,
      unmatched,
      ambiguous,
      stamped,
      index_created: indexCreated,
      sample_unmatched: sampleUnmatched.map((r) => ({
        supabase_id: r.supabase_id,
        brand: r.brand,
        name: r.name,
        outcome: r.outcome,
        match_count: r.match_count,
      })),
      sample_ambiguous: sampleAmbiguous.map((r) => ({
        supabase_id: r.supabase_id,
        brand: r.brand,
        name: r.name,
        outcome: r.outcome,
        match_count: r.match_count,
      })),
    };
  },
});

export const supabaseMemgraphBridge = createWorkflow({
  id: "supabaseMemgraphBridge",
  inputSchema: triggerSchema,
  outputSchema,
})
  .then(matchAndStampStep)
  .commit();
