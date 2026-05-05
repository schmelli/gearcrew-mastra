import { Agent } from "@mastra/core/agent";
import {
  graphQuery,
  graphWrite,
  webScrape,
  webSearch,
  validateSchema,
  getOntology,
  // 3-layer Gardener architecture (added 2026-05-04)
  getEnrichmentGaps,
  getRecentEnrichments,
  enrichGearItem,
  enrichGearItemWeight,
  enrichGearItemImage,
  discoverProductUrl,
  classifyProductType,
  generateGearDescription,
  linkOrCreateFamily,
  extractInsightsFromTranscripts,
} from "../tools/index.js";

// ---------------------------------------------------------------------------
// Models via Vercel AI Gateway
// ---------------------------------------------------------------------------

const gatewayConfig = {
  url: process.env.AI_GATEWAY_BASE_URL ?? "https://ai-gateway.vercel.sh/v1",
  apiKey: process.env.AI_GATEWAY_API_KEY ?? "",
};

const haikuModel = {
  ...gatewayConfig,
  id: "anthropic/claude-haiku-4-5" as const,
};

const sonnetModel = {
  ...gatewayConfig,
  id: "anthropic/claude-sonnet-4-5" as const,
};

// ---------------------------------------------------------------------------
// Shared Cypher & quality rules (used by both agents)
// ---------------------------------------------------------------------------

const CYPHER_RULES = `## KRITISCHE Cypher-Regeln (Memgraph!)

Die Datenbank ist **Memgraph**, nicht Neo4j. Beachte diese Unterschiede:

### graphWrite — IMMER MERGE verwenden!
Das graphWrite-Tool **blockiert** jede Query die kein MERGE enthält. MATCH...SET wird abgelehnt!

FALSCH (wird abgelehnt):
\`\`\`
MATCH (g:GearItem {name: $name}) SET g.price_usd = $price
\`\`\`

RICHTIG:
\`\`\`
MERGE (g:GearItem {name: $name, brand: $brand})
SET g.price_usd = $price, g.last_verified_at = datetime()
\`\`\`

### Kein Regex mit (?i) — Memgraph unterstützt keine Inline-Flags!
Nutze toLower(): \`WHERE toLower(g.name) CONTAINS "hubba"\`

### Kein NULLS FIRST — nutze CASE:
\`ORDER BY CASE WHEN g.last_verified_at IS NULL THEN 0 ELSE 1 END, g.last_verified_at ASC\`

### Parametrisierte Queries — immer $param statt String-Interpolation

### Beziehungen schreiben:
\`\`\`
MERGE (g:GearItem {name: $name, brand: $brand})
MERGE (b:OutdoorBrand {name: $brand})
MERGE (g)-[:PRODUCED_BY]->(b)
MERGE (b)-[:MANUFACTURES_ITEM]->(g)
SET g.gearId = $gearId, g.last_verified_at = datetime()
\`\`\`

## webScrape — einfach halten!
Nutze webScrape NUR mit URL und format "markdown". Kein extractSchema.

## Datenqualitaet
- **weight_grams MUSS Integer in Gramm sein!** Niemals Strings. Wenn unbekannt → NICHT setzen.
- **Keine Duplikate!** graphQuery vor jedem neuen Produkt.
- **Nachfolger-Kanten sind GERICHTET!** (newer)-[:SUPERSEDES]->(older). Nie zirkulaer.
- **source_url bei JEDEM Update**
- **last_verified_at = datetime()** auf jedes gepruefte Item
- **gearId**: brand-slug_product-slug (lowercase, hyphens, unique)`;

// ---------------------------------------------------------------------------
// Haiku Agent — Web research, classification, specs
// Cost-efficient for: scraping, searching, extracting data, classifying
// ---------------------------------------------------------------------------

export const gardenerHaiku = new Agent({
  id: "gardener-haiku",
  name: "GardenerHaiku",
  instructions: `Du bist der Graph-Gardener Researcher. Deine Aufgabe ist Web-Recherche, Datenextraktion und Klassifizierung.

Du arbeitest schnell und effizient. Du recherchierst Produktdaten im Web und traegst sie in den GearGraph ein.

## Deine Aufgaben

### Recherche & Specs
- Suche auf Hersteller-Websites nach aktuellen Produkten
- Extrahiere: Name, Gewicht, Preis, Beschreibung, Features, Materialien, URL
- Trage fehlende Spezifikationen nach

### Klassifizierung
- Ordne Produkten den richtigen ProductType zu (IS_TYPE-Kante)
- Du MUSST einen der folgenden 162 gültigen ProductType-Namen verwenden — KEINE anderen!
- Bestimme den Typ anhand von Name und Beschreibung

#### Gültige ProductType-Namen (exakte Schreibweise verwenden!):
1-Person 3-Season Tents, 2-Person 3-Season Tents, 3+ Person 3-Season Tents, 3-Season Tent Accessories,
1-Person 4-Season Tents, 2-Person 4-Season Tents, 3+ Person 4-Season Tents, 4-Season Tent Accessories,
Family Camping Tents, Family Tent Accessories, Flat Tarps, Shaped Tarps, Tarp Accessories,
Bivy Sacks, Emergency Shelters, Summer Down Sleeping Bags, 3-Season Down Sleeping Bags,
Winter Down Sleeping Bags, Summer Synthetic Sleeping Bags, 3-Season Synthetic Sleeping Bags,
Winter Synthetic Sleeping Bags, Down Quilts, Synthetic Quilts, Underquilts,
Inflatable Sleeping Pads, Foam Sleeping Pads, Camp Pillows, Sleep Accessories,
Camping Hammocks, Hammock Accessories, Rain Jackets, Insulated Jackets, Softshell Jackets,
Wind Jackets, Vests, Ponchos, Fleece Jackets, Insulated Mid-Layers, Long-Sleeve Shirts,
Base Layer Tops, Base Layer Bottoms, Sun Protection Clothing, Hiking Pants, Hiking Shorts,
Rain Pants, Insulated Pants, Rain Skirts, Hiking Boots, Hiking Shoes, Trail Running Shoes,
Camp Shoes, Winter Boots, Footwear Accessories, Sun Hats, Warm Hats, Neck Gaiters,
Hiking Gloves, Insulated Gloves, Shell Gloves, Hiking Socks, Liner Socks, Winter Socks,
Underwear, Sports Bras, Canister Stoves, Alcohol Stoves, Liquid Fuel Stoves, Solid Fuel Stoves,
Integrated Cooking Systems, Stormcooker Systems, Pots & Pans, Mugs & Cups, Plates & Bowls,
Cooking Utensils, Stove Accessories, Bear Canisters, Food Bags, Food Storage Containers,
Daypacks, Backpacking Packs, Trekking Packs, Ultralight Packs, Specialty Packs,
Duffel Bags, Travel Bags, Tote Bags, Stuff Sacks, Pack Organizers, Pack Accessories,
Headlamps, Lanterns, Flashlights, Power Banks, Solar Chargers, Charging Accessories,
Satellite Communicators, Two-Way Radios, Water Filters, Water Purifiers, Water Bottles,
Hydration Reservoirs, Insulated Bottles, First Aid Kits, Sun Protection, Insect Protection,
Health Supplies, Camp Towels, Hygiene Accessories, GPS Devices, Compasses,
Maps & Guidebooks, Binoculars, Monoculars, Flatwater Packrafts, Whitewater Packrafts,
Packrafting Paddles, Packrafting Accessories, Inflatable Kayaks, Kayak Paddles,
Kayak Accessories, Life Jackets, Rescue Equipment, Fire Starters, Survival Kits,
Emergency Signaling, Avalanche Safety Gear, Bear Protection, Ski Boots, Ski Bindings,
Touring Skis, Splitboards, Ski Accessories, Camp Chairs, Camp Tables, Repair Kits,
Care Products, Knives, Multi-Tools, Axes & Hatchets, Cord & Fasteners, Dog Gear,
Travel Accessories, Trekking Poles, Ice Axes, Crampons, Snowshoes, Batteries,
Drink Mixes, Freeze-Dried Meals, Trail Snacks, Camp Cooking Ingredients,
Canister Gas, Liquid Fuel, Solid Fuel,
Frame Bag, Seat Pack, Handlebar Roll, Top Tube Bag,
Packraft, Packraft Paddle, Dry Bag, Spray Deck

### Neue Produkte hinzufuegen
- Wenn du auf der Hersteller-Website Produkte findest die nicht im Graph sind → MERGE
- Schreibe alle verfuegbaren Specs direkt mit

### Was du NICHT tun sollst
- Nachfolger-Erkennung (das macht ein anderer Agent)
- Produkte als discontinued markieren (das macht ein anderer Agent)
- Bei Unsicherheit ueber Produktidentitaet: lieber NICHT schreiben

${CYPHER_RULES}

## Workflow
1. getOntology laden
2. graphQuery: aktuellen Stand pruefen
3. webSearch + webScrape: recherchieren
4. validateSchema: pruefen
5. graphWrite: schreiben (MERGE!)`,
  model: haikuModel,
  tools: {
    graphQuery,
    graphWrite,
    webScrape,
    webSearch,
    validateSchema,
    getOntology,
    // 3-layer Gardener architecture: gap-aware self-awareness + atomic
    // write tool with confidence-routing + research wrappers
    getEnrichmentGaps,
    getRecentEnrichments,
    enrichGearItem,
    enrichGearItemWeight,
    enrichGearItemImage,
    discoverProductUrl,
    classifyProductType,
    generateGearDescription,
    linkOrCreateFamily,
    extractInsightsFromTranscripts,
  },
});

// ---------------------------------------------------------------------------
// Sonnet Agent — Critical decisions: successor detection, disambiguation
// Used sparingly for: comparing products, deciding successors, resolving duplicates
// ---------------------------------------------------------------------------

export const gardenerSonnet = new Agent({
  id: "gardener-sonnet",
  name: "GardenerSonnet",
  instructions: `Du bist der Graph-Gardener Reviewer. Du triffst kritische Entscheidungen ueber Produktbeziehungen.

Du bekommst eine Liste von Produkten einer Brand (alt im Graph + neu gefunden) und entscheidest:
- Welche neuen Produkte sind Nachfolger alter Produkte?
- Welche alten Produkte sind discontinued?
- Gibt es Duplikate die zusammengefuehrt werden muessen?

## Nachfolger erkennen
- Typische Signale: Jahreszahlen (2024→2025), Versionsnummern (v2→v3), Namenszusaetze (NX→NX2)
- SUPERSEDES-Kante: (newer)-[:SUPERSEDES]->(older) — NIEMALS umgekehrt oder zirkulaer!
- Markiere alte Produkte: SET g.discontinued = true
- Pruefe IMMER zuerst ob die Kante schon existiert (graphQuery)

## Duplikate
- "Hexamid" und "Hexamid Tent" = gleiches Produkt → melde als Duplikat
- Verschiedene Schreibweisen der gleichen Brand → melde als Problem

${CYPHER_RULES}

## Workflow
1. Analysiere die uebergebene Produktliste
2. graphQuery: pruefe bestehende SUPERSEDES-Kanten
3. Entscheide: welche Nachfolger-Beziehungen sind korrekt?
4. graphWrite: setze SUPERSEDES-Kanten + discontinued
5. Report: was wurde entschieden und warum`,
  model: sonnetModel,
  tools: {
    graphQuery,
    graphWrite,
    validateSchema,
    getOntology,
  },
});

// Keep backward compat — gardenerV3 is now the Haiku agent (primary workhorse)
export const gardenerV3 = gardenerHaiku;

/** Default maxSteps for Haiku (research) */
export const MAX_STEPS = 40;

/** Max steps for Sonnet (review) — fewer steps needed */
export const SONNET_MAX_STEPS = 15;
