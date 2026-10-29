/**
 * The monthly OSM workflow's own logic -- the box, the filter,
 * an `osmium export` line read into a venue, the file, "only when it
 * changed", and the coverage report. The workflow itself runs on GitHub;
 * no test here reaches Geofabrik.
 *
 * HAND-MADE fixtures, marked as such: `osmium export -f geojsonseq
 * --add-unique-id=type_id` lines in the documented shape (RFC 8142's record
 * separator, `n`/`w`/`r` ids), with representative OSM ids and tags.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "bun:test";

import {
  bboxOf,
  changed,
  cityFile,
  coverageMarkdown,
  downloadFailure,
  parseDownloadLine,
  radiusOf,
  regionPlan,
  resolutionLine,
  resolveRegions,
  venuesFromGeojsonSeq,
  withResolvedRegions,
  type City,
  type DownloadRecord,
  readOwnFile,
} from "../scripts/lib.ts";
import { matchFilter, osmiumExpressions } from "../src/venues.ts";

const LISBON: City = {
  slug: "lisbon",
  name: "Lisbon",
  country_code: "PT",
  lat: 38.7167,
  lng: -9.1333,
};
const RS = "\u001e";
const line = (feature: unknown) => `${RS}${JSON.stringify(feature)}`;
const EXPORT = [
  line({
    type: "Feature",
    id: "n1001",
    geometry: { type: "Point", coordinates: [-9.14, 38.71] },
    properties: {
      name: "Ao 26 Vegan Food Project",
      "name:en": "Ao 26",
      amenity: "restaurant",
      "diet:vegan": "only",
      check_date: "2025-03-01",
      "check_date:diet:vegan": "2025-09-12",
    },
  }),
  line({
    type: "Feature",
    id: "w2002",
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [-9.16, 38.73],
          [-9.15, 38.73],
          [-9.15, 38.74],
          [-9.16, 38.74],
          [-9.16, 38.73],
        ],
      ],
    },
    properties: { leisure: "dog_park", name: "Parque canino" },
  }),
  // A way's gate, exported beside it: its own tags match nothing.
  line({
    type: "Feature",
    id: "n3003",
    geometry: { type: "Point", coordinates: [-9.155, 38.73] },
    properties: { barrier: "gate" },
  }),
  line({
    type: "Feature",
    id: "n4004",
    geometry: { type: "Point", coordinates: [-9.142, 38.713] },
    properties: { amenity: "bar", lgbtq: "primary", dog: "yes", "diet:vegan": "no" },
  }),
  line({
    type: "Feature",
    id: "w5005",
    geometry: {
      type: "LineString",
      coordinates: [
        [-9.3, 38.69],
        [-9.29, 38.7],
      ],
    },
    properties: { natural: "beach", "dog:conditional": "no @ (Jun 01-Sep 30)" },
  }),
].join("\n");

describe("the filter", () => {
  it("is the brief's, as osmium expressions", () => {
    expect(osmiumExpressions()).toEqual([
      "nwr/diet:vegan=only,yes",
      "nwr/dog=yes,leashed,unleashed",
      "nwr/dog:conditional",
      "nwr/leisure=dog_park",
      "nwr/lgbtq=primary,welcome,only",
    ]);
    // diet:vegan=no and lgbtq=no match nothing.
    expect(matchFilter({ "diet:vegan": "no", lgbtq: "no" }).themes).toEqual([]);
  });
});

describe("one city's file", () => {
  const venues = venuesFromGeojsonSeq(EXPORT);

  it("reads every matching object, with its point, names, matched tags and check date", () => {
    expect(venues.map((venue) => `${venue.osm_type}/${venue.osm_id}`)).toEqual([
      "node/1001",
      "node/4004",
      "way/2002",
      "way/5005",
    ]);
    expect(venues[0]).toEqual({
      osm_type: "node",
      osm_id: 1001,
      name: "Ao 26 Vegan Food Project",
      names: { en: "Ao 26" },
      lat: 38.71,
      lng: -9.14,
      tags: { "diet:vegan": "only" },
      themes: ["vegan"],
      category: "amenity=restaurant",
      check_date: "2025-09-12",
    });
    // A bar that is LGBTQ+ and allows dogs is in both, and its vegan=no is not a tag that matched.
    expect(venues[1]).toMatchObject({
      themes: ["dogs", "lgbtq"],
      tags: { dog: "yes", lgbtq: "primary" },
    });
    // A polygon's point is the middle of its box; a beach's seasonal rule is kept as mapped.
    expect(venues[2]).toMatchObject({ lat: 38.735, lng: -9.155, name: "Parque canino" });
    expect(venues[3]!.tags).toEqual({ "dog:conditional": "no @ (Jun 01-Sep 30)" });
  });

  it("is written only when its content changed -- never for the extract's date alone", () => {
    const radius = radiusOf({ radius_km: 10, radius_km_by_city: { london: 18 } }, "lisbon");
    const first = cityFile({
      city: LISBON,
      region: "europe/portugal",
      timestamp: "2026-11-02T20:21:02Z",
      radiusKm: radius,
      venues,
    });
    const nextMonth = { ...first, extract_timestamp: "2026-12-02T20:21:02Z" };
    expect(changed(null, first)).toBe(true);
    expect(changed(first, nextMonth)).toBe(false);
    expect(changed(first, { ...nextMonth, venues: nextMonth.venues.slice(1) })).toBe(true);
    // What the workflow reads back of its own file is what it wrote. (The
    // format's real parser is wup-travel's; tests/contract.test.ts.)
    expect(readOwnFile(JSON.parse(JSON.stringify(first)))).toEqual(first);
    expect(readOwnFile({ ...first, version: 2 })).toBeNull();
    expect(readOwnFile("<html>404</html>")).toBeNull();
  });

  it("cuts a box of the radius on each side of the city's point", () => {
    const [minLng, minLat, maxLng, maxLat] = bboxOf(LISBON, 10);
    expect(maxLat - minLat).toBeCloseTo(20 / 111.32, 4);
    // Longitude degrees shrink with the latitude: wider in degrees than tall.
    expect(maxLng - minLng).toBeGreaterThan(maxLat - minLat);
    expect(radiusOf({ radius_km: 10, radius_km_by_city: { london: 18 } }, "london")).toBe(18);
  });
});

describe("the regions", () => {
  const regions = (
    JSON.parse(readFileSync("data/regions.json", "utf8")) as { regions: Record<string, string> }
  ).regions;
  const cities = (JSON.parse(readFileSync("data/cities.json", "utf8")) as { cities: City[] })
    .cities;

  it("give every one of the 57 cities a region, one download a region", () => {
    expect(cities).toHaveLength(57);
    expect(Object.keys(regions).sort()).toEqual(cities.map((city) => city.slug).sort());
    const plan = regionPlan(regions);
    expect(plan.find((each) => each.region === "europe/italy/centro")!.cities).toEqual([
      "florence",
      "rome",
    ]);
    // US cities by state, not by the country.
    expect(regions["memphis"]).toBe("north-america/us/tennessee");
    expect(Object.values(regions)).not.toContain("north-america/us");
  });

  // HAND-MADE index, marked: features in the shape of Geofabrik's
  // index-v1-nogeom.json (properties id, parent, name, urls.pbf). The paths
  // are invented to test the rule; which paths Geofabrik really uses for
  // Greater London and Scotland is read by the workflow, never written here.
  const feature = (id: string, name: string, parent: string | null, path: string) => ({
    type: "Feature",
    properties: {
      id,
      name,
      ...(parent ? { parent } : {}),
      urls: { pbf: `https://download.geofabrik.de/${path}-latest.osm.pbf` },
    },
  });
  const INDEX = {
    type: "FeatureCollection",
    features: [
      feature("portugal", "Portugal", "europe", "europe/portugal"),
      feature("isles", "Isles", "europe", "europe/isles"),
      feature("isles-england", "England", "isles", "europe/isles/england"),
      feature(
        "greater-london",
        "Greater London",
        "isles-england",
        "europe/isles/england/greater-london",
      ),
      feature("isles-scotland", "Scotland", "isles", "europe/isles/scotland"),
      feature("georgia", "Georgia", "europe", "europe/georgia"),
      feature("us/georgia", "Georgia", "us", "north-america/us/georgia"),
      feature("poland", "Poland", "europe", "europe/poland"),
      feature("mazowieckie", "Mazowieckie", "poland", "europe/poland/mazowieckie"),
      feature("pomorskie", "Pomorskie", "poland", "europe/poland/pomorskie"),
    ],
  };

  it("find a path the index holds; find one it holds elsewhere BY NAME, and write the index's", () => {
    const resolutions = resolveRegions(INDEX, [
      "europe/portugal",
      "europe/great-britain/england/greater-london",
      "europe/great-britain/scotland",
    ]);
    expect(resolutions).toEqual([
      { region: "europe/portugal", status: "found" },
      {
        region: "europe/great-britain/england/greater-london",
        status: "resolved",
        to: "europe/isles/england/greater-london",
        name: "Greater London",
      },
      {
        region: "europe/great-britain/scotland",
        status: "resolved",
        to: "europe/isles/scotland",
        name: "Scotland",
      },
    ]);
    expect(
      withResolvedRegions(
        { lisbon: "europe/portugal", london: "europe/great-britain/england/greater-london" },
        resolutions,
      ),
    ).toEqual({ lisbon: "europe/portugal", london: "europe/isles/england/greater-london" });
    expect(resolutionLine(resolutions[1]!)).toBe(
      "europe/great-britain/england/greater-london is not in Geofabrik's index; the region named " +
        '"Greater London" is europe/isles/england/greater-london, written to data/regions.json',
    );
    expect(resolutionLine(resolutions[0]!)).toBeNull();
  });

  it("tell two regions of one name apart by the old path, and never guess a tie", () => {
    const [state, tie] = resolveRegions(INDEX, ["north-america/usa/georgia", "asia/georgia"]);
    expect(state).toMatchObject({ status: "resolved", to: "north-america/us/georgia" });
    expect(tie).toEqual({
      region: "asia/georgia",
      status: "unknown",
      nearest: ["europe/georgia", "north-america/us/georgia"],
    });
  });

  it("name the nearest regions the index has when none has the name", () => {
    const [shared, children, none] = resolveRegions(INDEX, [
      "europe/greater-manchester",
      "europe/poland/malopolskie",
      "asia/atlantis",
    ]);
    expect(shared).toEqual({
      region: "europe/greater-manchester",
      status: "unknown",
      nearest: ["europe/isles/england/greater-london"],
    });
    expect(children).toEqual({
      region: "europe/poland/malopolskie",
      status: "unknown",
      nearest: ["europe/poland/mazowieckie", "europe/poland/pomorskie"],
    });
    expect(resolutionLine(none!)).toBe(
      "Geofabrik's index has no asia/atlantis; and nothing near it",
    );
    expect(resolutionLine(children!)).toBe(
      "Geofabrik's index has no europe/poland/malopolskie; the nearest it has: " +
        "europe/poland/mazowieckie, europe/poland/pomorskie",
    );
  });
});

describe("a download", () => {
  // HAND-MADE downloads.tsv lines, marked: the fields extract.sh writes.
  const record = (fields: Partial<DownloadRecord>): DownloadRecord => ({
    region: "europe/malta",
    curlExit: 0,
    curlError: "",
    status: "200",
    contentType: "application/octet-stream",
    bytes: 5_812_345,
    redirects: 0,
    fileinfo: "ok",
    head: "OSMHeader",
    seconds: 3,
    ...fields,
  });

  it("is read back from its line", () => {
    expect(
      parseDownloadLine(
        "europe/malta\t0\t\t200\ttext/html; charset=utf-8\t4123\t1\tUnknown file format\t<!DOCTYPE html>\t1",
      ),
    ).toEqual(
      record({
        contentType: "text/html; charset=utf-8",
        bytes: 4123,
        redirects: 1,
        fileinfo: "Unknown file format",
        head: "<!DOCTYPE html>",
        seconds: 1,
      }),
    );
    expect(parseDownloadLine("")).toBeNull();
  });

  it("that osmium reads is a PBF; anything else fails its REGION and says what came back", () => {
    expect(downloadFailure(record({}))).toBeNull();
    expect(
      downloadFailure(
        record({
          contentType: "text/html",
          bytes: 4123,
          fileinfo: "PBF error: invalid BlobHeader size",
          head: "<!DOCTYPE html><html><title>Too many requests</title>",
        }),
      ),
    ).toBe(
      "the download of europe/malta was not a PBF: 200 text/html 4123 bytes, first 200 bytes: " +
        "<!DOCTYPE html><html><title>Too many requests</title>; osmium fileinfo: PBF error: " +
        "invalid BlobHeader size",
    );
    expect(
      downloadFailure(
        record({ status: "403", contentType: "", bytes: 0, fileinfo: "no file", head: "" }),
      ),
    ).toBe(
      "the download of europe/malta was not a PBF: 403 (no Content-Type) 0 bytes, first 200 bytes: " +
        "(none); osmium fileinfo: no file",
    );
    expect(
      downloadFailure(
        record({
          curlExit: 28,
          curlError: "curl: (28) Operation timed out",
          status: "000",
          bytes: 0,
        }),
      ),
    ).toBe(
      "the download of europe/malta failed: curl exit 28 (curl: (28) Operation timed out), HTTP 000, 0 bytes",
    );
  });
});

describe("the coverage report", () => {
  it("counts each tag value per city, and says which cities were not read", () => {
    const file = cityFile({
      city: LISBON,
      region: "europe/portugal",
      timestamp: "2026-11-02T20:21:02Z",
      radiusKm: 10,
      venues: venuesFromGeojsonSeq(EXPORT),
    });
    const markdown = coverageMarkdown({
      generatedAt: "2026-11-03 04:40 UTC",
      cities: [LISBON, { ...LISBON, slug: "porto" }],
      regions: { lisbon: "europe/portugal", porto: "europe/portugal" },
      files: new Map([["lisbon", file]]),
      failures: new Map([["porto", "the download of europe/portugal failed"]]),
      runSeconds: 1500,
      regionLines: ["Geofabrik's index has no europe/atlantis; and nothing near it"],
      downloads: [
        {
          region: "europe/portugal",
          curlExit: 0,
          curlError: "",
          status: "200",
          contentType: "text/html",
          bytes: 512,
          redirects: 1,
          fileinfo: "Unknown file format",
          head: "<p>a | b</p>",
          seconds: 2,
        },
      ],
    });
    expect(markdown).toContain("in 25 min");
    expect(markdown).toContain(
      "| lisbon | europe/portugal | 2026-11-02 | 4 | 1 | 0 | 1 | 0 | 0 | 1 | 1 | 1 | 0 | 0 |",
    );
    expect(markdown).toContain(
      "| porto | europe/portugal | NOT READ: the download of europe/portugal failed |",
    );
    expect(markdown).toContain(
      "By theme (a venue may be in more than one): vegan 1, dogs 3, lgbtq 1.",
    );
    expect(markdown).toContain("© OpenStreetMap contributors");
    expect(markdown).toContain("- Geofabrik's index has no europe/atlantis; and nothing near it");
    // A pipe in what came back does not end the cell.
    expect(markdown).toContain(
      "| europe/portugal | 200 | text/html | 512 | 1 | NO: the download of europe/portugal was not a " +
        "PBF: 200 text/html 512 bytes, first 200 bytes: <p>a \\| b</p>; osmium fileinfo: Unknown " +
        "file format | 2 |",
    );
  });
});
