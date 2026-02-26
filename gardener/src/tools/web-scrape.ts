import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export const webScrape = createTool({
  id: "webScrape",
  description: `Scrape a web page using Firecrawl to extract structured outdoor gear data.
Best for: Manufacturer product pages, retailer listings, brand about pages.
Returns: Structured JSON with extracted fields OR markdown content.
Rate limits apply — don't scrape more than 10 pages per minute.`,
  inputSchema: z.object({
    url: z.string().url().describe("The URL to scrape"),
    extractSchema: z
      .record(z.string())
      .optional()
      .describe("JSON schema describing what to extract"),
    format: z
      .enum(["json", "markdown"])
      .default("json")
      .describe("Output format"),
  }),
  outputSchema: z.object({
    data: z.any(),
    sourceUrl: z.string(),
    scrapedAt: z.string(),
  }),
  execute: async ({ context: { url, extractSchema, format } }) => {
    const apiKey = process.env.FIRECRAWL_API_KEY;
    if (!apiKey) {
      throw new Error("FIRECRAWL_API_KEY environment variable is required");
    }

    const response = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        url,
        formats: extractSchema
          ? [
              {
                type: "json",
                prompt: `Extract outdoor gear data: ${JSON.stringify(extractSchema)}`,
                schema: extractSchema,
              },
            ]
          : [format],
        onlyMainContent: true,
        waitFor: 5000,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Firecrawl API error: ${response.status} ${response.statusText}`,
      );
    }

    const result = await response.json();
    return {
      data: result.data,
      sourceUrl: url,
      scrapedAt: new Date().toISOString(),
    };
  },
});
