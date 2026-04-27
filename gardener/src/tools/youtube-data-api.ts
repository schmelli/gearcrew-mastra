/**
 * YouTube Data API v3 Client
 *
 * Fetches playlist videos with full metadata (duration, view counts).
 * The `playlistItems` endpoint does not include duration/statistics,
 * so we batch a follow-up `videos` call (max 50 ids per request).
 *
 * Docs: https://developers.google.com/youtube/v3/docs
 */

const BASE_URL = "https://www.googleapis.com/youtube/v3";
const PAGE_SIZE = 50;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PlaylistVideo {
  videoId: string;
  title: string;
  description: string;
  channelTitle: string;
  publishedAt: string;
  thumbnailUrl?: string;
  durationSeconds?: number;
  viewCount?: number;
}

interface PlaylistItemsResponse {
  nextPageToken?: string;
  items: Array<{
    snippet?: {
      title?: string;
      description?: string;
      channelTitle?: string;
      publishedAt?: string;
      thumbnails?: {
        high?: { url?: string };
        medium?: { url?: string };
        default?: { url?: string };
      };
      resourceId?: {
        videoId?: string;
      };
    };
    contentDetails?: {
      videoId?: string;
      videoPublishedAt?: string;
    };
  }>;
}

interface VideosResponse {
  items: Array<{
    id?: string;
    snippet?: {
      title?: string;
      description?: string;
      channelTitle?: string;
      publishedAt?: string;
      thumbnails?: {
        high?: { url?: string };
        medium?: { url?: string };
        default?: { url?: string };
      };
    };
    contentDetails?: {
      duration?: string;
    };
    statistics?: {
      viewCount?: string;
    };
  }>;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function getApiKey(): string {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key || key.trim() === "") {
    throw new Error(
      "YOUTUBE_API_KEY environment variable is required for YouTube Data API",
    );
  }
  return key;
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

async function youtubeFetch<T>(path: string, params: Record<string, string>): Promise<T> {
  const apiKey = getApiKey();
  const query = new URLSearchParams({ ...params, key: apiKey }).toString();
  const response = await fetch(`${BASE_URL}${path}?${query}`);

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `YouTube Data API ${path} failed (${response.status} ${response.statusText}): ${text.slice(0, 500)}`,
    );
  }

  return (await response.json()) as T;
}

// ---------------------------------------------------------------------------
// ISO 8601 Duration parser (e.g. "PT15M30S" → 930 seconds).
// Supports days/hours/minutes/seconds. Returns undefined when input is missing.
// ---------------------------------------------------------------------------

function parseIsoDuration(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const match = iso.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/);
  if (!match) return undefined;

  const days = match[1] ? parseInt(match[1], 10) : 0;
  const hours = match[2] ? parseInt(match[2], 10) : 0;
  const minutes = match[3] ? parseInt(match[3], 10) : 0;
  const seconds = match[4] ? parseFloat(match[4]) : 0;

  return days * 86_400 + hours * 3_600 + minutes * 60 + Math.round(seconds);
}

type Thumbnails = {
  high?: { url?: string };
  medium?: { url?: string };
  default?: { url?: string };
};

function pickThumbnail(thumbnails: Thumbnails | undefined): string | undefined {
  return thumbnails?.high?.url ?? thumbnails?.medium?.url ?? thumbnails?.default?.url;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch all videos in a playlist, paginating through every page,
 * then enrich each entry with duration + view counts via the videos endpoint.
 */
export async function fetchPlaylistVideos(playlistId: string): Promise<PlaylistVideo[]> {
  const items: PlaylistVideo[] = [];
  let pageToken: string | undefined;

  // --- Step 1: paginate playlistItems ---
  do {
    const params: Record<string, string> = {
      part: "snippet,contentDetails",
      playlistId,
      maxResults: String(PAGE_SIZE),
    };
    if (pageToken) params.pageToken = pageToken;

    const page = await youtubeFetch<PlaylistItemsResponse>("/playlistItems", params);

    for (const entry of page.items ?? []) {
      const videoId = entry.snippet?.resourceId?.videoId ?? entry.contentDetails?.videoId;
      if (!videoId) continue;

      items.push({
        videoId,
        title: entry.snippet?.title ?? "",
        description: entry.snippet?.description ?? "",
        channelTitle: entry.snippet?.channelTitle ?? "",
        publishedAt:
          entry.contentDetails?.videoPublishedAt ?? entry.snippet?.publishedAt ?? "",
        thumbnailUrl: pickThumbnail(entry.snippet?.thumbnails),
      });
    }

    pageToken = page.nextPageToken;
  } while (pageToken);

  // --- Step 2: enrich with duration + view count, batched 50 at a time ---
  for (let i = 0; i < items.length; i += PAGE_SIZE) {
    const batch = items.slice(i, i + PAGE_SIZE);
    const ids = batch.map((v) => v.videoId).join(",");

    const detailsResponse = await youtubeFetch<VideosResponse>("/videos", {
      part: "contentDetails,snippet,statistics",
      id: ids,
    });

    const byId = new Map<string, VideosResponse["items"][number]>();
    for (const item of detailsResponse.items ?? []) {
      if (item.id) byId.set(item.id, item);
    }

    for (const video of batch) {
      const detail = byId.get(video.videoId);
      if (!detail) continue;

      const durationSeconds = parseIsoDuration(detail.contentDetails?.duration);
      if (durationSeconds !== undefined) {
        video.durationSeconds = durationSeconds;
      }

      const viewCountRaw = detail.statistics?.viewCount;
      if (viewCountRaw) {
        const parsed = Number(viewCountRaw);
        if (!Number.isNaN(parsed)) video.viewCount = parsed;
      }

      // Fill in any snippet fields that were missing on the playlistItems entry
      if (!video.title && detail.snippet?.title) video.title = detail.snippet.title;
      if (!video.description && detail.snippet?.description) {
        video.description = detail.snippet.description;
      }
      if (!video.channelTitle && detail.snippet?.channelTitle) {
        video.channelTitle = detail.snippet.channelTitle;
      }
      if (!video.publishedAt && detail.snippet?.publishedAt) {
        video.publishedAt = detail.snippet.publishedAt;
      }
      if (!video.thumbnailUrl) {
        const thumb = pickThumbnail(detail.snippet?.thumbnails);
        if (thumb) video.thumbnailUrl = thumb;
      }
    }
  }

  return items;
}
