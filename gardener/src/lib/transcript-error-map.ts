/**
 * Known transcription error patterns for outdoor gear brands and terms.
 * Used by the Gardener agent to correct common audio-to-text mistakes.
 */

export interface TranscriptCorrection {
  /** Regex pattern matching the incorrect transcript text */
  pattern: RegExp;
  /** Correct brand/term name */
  correction: string;
  /** Category: 'brand' | 'material' | 'term' */
  category: "brand" | "material" | "term";
  /** Explanation for the agent */
  note: string;
}

export const TRANSCRIPT_ERROR_MAP: TranscriptCorrection[] = [
  // === Brands — common misheard names ===
  {
    pattern: /\b(gossamer\s*(?:here|year|gear|ear))\b/i,
    correction: "Gossamer Gear",
    category: "brand",
    note: "Ultralight backpack manufacturer",
  },
  {
    pattern: /\b(u\s*l\s*a|you\s*la)\b/i,
    correction: "ULA",
    category: "brand",
    note: "Ultralight Adventures — backpack maker",
  },
  {
    pattern: /\b(e\s*e|double\s*e)\b/i,
    correction: "Enlightened Equipment",
    category: "brand",
    note: "Quilt and sleeping bag manufacturer",
  },
  {
    pattern: /\b(hyper\s*light|hyper\s*lite)\b/i,
    correction: "Hyperlite Mountain Gear",
    category: "brand",
    note: "DCF shelter and pack maker",
  },
  {
    pattern:
      /\b(see?\s*(?:bags?|backs?|packs?|pax)|c\s*(?:bags?|packs?)|z\s*pax)\b/i,
    correction: "Zpacks",
    category: "brand",
    note: "DCF ultralight gear manufacturer",
  },
  {
    pattern: /\b(terma?\s*rest|thermal?\s*rest)\b/i,
    correction: "Therm-a-Rest",
    category: "brand",
    note: "Sleeping pad manufacturer (Cascade Designs)",
  },
  {
    pattern: /\b(big\s*agnus)\b/i,
    correction: "Big Agnes",
    category: "brand",
    note: "Tent and sleeping bag manufacturer",
  },
  {
    pattern: /\b(mountain\s*laurel)\b/i,
    correction: "Mountain Laurel Designs",
    category: "brand",
    note: "MLD — ultralight shelter maker",
  },
  {
    pattern: /\b(six\s*moon)\b/i,
    correction: "Six Moon Designs",
    category: "brand",
    note: "SMD — ultralight shelter maker",
  },
  {
    pattern: /\b(underground\s*quilts?)\b/i,
    correction: "Underground Quilts",
    category: "brand",
    note: "UGQ — budget quilt maker",
  },
  {
    pattern: /\b(tarped?\s*tent)\b/i,
    correction: "Tarptent",
    category: "brand",
    note: "Ultralight tent manufacturer",
  },
  {
    pattern: /\b(sea\s*to\s*summit|sea\s*2\s*summit)\b/i,
    correction: "Sea to Summit",
    category: "brand",
    note: "Australian outdoor gear brand",
  },
  {
    pattern: /\b(kate?\s*a?\s*batic)\b/i,
    correction: "Katabatic Gear",
    category: "brand",
    note: "Quilt manufacturer",
  },
  {
    pattern: /\b(granite\s*(?:here|year|gear|ear))\b/i,
    correction: "Granite Gear",
    category: "brand",
    note: "Backpack and storage manufacturer",
  },
  {
    pattern: /\b(nee?mo|knee\s*mo)\b/i,
    correction: "NEMO Equipment",
    category: "brand",
    note: "Tent and sleeping pad manufacturer",
  },
  {
    pattern: /\b(saw\s*yer|so\s*yer)\b/i,
    correction: "Sawyer",
    category: "brand",
    note: "Water filter manufacturer (Sawyer Squeeze, Sawyer Mini)",
  },
  {
    pattern: /\b(plat[iy]\s*puss?)\b/i,
    correction: "Platypus",
    category: "brand",
    note: "Water bottle and filter manufacturer (Cascade Designs)",
  },
  {
    pattern: /\b(pa?tagonia)\b/i,
    correction: "Patagonia",
    category: "brand",
    note: "Outdoor clothing and gear brand",
  },
  {
    pattern: /\b(arc\s*terri?x|arc\s*terex)\b/i,
    correction: "Arc'teryx",
    category: "brand",
    note: "Premium outdoor clothing and gear brand",
  },
  {
    pattern: /\b(osp[ae]?ry)\b/i,
    correction: "Osprey",
    category: "brand",
    note: "Backpack manufacturer (Exos, Atmos, etc.)",
  },

  // === Brand abbreviations the agent must expand ===
  {
    pattern: /\bHMG\b/,
    correction: "Hyperlite Mountain Gear",
    category: "brand",
    note: "Common abbreviation",
  },
  {
    pattern: /\bEE\b/,
    correction: "Enlightened Equipment",
    category: "brand",
    note: "Common abbreviation",
  },
  {
    pattern: /\bMLD\b/,
    correction: "Mountain Laurel Designs",
    category: "brand",
    note: "Common abbreviation",
  },
  {
    pattern: /\bSMD\b/,
    correction: "Six Moon Designs",
    category: "brand",
    note: "Common abbreviation",
  },
  {
    pattern: /\bUGQ\b/,
    correction: "Underground Quilts",
    category: "brand",
    note: "Common abbreviation",
  },
  {
    pattern: /\bS2S\b/,
    correction: "Sea to Summit",
    category: "brand",
    note: "Common abbreviation",
  },
  {
    pattern: /\bMSR\b/,
    correction: "MSR",
    category: "brand",
    note: "Mountain Safety Research — already correct but verify",
  },
  {
    pattern: /\bBA\b/,
    correction: "Big Agnes",
    category: "brand",
    note: "Common abbreviation in gear discussions",
  },

  // === Materials — commonly confused ===
  {
    pattern: /\b(DCF|cuben\s*fiber)\b/i,
    correction: "Dyneema Composite Fabric",
    category: "material",
    note: "Formerly Cuben Fiber, now DCF",
  },
  {
    pattern: /\b(sil\s*nylon|silnylon)\b/i,
    correction: "Silicone-coated Nylon (SilNylon)",
    category: "material",
    note: "Lightweight waterproof fabric",
  },
  {
    pattern: /\b(sil\s*poly|silpoly)\b/i,
    correction: "Silicone-coated Polyester (SilPoly)",
    category: "material",
    note: "UV-resistant waterproof fabric",
  },
  {
    pattern: /\b(x[\s-]?pac)\b/i,
    correction: "X-Pac",
    category: "material",
    note: "MATERIAL, not a brand! Laminated composite fabric",
  },
  {
    pattern: /\b(dyneema)\b/i,
    correction: "Dyneema",
    category: "material",
    note: "UHMWPE fiber brand — can be material or fabric component",
  },
  {
    pattern: /\b(pertex)\b/i,
    correction: "Pertex",
    category: "material",
    note: "Lightweight shell fabric used in down jackets and sleeping bags",
  },
  {
    pattern: /\b(gore[\s-]?tex|goretex)\b/i,
    correction: "Gore-Tex",
    category: "material",
    note: "Waterproof breathable membrane by W. L. Gore & Associates",
  },
  {
    pattern: /\b(polycro|poly\s*cryo)\b/i,
    correction: "Polycro",
    category: "material",
    note: "Polycryo — ultralight ground sheet material (window insulation film)",
  },
  {
    pattern: /\b(tyvek|ty\s*vec)\b/i,
    correction: "Tyvek",
    category: "material",
    note: "DuPont house wrap used as ultralight ground sheet",
  },

  // === Terms ===
  {
    pattern: /\b(base\s*weight|base\s*wait)\b/i,
    correction: "Base Weight",
    category: "term",
    note: "Total pack weight minus consumables (food, water, fuel)",
  },
  {
    pattern: /\b(worn\s*weight|warn\s*wait)\b/i,
    correction: "Worn Weight",
    category: "term",
    note: "Weight of items worn on body, not in pack",
  },
  {
    pattern: /\b(skin\s*out)\b/i,
    correction: "Skin-Out Weight",
    category: "term",
    note: "Total weight of everything including worn items",
  },
  {
    pattern: /\b(lighter\s*pack|light\s*er\s*pack)\b/i,
    correction: "LighterPack",
    category: "term",
    note: "Popular gear list website (lighterpack.com)",
  },
  {
    pattern: /\b(ultra\s*light|ultra\s*lite)\b/i,
    correction: "Ultralight",
    category: "term",
    note: "Backpacking philosophy: base weight under 10 lbs (4.5 kg)",
  },
  {
    pattern: /\b(super\s*ultra\s*light|SUL)\b/i,
    correction: "Super Ultralight (SUL)",
    category: "term",
    note: "Base weight under 5 lbs (2.3 kg)",
  },
  {
    pattern: /\b(fast\s*pack(?:ing)?)\b/i,
    correction: "Fastpacking",
    category: "term",
    note: "Trail running with overnight gear — hybrid of running and backpacking",
  },
  {
    pattern: /\b(thru[\s-]?hik(?:e|ing|er))\b/i,
    correction: "Thru-Hiking",
    category: "term",
    note: "End-to-end completion of a long-distance trail (AT, PCT, CDT)",
  },
];

/**
 * Format the error map as a readable reference for the system prompt.
 */
export function formatErrorMapForPrompt(): string {
  const brands = TRANSCRIPT_ERROR_MAP.filter((e) => e.category === "brand");
  const materials = TRANSCRIPT_ERROR_MAP.filter(
    (e) => e.category === "material"
  );
  const terms = TRANSCRIPT_ERROR_MAP.filter((e) => e.category === "term");

  let output = "### Known Transcription Errors\n\n";

  output += "**Brands (commonly misheard):**\n";
  for (const entry of brands) {
    output += `- "${entry.pattern.source}" -> ${entry.correction} (${entry.note})\n`;
  }

  output += "\n**Materials (commonly confused):**\n";
  for (const entry of materials) {
    output += `- "${entry.pattern.source}" -> ${entry.correction} (${entry.note})\n`;
  }

  output += "\n**Terms:**\n";
  for (const entry of terms) {
    output += `- "${entry.pattern.source}" -> ${entry.correction} (${entry.note})\n`;
  }

  return output;
}
