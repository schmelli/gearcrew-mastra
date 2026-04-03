import { describe, it, expect } from "vitest";
import {
  extractSuccessorFromSnippets,
  detectVersionSignal,
} from "../src/workflows/successor-detection.js";

describe("detectVersionSignal", () => {
  it("detects year", () =>
    expect(detectVersionSignal("MSR WhisperLite 2024")).toBe("year"));
  it("detects V2", () =>
    expect(detectVersionSignal("Nemo Tensor V2")).toBe("version"));
  it("detects Gen 2", () =>
    expect(detectVersionSignal("Big Agnes Q-Core SLX Gen 2")).toBe("generation"));
  it("returns null for no signal", () =>
    expect(detectVersionSignal("Black Diamond Spot")).toBeNull());
  it("detects Roman II", () =>
    expect(detectVersionSignal("Exped DownMat II")).toBe("generation"));
  it("detects 2021 year", () =>
    expect(detectVersionSignal("Osprey Atmos AG 2021")).toBe("year"));
  it("detects v3 lowercase", () =>
    expect(detectVersionSignal("Sea to Summit Ether Lite v3")).toBe("version"));
  it("detects 3rd Gen", () =>
    expect(detectVersionSignal("Therm-a-Rest NeoAir XTherm 3rd Gen")).toBe("generation"));
  it("detects year 2031 (future-proof regex)", () =>
    expect(detectVersionSignal("MSR WhisperLite 2031")).toBe("year"));
});

describe("extractSuccessorFromSnippets", () => {
  it("detects 'replaces' pattern", () => {
    const snippets = ["The new Nemo Tensor V2 replaces the original Nemo Tensor"];
    expect(
      extractSuccessorFromSnippets(snippets, "Nemo Tensor V2", "Nemo Tensor"),
    ).toBe("1_supersedes_2");
  });

  it("detects 'discontinued' pattern", () => {
    const snippets = [
      "Nemo Tensor has been discontinued, replaced by Tensor V2",
    ];
    expect(
      extractSuccessorFromSnippets(snippets, "Nemo Tensor V2", "Nemo Tensor"),
    ).toBe("1_supersedes_2");
  });

  it("returns none on no signal", () => {
    expect(
      extractSuccessorFromSnippets(
        ["Great lightweight sleeping pad"],
        "Pad A",
        "Pad B",
      ),
    ).toBe("none");
  });

  it("detects 'successor' keyword", () => {
    const snippets = ["MSR WhisperLite 2024 is the successor to the WhisperLite Universal"];
    expect(
      extractSuccessorFromSnippets(
        snippets,
        "MSR WhisperLite 2024",
        "WhisperLite Universal",
      ),
    ).toBe("1_supersedes_2");
  });

  it("detects 'supersedes' keyword", () => {
    const snippets = ["Big Agnes Q-Core SLX Gen 2 supersedes the original Gen 1"];
    expect(
      extractSuccessorFromSnippets(
        snippets,
        "Big Agnes Q-Core SLX Gen 2",
        "Big Agnes Q-Core SLX",
      ),
    ).toBe("1_supersedes_2");
  });

  it("returns none when only unrelated keyword appears", () => {
    const snippets = ["Buy this next generation tent for your adventure"];
    expect(
      extractSuccessorFromSnippets(snippets, "Tent Alpha", "Tent Beta"),
    ).toBe("none");
  });

  it("handles empty snippets array", () => {
    expect(extractSuccessorFromSnippets([], "Product A", "Product B")).toBe("none");
  });

  // Important #6: test for "replaced by [name]" logic - named product after "replaced by" is NEWER
  it("correctly identifies newer product in 'replaced by X' pattern", () => {
    const snippets = ["It has been replaced by Nemo Tensor V2"];
    // "Nemo Tensor V2" is mentioned after "replaced by" -> V2 is NEWER
    expect(extractSuccessorFromSnippets(snippets, "Nemo Tensor V2", "Nemo Tensor"))
      .toBe("1_supersedes_2"); // name1 (V2) supersedes name2
  });

  it("correctly identifies older product in 'replaced by X' pattern when older is named", () => {
    const snippets = ["The Nemo Tensor has been replaced by its successor"];
    // "Nemo Tensor" appears before "replaced by" -> Tensor is the OLDER product
    expect(extractSuccessorFromSnippets(snippets, "Nemo Tensor V2", "Nemo Tensor"))
      .toBe("1_supersedes_2"); // name1 (V2) is the implied newer product
  });


  it("detects 'new version of' keyword with both names present", () => {
    const snippets = ["MSR WhisperLite 2024 is the new version of WhisperLite Universal"];
    expect(
      extractSuccessorFromSnippets(
        snippets,
        "MSR WhisperLite 2024",
        "WhisperLite Universal",
      ),
    ).toBe("1_supersedes_2");
  });
});
