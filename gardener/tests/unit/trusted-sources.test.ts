import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the service-role client module BEFORE importing the unit under test.
const selectMock = vi.fn();

vi.mock("../../src/lib/supabase.js", () => ({
  getSupabase: () => ({
    from: () => ({
      select: () => ({
        eq: selectMock,
      }),
    }),
  }),
}));

import {
  DEFAULT_TRUSTED_SOURCES,
  normalizeDomain,
  matchesTrustedDomain,
  getTrustedSources,
  getTrustedDomains,
  getTrustWeight,
  isTrustedDomain,
  buildSearchUrl,
  clearTrustedSourcesCache,
} from "../../src/lib/trusted-sources.js";

beforeEach(() => {
  clearTrustedSourcesCache();
  selectMock.mockReset();
});

describe("normalizeDomain", () => {
  it("strips scheme, www, path and lowercases", () => {
    expect(normalizeDomain("https://www.REI.com/product/123")).toBe("rei.com");
  });

  it("accepts a bare domain", () => {
    expect(normalizeDomain("outdoorgearlab.com")).toBe("outdoorgearlab.com");
  });

  it("strips port and credentials", () => {
    expect(normalizeDomain("http://user:pass@rei.com:8080/path")).toBe(
      "rei.com",
    );
  });

  it("returns '' for serper sentinel values (no dot)", () => {
    expect(normalizeDomain("serper:answerBox")).toBe("");
    expect(normalizeDomain("serper:organic:unknown")).toBe("");
  });

  it("returns '' for empty / non-domain input", () => {
    expect(normalizeDomain("")).toBe("");
    expect(normalizeDomain("localhost")).toBe("");
  });
});

describe("matchesTrustedDomain", () => {
  const trusted = ["rei.com", "outdoorgearlab.com"];

  it("matches exact domain", () => {
    expect(matchesTrustedDomain("https://rei.com/x", trusted)).toBe(true);
  });

  it("matches a second-level subdomain", () => {
    expect(matchesTrustedDomain("https://shop.rei.com/x", trusted)).toBe(true);
  });

  it("does not match a spoofed lookalike (notrei.com)", () => {
    expect(matchesTrustedDomain("https://notrei.com/x", trusted)).toBe(false);
  });

  it("does not match an unrelated domain", () => {
    expect(matchesTrustedDomain("https://amazon.com", trusted)).toBe(false);
  });
});

function okResult(
  rows: Array<{
    domain: string;
    name: string;
    trust_weight: number | string;
    category: string;
    active: boolean;
    search_url_template?: string | null;
  }>,
) {
  return Promise.resolve({ data: rows, error: null });
}

describe("getTrustedSources — DB success + cache", () => {
  it("maps rows and caches (single DB call across repeated reads)", async () => {
    selectMock.mockReturnValueOnce(
      okResult([
        {
          domain: "example.com",
          name: "Example",
          trust_weight: 0.66,
          category: "review",
          active: true,
        },
      ]),
    );

    const first = await getTrustedSources();
    const second = await getTrustedSources();

    expect(first).toEqual([
      {
        domain: "example.com",
        name: "Example",
        trustWeight: 0.66,
        category: "review",
        active: true,
        searchUrlTemplate: null,
      },
    ]);
    // Cache hit → DB queried only once.
    expect(selectMock).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it("coerces string trust_weight and clamps to [0,1]; unknown category → other", async () => {
    selectMock.mockReturnValueOnce(
      okResult([
        {
          domain: "high.com",
          name: "High",
          trust_weight: "1.5",
          category: "bogus",
          active: true,
        },
      ]),
    );

    const sources = await getTrustedSources();
    expect(sources[0].trustWeight).toBe(1);
    expect(sources[0].category).toBe("other");
  });
});

describe("getTrustedSources — resilient fallback", () => {
  it("falls back to DEFAULT_TRUSTED_SOURCES on DB error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    selectMock.mockReturnValueOnce(
      Promise.resolve({ data: null, error: { message: "boom" } }),
    );

    const sources = await getTrustedSources();
    expect(sources).toEqual([...DEFAULT_TRUSTED_SOURCES]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("falls back to DEFAULT_TRUSTED_SOURCES when DB returns no active rows", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    selectMock.mockReturnValueOnce(okResult([]));

    const sources = await getTrustedSources();
    expect(sources).toEqual([...DEFAULT_TRUSTED_SOURCES]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("falls back when the query throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    selectMock.mockImplementationOnce(() => {
      throw new Error("network down");
    });

    const sources = await getTrustedSources();
    expect(sources).toEqual([...DEFAULT_TRUSTED_SOURCES]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("derived accessors (over fallback data)", () => {
  beforeEach(() => {
    // Force the fallback dataset for deterministic assertions.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    selectMock.mockReturnValueOnce(okResult([]));
    void warn;
  });

  it("getTrustedDomains returns bare normalized domains", async () => {
    const domains = await getTrustedDomains();
    expect(domains).toContain("outdoorgearlab.com");
    expect(domains).toContain("rei.com");
  });

  it("getTrustWeight returns the source weight for a matching URL", async () => {
    await expect(
      getTrustWeight("https://www.outdoorgearlab.com/reviews/x"),
    ).resolves.toBe(0.9);
  });

  it("getTrustWeight returns 0 for an untrusted / sentinel input", async () => {
    await expect(getTrustWeight("https://amazon.com")).resolves.toBe(0);
    await expect(getTrustWeight("serper:answerBox")).resolves.toBe(0);
  });

  it("isTrustedDomain reflects membership including subdomains", async () => {
    await expect(isTrustedDomain("https://shop.rei.com")).resolves.toBe(true);
    await expect(isTrustedDomain("https://notrei.com")).resolves.toBe(false);
  });
});

describe("searchUrlTemplate + buildSearchUrl", () => {
  it("maps search_url_template from the DB row", async () => {
    selectMock.mockReturnValueOnce(
      okResult([
        {
          domain: "bettertrail.com",
          name: "BetterTrail",
          trust_weight: 0.7,
          category: "review",
          active: true,
          search_url_template: "https://bettertrail.com/search?q={query}",
        },
      ]),
    );
    const [source] = await getTrustedSources();
    expect(source?.searchUrlTemplate).toBe(
      "https://bettertrail.com/search?q={query}",
    );
  });

  it("defaults searchUrlTemplate to null when the column is absent", async () => {
    selectMock.mockReturnValueOnce(
      okResult([
        { domain: "x.com", name: "X", trust_weight: 0.5, category: "review", active: true },
      ]),
    );
    const [source] = await getTrustedSources();
    expect(source?.searchUrlTemplate).toBeNull();
  });

  it("buildSearchUrl substitutes the URL-encoded query into the template", async () => {
    selectMock.mockReturnValueOnce(
      okResult([
        {
          domain: "outdoorsmagic.com",
          name: "Outdoors Magic",
          trust_weight: 0.75,
          category: "review",
          active: true,
          search_url_template: "https://outdoorsmagic.com/?s={query}&submit=",
        },
      ]),
    );
    await expect(
      buildSearchUrl("outdoorsmagic.com", "Rab Neutrino"),
    ).resolves.toBe("https://outdoorsmagic.com/?s=Rab%20Neutrino&submit=");
  });

  it("buildSearchUrl returns null when the matched source has no template", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    selectMock.mockReturnValueOnce(okResult([])); // fallback: outdoorgearlab has no template
    await expect(buildSearchUrl("outdoorgearlab.com", "tent")).resolves.toBeNull();
    warn.mockRestore();
  });

  it("buildSearchUrl returns null for an untrusted domain", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    selectMock.mockReturnValueOnce(okResult([]));
    await expect(buildSearchUrl("amazon.com", "tent")).resolves.toBeNull();
    warn.mockRestore();
  });
});
