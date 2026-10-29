/**
 * THE FILE FORMAT IS THE CONTRACT with wup-travel, whose `osm_import` step
 * reads `osm/<slug>.json` from this repository. The filter is run here, on a
 * small HAND-MADE `osmium export` (`tests/fixtures/export.geojsonseq`), and
 * what it writes must be exactly `tests/fixtures/contract-city.json` -- the
 * file wup-travel's own test parses (copied there as
 * `tests/fixtures/osm-city-file.json`). A change to the format fails here
 * first; regenerate with `bun scripts/cli.ts fixture` and copy it across.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "bun:test";

import { contractFixture, serialise } from "../scripts/lib.ts";

const exportText = readFileSync("tests/fixtures/export.geojsonseq", "utf8");
const committed = readFileSync("tests/fixtures/contract-city.json", "utf8");

describe("the format's fixture", () => {
  const file = contractFixture(exportText);

  it("is what the code writes now, byte for byte", () => {
    expect(serialise(file)).toBe(committed);
  });

  it("keeps the objects the filter names, and only the tags that matched", () => {
    expect(file.venues.map((venue) => `${venue.osm_type}/${venue.osm_id}`)).toEqual([
      "node/1001",
      "node/4004",
      "node/7007",
      "way/2002",
      "way/5005",
      "relation/6006",
    ]);
    const by = (id: number) => file.venues.find((venue) => venue.osm_id === id)!;
    // diet:vegan=no matched nothing; the bar is in dogs and LGBTQ+.
    expect(by(4004).tags).toEqual({ dog: "yes", lgbtq: "primary" });
    expect(by(4004).themes).toEqual(["dogs", "lgbtq"]);
    // A name is trimmed, a point rounded to six decimals, a month-only check date kept.
    expect(by(7007)).toMatchObject({
      name: "Café Lésbico",
      lat: 38.710123,
      lng: -9.130123,
      themes: ["lgbtq"],
      check_date: "2024-05",
    });
    // Every name:xx, a relation's point the middle of its box, no name is null.
    expect(by(5005).names).toEqual({ en: "Beach", pt: "Praia" });
    expect(by(6006)).toMatchObject({ name: null, category: "shop=bakery", themes: ["vegan"] });
    expect(by(6006).lat).toBeCloseTo(38.755, 6);
  });
});
