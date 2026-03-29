import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export const webSearch = createTool({
  id: "webSearch",
  description: `Search the web for outdoor gear information using Serper (Google Search API).
Best for: Finding product reviews, discovering new releases, verifying specs.
Keep queries specific: "MSR Hubba Hubba NX 2 2025 specs weight" not "MSR tents".`,
  inputSchema: z.object({
    query: z.string().describe("Search query (specific, 3-8 words)"),
    maxResults: z.number().min(1).max(10).default(5),
  }),
  outputSchema: z.object({
    results: z.array(
      z.object({
        title: z.string(),
        url: z.string(),
        content: z.string(),
      }),
    ),
  }),
  execute: async ({ query, maxResults }) => {
    const apiKey = process.env.SERPER_API_KEY;
    if (!apiKey) {
      throw new Error("SERPER_API_KEY environment variable is required");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    try {
      const response = await fetch("https://google.serper.dev/search", {
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
          `Serper API error: ${response.status} ${response.statusText}`,
        );
      }

      const data = (await response.json()) as { organic?: Array<{ title?: string; link?: string; snippet?: string }> };
      const organic = data.organic || [];

      return {
        results: organic.map(
          (item: { title?: string; link?: string; snippet?: string }) => ({
            title: item.title || "",
            url: item.link || "",
            content: item.snippet || "",
          }),
        ),
      };
    } finally {
      clearTimeout(timeout);
    }
  },
});
