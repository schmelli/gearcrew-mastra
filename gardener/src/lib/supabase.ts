/**
 * Supabase service-role client for the gardener.
 *
 * Singleton pattern: lazily initialized on first use, validates env vars,
 * disables session/refresh handling (we're a backend service).
 *
 * Used for tracking processed YouTube videos in the `processed_videos` table
 * (Supabase project pxtvbgilzzppnbienmot). Tracking is best-effort — callers
 * should wrap upserts in try/catch and not fail the pipeline on Supabase errors.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (!client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error(
        "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars are required",
      );
    }
    client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

export interface ProcessedVideoUpsert {
  youtube_video_id: string;
  title?: string;
  channel_name?: string;
  duration_seconds?: number;
  thumbnail_url?: string;
  tubeonai_uuid?: string;
  processing_status: "pending" | "processing" | "completed" | "failed";
  gear_items_found?: number;
  insights_found?: number;
  extraction_summary?: string;
  processed_at?: string;
}

/**
 * Upsert a processed_videos row keyed by youtube_video_id.
 *
 * Tries `onConflict: 'youtube_video_id'` first; if Supabase rejects because
 * no UNIQUE constraint exists on that column, falls back to manual select +
 * update-or-insert.
 */
export async function upsertProcessedVideo(
  row: ProcessedVideoUpsert,
): Promise<void> {
  const supa = getSupabase();

  const { error } = await supa
    .from("processed_videos")
    .upsert(row, { onConflict: "youtube_video_id" });

  if (!error) return;

  const message = error.message?.toLowerCase() ?? "";
  const isMissingConstraint =
    message.includes("no unique") ||
    message.includes("exclusion constraint") ||
    message.includes("on conflict") ||
    error.code === "42P10";

  if (!isMissingConstraint) {
    throw new Error(
      `[supabase] processed_videos upsert failed: ${error.message}`,
    );
  }

  // Fallback: manual upsert without DB-level conflict target
  const { data: existing, error: selectError } = await supa
    .from("processed_videos")
    .select("id")
    .eq("youtube_video_id", row.youtube_video_id)
    .maybeSingle();

  if (selectError) {
    throw new Error(
      `[supabase] processed_videos select failed: ${selectError.message}`,
    );
  }

  if (existing?.id) {
    const { error: updateError } = await supa
      .from("processed_videos")
      .update(row)
      .eq("id", existing.id);
    if (updateError) {
      throw new Error(
        `[supabase] processed_videos update failed: ${updateError.message}`,
      );
    }
  } else {
    const { error: insertError } = await supa
      .from("processed_videos")
      .insert(row);
    if (insertError) {
      throw new Error(
        `[supabase] processed_videos insert failed: ${insertError.message}`,
      );
    }
  }
}

/**
 * Returns the set of youtube_video_ids that have been fully processed
 * (processing_status = 'completed'). Used by the ingest workflow's filter
 * step to skip already-done videos.
 */
export async function getCompletedVideoIds(): Promise<Set<string>> {
  const supa = getSupabase();
  const { data, error } = await supa
    .from("processed_videos")
    .select("youtube_video_id")
    .eq("processing_status", "completed");

  if (error) {
    throw new Error(
      `[supabase] processed_videos select failed: ${error.message}`,
    );
  }

  const ids = new Set<string>();
  for (const row of data ?? []) {
    const id = (row as { youtube_video_id?: string }).youtube_video_id;
    if (id) ids.add(id);
  }
  return ids;
}
