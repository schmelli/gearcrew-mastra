import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export const webSearch = createTool({
  id: "webSearch",
  description: `Search the web for outdoor gear information using Tavily.
Best for: Finding product reviews, discovering new releases, verifying specs.
Keep queries specific: "MSR Hubba Hubba NX 2 2025 specs weight" not "MSR tents".`,
  inputSchema: z.object({
    query: z.string().describe("Search query (specific, 3-8 words)"),
    maxResults: z.number().min(1).max(10).default(5),
    searchDepth: z.enum(["basic", "advanced"]).default("basic"),
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
  execute: async ({ context: { query, maxResults, searchDepth } }) => {
    const apiKey = process.env.TAVILY_API_KEY;
    if (!apiKey) {
      throw new Error("TAVILY_API_KEY environment variable is required");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    try {
      const response = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: apiKey,
          query,
          max_results: maxResults,
          search_depth: searchDepth,
          include_domains: [
            "rei.com",
            "backpackinglight.com",
            "sectionhiker.com",
            "outdoorgearlab.com",
            "switchbacktravel.com",
            "cleverhiker.com",
            "globetrotter.de",
            "bergfreunde.de",
            "bergzeit.de",
          ],
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(
          `Tavily API error: ${response.status} ${response.statusText}`,
        );
      }

      const result = await response.json();
      return { results: result.results || [] };
    } finally {
      clearTimeout(timeout);
    }
  },
});
