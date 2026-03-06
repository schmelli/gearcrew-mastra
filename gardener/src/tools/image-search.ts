import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export const imageSearch = createTool({
  id: "imageSearch",
  description: `Search Google Images for outdoor gear product photos using Serper.
Use when a product is missing an imageUrl and og:image wasn't available from web scraping.
Prefer manufacturer domain images when available.`,
  inputSchema: z.object({
    query: z.string().describe("Product search query, e.g. 'Hilleberg Nallo 2 GT tent'"),
    maxResults: z.number().min(1).max(5).default(3),
  }),
  outputSchema: z.object({
    images: z.array(
      z.object({
        imageUrl: z.string(),
        sourceUrl: z.string(),
        title: z.string(),
        width: z.number().optional(),
        height: z.number().optional(),
      }),
    ),
  }),
  execute: async ({ context: { query, maxResults } }) => {
    const apiKey = process.env.SERPER_API_KEY;
    if (!apiKey) {
      throw new Error("SERPER_API_KEY environment variable is required");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    try {
      const response = await fetch("https://google.serper.dev/images", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-KEY": apiKey,
        },
        body: JSON.stringify({
          q: query,
          num: maxResults,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(
          `Serper Images API error: ${response.status} ${response.statusText}`,
        );
      }

      const data = (await response.json()) as {
        images?: Array<{
          imageUrl?: string;
          link?: string;
          title?: string;
          imageWidth?: number;
          imageHeight?: number;
        }>;
      };
      const rawImages = data.images || [];

      const images = rawImages
        .filter(
          (img) =>
            img.imageUrl &&
            img.imageWidth !== undefined &&
            img.imageWidth >= 200,
        )
        .map((img) => ({
          imageUrl: img.imageUrl!,
          sourceUrl: img.link || "",
          title: img.title || "",
          width: img.imageWidth,
          height: img.imageHeight,
        }));

      return { images };
    } finally {
      clearTimeout(timeout);
    }
  },
});
