/** Strip markdown fences and extract the outermost JSON object from text. */
export function extractJson(text: string): unknown | null {
  // Strip markdown code fences if present
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  const cleaned = fenceMatch ? fenceMatch[1].trim() : text;
  // Find the outermost JSON object
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    return JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }
}

/**
 * Sanitize a brand name to prevent prompt injection.
 * Allows alphanumeric characters, spaces, hyphens, ampersands, apostrophes,
 * periods, and common accented characters used in brand names (e.g. "Arc'teryx",
 * "Black & Decker", "Fjällräven"). Strips everything else and truncates to 100 chars.
 */
export function sanitizeBrandName(name: string): string {
  const sanitized = name
    .replace(/[^\w\s\-&'.,éèêëàâùûüôîïæœçÉÈÊËÀÂÙÛÜÔÎÏÆŒÇäöüÄÖÜß]/g, "")
    .trim()
    .slice(0, 100);

  if (!sanitized) {
    throw new Error(`Invalid brand name: "${name}" contains no valid characters`);
  }

  return sanitized;
}

/**
 * Sanitize untrusted web-scraped content before embedding it in an LLM prompt.
 * Truncates long content and strips common prompt injection patterns so that
 * malicious instructions embedded in scraped pages cannot hijack the agent.
 */
export function sanitizeWebContent(content: string): string {
  // Truncate to a safe length to prevent extremely long injections
  const truncated = content.slice(0, 8000);

  // Strip common prompt injection phrases/delimiters
  return truncated
    .replace(/ignore\s+(all\s+)?previous\s+instructions?/gi, "[REDACTED]")
    .replace(/disregard\s+(all\s+)?previous\s+instructions?/gi, "[REDACTED]")
    .replace(/you\s+are\s+now\s+/gi, "[REDACTED] ")
    .replace(/new\s+instructions?:/gi, "[REDACTED]:")
    .replace(/system\s+prompt:/gi, "[REDACTED]:")
    .replace(/\[SYSTEM\]/gi, "[REDACTED]")
    .replace(/\[INST\]/gi, "[REDACTED]")
    .replace(/<\|system\|>/gi, "[REDACTED]")
    .replace(/<\|user\|>/gi, "[REDACTED]")
    .replace(/<\|assistant\|>/gi, "[REDACTED]");
}
