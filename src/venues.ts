/**
 * OPENSTREETMAP VENUES FOR WUP TRAVEL'S THEMED PAGES -- the filter, and the
 * file a city gets. Moved here from wup-travel's `src/lib/osm/venues.ts`
 * (wup-travel B44f item 1).
 *
 * THE FILTER LIVES HERE ONLY. "Which tags count" is decided in this file and
 * nowhere else. wup-travel keeps only the PARSER of the file format
 * (`parseOsmCityFile`, `venueKey`, the `OsmVenue` type) and reads
 * `osm/<slug>.json` from this repository; the format is the contract
 * between the two, held by `tests/fixtures/contract-city.json` (README.md,
 * "The file format").
 *
 * ODbL. The files ARE WUP Travel's release of the derivative database,
 * published in this public repository with the method that rebuilds it
 * (README.md, LICENSE-DATA).
 *
 * Dependency-free: the Action runs this under Bun with no install.
 */

/** The three themes a venue may belong to. */
export const OSM_THEMES = ["vegan", "dogs", "lgbtq"] as const;
export type OsmTheme = (typeof OSM_THEMES)[number];

/**
 * THE FILTER, as the brief gives it. A key with a value list matches those
 * values; a key with `null` matches any value (`dog:conditional`, whose value
 * is a rule such as `no @ (Jun-Sep)`).
 */
export const OSM_FILTER: Readonly<
  Record<OsmTheme, readonly (readonly [string, readonly string[] | null])[]>
> = {
  vegan: [["diet:vegan", ["only", "yes"]]],
  dogs: [
    ["dog", ["yes", "leashed", "unleashed"]],
    ["dog:conditional", null],
    ["leisure", ["dog_park"]],
  ],
  lgbtq: [["lgbtq", ["primary", "welcome", "only"]]],
};

/** The same filter as `osmium tags-filter` expressions, one per key. */
export function osmiumExpressions(): string[] {
  return OSM_THEMES.flatMap((theme) =>
    OSM_FILTER[theme].map(([key, values]) =>
      values ? `nwr/${key}=${values.join(",")}` : `nwr/${key}`,
    ),
  );
}

/** The keys whose values say what kind of place it is: the venue's `category`. */
export const CATEGORY_KEYS = [
  "amenity",
  "shop",
  "leisure",
  "tourism",
  "craft",
  "club",
  "natural",
] as const;

/** The date tags a mapper sets when they checked a venue: `check_date`, `check_date:diet:vegan`. */
const CHECK_DATE = /^check_date(?::|$)/;
const ISO_DATE = /^\d{4}-\d{2}(?:-\d{2})?$/;

export type OsmVenue = {
  osm_type: "node" | "way" | "relation";
  osm_id: number;
  /** `name`, or null: a venue with no name is kept and listed as unnamed. */
  name: string | null;
  /** `name:xx` for every language the venue carries. */
  names: Record<string, string>;
  lat: number;
  lng: number;
  /** The tags that matched the filter, exactly as mapped. */
  tags: Record<string, string>;
  /** Which themes those tags put it in. */
  themes: OsmTheme[];
  /** What kind of place it is (`amenity=restaurant`), or null. */
  category: string | null;
  /** The latest `check_date*` the venue carries, or null. */
  check_date: string | null;
};

export type OsmCityFile = {
  version: 1;
  city: string;
  country: string;
  /** The Geofabrik extract's path it was cut from (`europe/portugal`). */
  region: string;
  /** The extract's own replication timestamp, ISO. */
  extract_timestamp: string;
  radius_km: number;
  bbox: [number, number, number, number];
  venues: OsmVenue[];
};

/** The tags of a venue that match the filter, and the themes they make. */
export function matchFilter(tags: Readonly<Record<string, string>>): {
  tags: Record<string, string>;
  themes: OsmTheme[];
} {
  const matched: Record<string, string> = {};
  const themes: OsmTheme[] = [];
  for (const theme of OSM_THEMES) {
    let hit = false;
    for (const [key, values] of OSM_FILTER[theme]) {
      const value = tags[key];
      if (value === undefined) continue;
      if (values === null || values.includes(value)) {
        matched[key] = value;
        hit = true;
      }
    }
    if (hit) themes.push(theme);
  }
  return { tags: matched, themes };
}

/** A venue from its tags, type, id and point; null when nothing matches. Pure. */
export function venueFrom(input: {
  type: OsmVenue["osm_type"];
  id: number;
  lat: number;
  lng: number;
  tags: Readonly<Record<string, string>>;
}): OsmVenue | null {
  const { tags } = input;
  const match = matchFilter(tags);
  if (match.themes.length === 0) return null;
  if (!Number.isFinite(input.lat) || !Number.isFinite(input.lng)) return null;
  const names: Record<string, string> = {};
  for (const [key, value] of Object.entries(tags)) {
    const lang = /^name:([a-z]{2,3})$/.exec(key)?.[1];
    if (lang && value.trim() !== "") names[lang] = value.trim();
  }
  const dates = Object.entries(tags)
    .filter(([key, value]) => CHECK_DATE.test(key) && ISO_DATE.test(value))
    .map(([, value]) => value)
    .sort();
  const categoryKey = CATEGORY_KEYS.find((key) => typeof tags[key] === "string");
  return {
    osm_type: input.type,
    osm_id: input.id,
    name: tags["name"]?.trim() || null,
    names,
    lat: Math.round(input.lat * 1e6) / 1e6,
    lng: Math.round(input.lng * 1e6) / 1e6,
    tags: match.tags,
    themes: match.themes,
    category: categoryKey ? `${categoryKey}=${tags[categoryKey]}` : null,
    check_date: dates[dates.length - 1] ?? null,
  };
}

/** A venue's key across files and tables: `node/123`. */
export function venueKey(venue: Pick<OsmVenue, "osm_type" | "osm_id">): string {
  return `${venue.osm_type}/${venue.osm_id}`;
}

/** Venues in one stable order, so a file that did not change reads byte for byte the same. */
export function sortVenues(venues: readonly OsmVenue[]): OsmVenue[] {
  const rank = { node: 0, way: 1, relation: 2 } as const;
  return [...venues].sort((a, b) => rank[a.osm_type] - rank[b.osm_type] || a.osm_id - b.osm_id);
}

/** Per theme and tag value, how many venues a file holds: the coverage report's numbers. */
export function venueCounts(venues: readonly OsmVenue[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const venue of venues) {
    for (const [key, value] of Object.entries(venue.tags)) {
      const label = key === "dog:conditional" ? key : `${key}=${value}`;
      counts[label] = (counts[label] ?? 0) + 1;
    }
  }
  return counts;
}
