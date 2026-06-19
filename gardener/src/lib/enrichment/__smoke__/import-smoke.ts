/**
 * SC1: Import Smoke Harness for migrated enrichment modules
 * Phase 27 — ARCH-01 verification
 *
 * Verifies that all 5 migrated enrichment modules import without error
 * in the gardener process (no @/ aliases, no 'ai' package, ESM imports).
 *
 * Run: npx tsx gardener/src/lib/enrichment/__smoke__/import-smoke.ts
 * Expected output: "SC1 PASS: all 5 enrichment modules imported successfully"
 */

import { enrichGearItem } from "../enrich-gear-item.js";
import { extractWithLlm } from "../llm-extraction.js";
import { searchKnowledgeGraph } from "../serper-knowledge-graph.js";
import { quickResearchItem, extractKnownBrand } from "../quick-research-import.js";
import { enrichInventoryItems } from "../enrich-inventory-items.js";

// Verify all exports are callable functions (type-level check at runtime)
const checks: [string, unknown][] = [
  ["enrichGearItem", enrichGearItem],
  ["extractWithLlm", extractWithLlm],
  ["searchKnowledgeGraph", searchKnowledgeGraph],
  ["quickResearchItem", quickResearchItem],
  ["extractKnownBrand", extractKnownBrand],
  ["enrichInventoryItems", enrichInventoryItems],
];

let passed = true;
for (const [name, fn] of checks) {
  if (typeof fn !== "function") {
    console.error(`SC1 FAIL: ${name} is not a function (got ${typeof fn})`);
    passed = false;
  }
}

if (passed) {
  console.log("SC1 PASS: all 5 enrichment modules imported successfully");
  console.log("  - enrich-gear-item.ts: enrichGearItem");
  console.log("  - llm-extraction.ts: extractWithLlm (gardener-native raw fetch)");
  console.log("  - serper-knowledge-graph.ts: searchKnowledgeGraph");
  console.log("  - quick-research-import.ts: quickResearchItem, extractKnownBrand");
  console.log("  - enrich-inventory-items.ts: enrichInventoryItems");
} else {
  process.exit(1);
}
