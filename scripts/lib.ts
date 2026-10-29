/**
 * What the monthly OSM workflow does between `osmium` and git -- pure
 * functions, tested in `tests/extracts.test.ts`. The workflow is
 * `.github/workflows/osm-extracts.yml`; the command line is `./cli.ts`.
 *
 * No dependencies: the Action runs this under Bun with no install, from a
 * fresh checkout.
 */
import {
  sortVenues,
  venueCounts,
  venueFrom,
  venueKey,
  OSM_THEMES,
  type OsmCityFile,
  type OsmVenue,
} from "../src/venues.ts";

export type City = {
  slug: string;
  name: string;
  country_code: string;
  lat: number;
  lng: number;
};

export type OsmConfig = { radius_km: number; radius_km_by_city: Record<string, number> };

/** The file every path below is relative to. */
export const GEOFABRIK = "https://download.geofabrik.de/";

/** The extract's download address for a region path. */
export function extractUrl(region: string): string {
  return `${GEOFABRIK}${region}-latest.osm.pbf`;
}

/** A city's radius: its own, else the default. */
export function radiusOf(config: OsmConfig, slug: string): number {
  const own = config.radius_km_by_city[slug];
  return typeof own === "number" && own > 0 ? own : config.radius_km;
}

/**
 * The box around a city's point, `radiusKm` on each side, as `osmium extract
 * -b` takes it: `minlon,minlat,maxlon,maxlat`, to five decimals (about a
 * metre).
 */
export function bboxOf(
  city: Pick<City, "lat" | "lng">,
  radiusKm: number,
): [number, number, number, number] {
  const dLat = radiusKm / 111.32;
  const dLng = radiusKm / (111.32 * Math.cos((city.lat * Math.PI) / 180));
  const round = (value: number) => Math.round(value * 1e5) / 1e5;
  return [
    round(city.lng - dLng),
    round(city.lat - dLat),
    round(city.lng + dLng),
    round(city.lat + dLat),
  ];
}

/** Regions in a stable order, each with its cities: one download each. */
export function regionPlan(
  regions: Record<string, string>,
): { region: string; cities: string[] }[] {
  const out = new Map<string, string[]>();
  for (const [slug, region] of Object.entries(regions).sort(([a], [b]) => a.localeCompare(b))) {
    out.set(region, [...(out.get(region) ?? []), slug]);
  }
  return [...out.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([region, cities]) => ({ region, cities }));
}

/** One region of Geofabrik's index: its id, name, parent and download path. */
export type IndexRegion = { id: string; name: string; parent: string | null; path: string };

/**
 * The regions Geofabrik's index (`index-v1-nogeom.json`) offers: each
 * feature's `id`, `name` and `parent`, and its path -- the `.pbf` URL less
 * `GEOFABRIK` and `-latest.osm.pbf`. A feature without such a URL is not a
 * download and is left out.
 */
export function indexRegions(index: unknown): IndexRegion[] {
  const features =
    typeof index === "object" && index !== null
      ? (index as { features?: unknown }).features
      : undefined;
  const out: IndexRegion[] = [];
  if (!Array.isArray(features)) return out;
  const suffix = "-latest.osm.pbf";
  for (const feature of features) {
    const properties = (feature as { properties?: Record<string, unknown> } | null)?.properties;
    const urls = properties?.["urls"] as { pbf?: unknown } | undefined;
    const pbf = urls?.pbf;
    if (typeof pbf !== "string" || !pbf.startsWith(GEOFABRIK) || !pbf.endsWith(suffix)) continue;
    const text = (value: unknown) => (typeof value === "string" ? value : "");
    out.push({
      id: text(properties?.["id"]),
      name: text(properties?.["name"]),
      parent: text(properties?.["parent"]) || null,
      path: pbf.slice(GEOFABRIK.length, -suffix.length),
    });
  }
  return out;
}

/** A name or a path segment as one key: lower case, ASCII, words joined by "-". */
export function regionKey(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** What the index says of one region path in `data/regions.json`. */
export type RegionResolution =
  | { region: string; status: "found" }
  /** Not at that path, but one region of the index has its name: the path it has now. */
  | { region: string; status: "resolved"; to: string; name: string }
  /** No region of the index has its name, or more than one does: the nearest the index has. */
  | { region: string; status: "unknown"; nearest: string[] };

/** How many of the nearest paths an unknown region names. */
export const NEAREST_REGIONS = 5;

/**
 * Every region path checked against Geofabrik's index (B44b item 1c). A path
 * the index holds is found. One it does not is looked for BY NAME: the
 * region whose `id`, or whose `name` as a key, is the path's last segment --
 * `europe/great-britain/england/greater-london` is the region named "Greater
 * London", wherever the index now files it. Two such regions (a US state and
 * a country called Georgia) are told apart by how much of the old path each
 * shares; a tie is not guessed. A name the index lacks names the nearest it
 * has: regions sharing a word with the name, else the children of the
 * path's deepest ancestor the index holds.
 */
export function resolveRegions(index: unknown, regions: readonly string[]): RegionResolution[] {
  const offered = indexRegions(index);
  const paths = new Set(offered.map((each) => each.path));
  return regions.map((region): RegionResolution => {
    if (paths.has(region)) return { region, status: "found" };
    const segments = region.split("/");
    const leaf = regionKey(segments[segments.length - 1] ?? "");
    const named = offered.filter(
      (each) => leaf !== "" && (each.id === leaf || regionKey(each.name) === leaf),
    );
    const shared = (path: string) => {
      const own = new Set(path.split("/"));
      return segments.slice(0, -1).filter((segment) => own.has(segment)).length;
    };
    if (named.length > 0) {
      const best = Math.max(...named.map((each) => shared(each.path)));
      const top = named.filter((each) => shared(each.path) === best);
      if (top.length === 1) {
        const [only] = top as [IndexRegion];
        return { region, status: "resolved", to: only.path, name: only.name || only.id };
      }
      return { region, status: "unknown", nearest: top.map((each) => each.path).sort() };
    }
    const words = new Set(leaf.split("-").filter((word) => word.length > 2));
    const scored = offered
      .map((each) => {
        const own = new Set([...each.id.split("-"), ...regionKey(each.name).split("-")]);
        const common = [...words].filter((word) => own.has(word)).length;
        return { path: each.path, score: common * 2 + (shared(each.path) > 0 ? 1 : 0), common };
      })
      .filter((each) => each.common > 0)
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    if (scored.length > 0) {
      return {
        region,
        status: "unknown",
        nearest: scored.slice(0, NEAREST_REGIONS).map((each) => each.path),
      };
    }
    for (let depth = segments.length - 1; depth > 0; depth -= 1) {
      const ancestor = segments.slice(0, depth).join("/");
      const children = offered
        .filter((each) => each.path.startsWith(`${ancestor}/`))
        .map((each) => each.path)
        .sort();
      if (children.length > 0) {
        return { region, status: "unknown", nearest: children.slice(0, NEAREST_REGIONS) };
      }
    }
    return { region, status: "unknown", nearest: [] };
  });
}

/** The regions file with every resolved path replaced by the index's. Pure. */
export function withResolvedRegions(
  regions: Record<string, string>,
  resolutions: readonly RegionResolution[],
): Record<string, string> {
  const to = new Map<string, string>();
  for (const each of resolutions) if (each.status === "resolved") to.set(each.region, each.to);
  return Object.fromEntries(
    Object.entries(regions).map(([slug, region]) => [slug, to.get(region) ?? region]),
  );
}

/** One line of the report (and of the run's annotations) per region the index did not hold as written. */
export function resolutionLine(resolution: RegionResolution): string | null {
  if (resolution.status === "resolved") {
    return (
      `${resolution.region} is not in Geofabrik's index; the region named "${resolution.name}" ` +
      `is ${resolution.to}, written to data/regions.json`
    );
  }
  if (resolution.status === "unknown") {
    return (
      `Geofabrik's index has no ${resolution.region}` +
      (resolution.nearest.length > 0
        ? `; the nearest it has: ${resolution.nearest.join(", ")}`
        : "; and nothing near it")
    );
  }
  return null;
}

/**
 * One download as the workflow recorded it (B44b item 1a), a line of
 * `downloads.tsv`: what curl said, what came back, and whether `osmium
 * fileinfo` reads it.
 */
export type DownloadRecord = {
  region: string;
  /** curl's exit code: 0 when the transfer itself finished. */
  curlExit: number;
  /** curl's own error, its first line, or "". */
  curlError: string;
  /** The final response's status, "000" when there was none. */
  status: string;
  contentType: string;
  bytes: number;
  redirects: number;
  /** "ok", or `osmium fileinfo`'s error, its first line. */
  fileinfo: string;
  /** The body's first 200 bytes, printable ASCII only. */
  head: string;
  seconds: number;
};

/** The fields of a `downloads.tsv` line, in order. */
const DOWNLOAD_FIELDS = [
  "region",
  "curlExit",
  "curlError",
  "status",
  "contentType",
  "bytes",
  "redirects",
  "fileinfo",
  "head",
  "seconds",
] as const;

/** A `downloads.tsv` line read back; null for a blank or short line. */
export function parseDownloadLine(line: string): DownloadRecord | null {
  const parts = line.split("\t");
  if (parts.length < DOWNLOAD_FIELDS.length || !parts[0]) return null;
  const field = (name: (typeof DOWNLOAD_FIELDS)[number]) => parts[DOWNLOAD_FIELDS.indexOf(name)]!;
  const number = (value: string) => (/^\d+$/.test(value.trim()) ? Number(value.trim()) : 0);
  return {
    region: field("region"),
    curlExit: number(field("curlExit")),
    curlError: field("curlError"),
    status: field("status").trim() || "000",
    contentType: field("contentType"),
    bytes: number(field("bytes")),
    redirects: number(field("redirects")),
    fileinfo: field("fileinfo"),
    head: field("head"),
    seconds: number(field("seconds")),
  };
}

/**
 * Why a download cannot be cut, or null when it is a PBF: a 200 that
 * `osmium fileinfo` reads. Anything else is a REGION failure, never an
 * osmium one -- an HTML page, a block notice, a redirect's body -- and says
 * what came back.
 */
export function downloadFailure(record: DownloadRecord): string | null {
  if (record.curlExit !== 0) {
    return (
      `the download of ${record.region} failed: curl exit ${record.curlExit}` +
      (record.curlError ? ` (${record.curlError})` : "") +
      `, HTTP ${record.status}, ${record.bytes} bytes`
    );
  }
  if (record.status === "200" && record.fileinfo === "ok") return null;
  return (
    `the download of ${record.region} was not a PBF: ${record.status} ` +
    `${record.contentType || "(no Content-Type)"} ${record.bytes} bytes, ` +
    `first 200 bytes: ${record.head.trim() || "(none)"}` +
    (record.fileinfo !== "ok" ? `; osmium fileinfo: ${record.fileinfo || "(no message)"}` : "")
  );
}

/** Text for one Markdown table cell: no pipe ends the cell early. */
export function cell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

/** One point for a geometry: a point is itself; anything else, the middle of its box. */
export function pointOf(geometry: unknown): { lat: number; lng: number } | null {
  const coords: [number, number][] = [];
  const walk = (value: unknown) => {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number") {
      coords.push([value[0], value[1]]);
      return;
    }
    for (const each of value) walk(each);
  };
  walk((geometry as { coordinates?: unknown } | null)?.coordinates);
  if (coords.length === 0) return null;
  const lngs = coords.map(([lng]) => lng);
  const lats = coords.map(([, lat]) => lat);
  return {
    lng: (Math.min(...lngs) + Math.max(...lngs)) / 2,
    lat: (Math.min(...lats) + Math.max(...lats)) / 2,
  };
}

const TYPES = { n: "node", w: "way", r: "relation", a: "way" } as const;

/** RFC 8142's record separator, which may start each GeoJSON text sequence line. */
const RECORD_SEPARATOR = String.fromCharCode(0x1e);

/**
 * The venues of an `osmium export -f geojsonseq --add-unique-id=type_id`
 * file: one GeoJSON feature a line (RFC 8142 may prefix each with a record
 * separator). A feature whose tags match nothing -- a way's gate exported
 * beside it -- is not a venue. One a type and id, the first kept.
 */
export function venuesFromGeojsonSeq(text: string): OsmVenue[] {
  const venues = new Map<string, OsmVenue>();
  for (const raw of text.split("\n")) {
    const line = (raw.startsWith(RECORD_SEPARATOR) ? raw.slice(1) : raw).trim();
    if (line === "") continue;
    const feature = JSON.parse(line) as {
      id?: unknown;
      properties?: Record<string, unknown>;
      geometry?: unknown;
    };
    const id = typeof feature.id === "string" ? /^([nwra])(\d+)$/.exec(feature.id) : null;
    if (!id) continue;
    const point = pointOf(feature.geometry);
    if (!point) continue;
    const tags: Record<string, string> = {};
    for (const [key, value] of Object.entries(feature.properties ?? {})) {
      if (typeof value === "string") tags[key] = value;
    }
    const venue = venueFrom({
      type: TYPES[id[1] as keyof typeof TYPES],
      id: Number(id[2]),
      lat: point.lat,
      lng: point.lng,
      tags,
    });
    if (venue && !venues.has(venueKey(venue))) venues.set(venueKey(venue), venue);
  }
  return sortVenues([...venues.values()]);
}

/** A city's file, its venues in their stable order. */
export function cityFile(input: {
  city: City;
  region: string;
  timestamp: string;
  radiusKm: number;
  venues: readonly OsmVenue[];
}): OsmCityFile {
  return {
    version: 1,
    city: input.city.slug,
    country: input.city.country_code,
    region: input.region,
    extract_timestamp: input.timestamp,
    radius_km: input.radiusKm,
    bbox: bboxOf(input.city, input.radiusKm),
    venues: sortVenues(input.venues),
  };
}

/**
 * Whether a new file says anything the old one does not. The extract's
 * timestamp alone is not a change: a month in which nothing moved writes no
 * file and makes no commit. A changed region, radius or venue is.
 */
export function changed(previous: OsmCityFile | null, next: OsmCityFile): boolean {
  if (!previous) return true;
  const strip = ({ extract_timestamp: _, ...rest }: OsmCityFile) => rest;
  return JSON.stringify(strip(previous)) !== JSON.stringify(strip(next));
}

/**
 * One of OUR OWN files read back, for `changed` and the coverage report, or
 * null when it is not there or not version 1 (then it is simply written
 * again). This is not the format's parser: that is wup-travel's
 * `parseOsmCityFile`, the consumer's, which checks every venue. Here the
 * producer reads what it wrote itself.
 */
export function readOwnFile(value: unknown): OsmCityFile | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const file = value as Partial<OsmCityFile>;
  if (file.version !== 1 || typeof file.city !== "string" || !Array.isArray(file.venues))
    return null;
  return file as OsmCityFile;
}

/** The file as written: two-space JSON and a final newline. */
export function serialise(file: OsmCityFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

/**
 * THE FORMAT'S FIXTURE (`bun scripts/cli.ts fixture`): a hand-made `osmium
 * export` (`tests/fixtures/export.geojsonseq`) run through the same code a
 * real city goes through, for a city in the documented shape. The result,
 * `tests/fixtures/contract-city.json`, is copied byte for byte into
 * wup-travel's `tests/fixtures/osm-city-file.json`, whose test parses it --
 * so a change to the format here that wup-travel cannot read fails there,
 * and `tests/contract.test.ts` fails here until the fixture is regenerated.
 */
export const CONTRACT_CITY: City = {
  slug: "lisbon",
  name: "Lisbon",
  country_code: "PT",
  lat: 38.7167,
  lng: -9.1333,
};

export function contractFixture(exportText: string): OsmCityFile {
  return cityFile({
    city: CONTRACT_CITY,
    region: "europe/portugal",
    timestamp: "2026-10-27T20:21:02Z",
    radiusKm: 10,
    venues: venuesFromGeojsonSeq(exportText),
  });
}

/** The coverage report: per city, the venues per tag value, and what was not read. */
export function coverageMarkdown(input: {
  generatedAt: string;
  cities: readonly City[];
  regions: Record<string, string>;
  files: ReadonlyMap<string, OsmCityFile>;
  /** Why a city has no fresh file this run, by slug. */
  failures: ReadonlyMap<string, string>;
  runSeconds: number | null;
  /** The regions the index did not hold as written (`resolutionLine`). */
  regionLines?: readonly string[];
  /** Every download this run made, in order (B44b item 1a). */
  downloads?: readonly DownloadRecord[];
}): string {
  const columns = [
    "diet:vegan=only",
    "diet:vegan=yes",
    "dog=yes",
    "dog=leashed",
    "dog=unleashed",
    "dog:conditional",
    "leisure=dog_park",
    "lgbtq=primary",
    "lgbtq=welcome",
    "lgbtq=only",
  ];
  const lines = [
    "# OSM coverage per city (B44 item 1)",
    "",
    `Written by \`.github/workflows/osm-extracts.yml\` on ${input.generatedAt}` +
      (input.runSeconds !== null ? `, in ${Math.round(input.runSeconds / 60)} min` : "") +
      ". A report, rewritten every run: the counts are of `osm/<slug>.json`, the file " +
      "WUP Travel's `osm_import` step reads. The filter is in `README.md`. " +
      "© OpenStreetMap contributors, ODbL.",
    "",
    `| City | Region | Extract | Venues | ${columns.join(" | ")} |`,
    `| --- | --- | --- | ---: | ${columns.map(() => "---:").join(" | ")} |`,
  ];
  const totals: Record<string, number> = {};
  let venues = 0;
  for (const city of [...input.cities].sort((a, b) => a.slug.localeCompare(b.slug))) {
    const file = input.files.get(city.slug);
    const failure = input.failures.get(city.slug);
    if (!file) {
      lines.push(
        `| ${city.slug} | ${input.regions[city.slug] ?? "—"} | NOT READ${failure ? `: ${cell(failure)}` : ""} | — | ${columns.map(() => "—").join(" | ")} |`,
      );
      continue;
    }
    const counts = venueCounts(file.venues);
    venues += file.venues.length;
    for (const column of columns) totals[column] = (totals[column] ?? 0) + (counts[column] ?? 0);
    lines.push(
      `| ${city.slug} | ${file.region} | ${file.extract_timestamp.slice(0, 10)}${failure ? ` (STALE: ${cell(failure)})` : ""} | ${file.venues.length} | ${columns.map((column) => counts[column] ?? 0).join(" | ")} |`,
    );
  }
  lines.push(
    `| **all** | | | **${venues}** | ${columns.map((column) => `**${totals[column] ?? 0}**`).join(" | ")} |`,
  );
  const themed = OSM_THEMES.map((theme) => {
    let count = 0;
    for (const file of input.files.values()) {
      count += file.venues.filter((venue) => venue.themes.includes(theme)).length;
    }
    return `${theme} ${count}`;
  });
  lines.push("", `By theme (a venue may be in more than one): ${themed.join(", ")}.`, "");
  const regionLines = input.regionLines ?? [];
  if (regionLines.length > 0) {
    lines.push("## Regions not in Geofabrik's index as written", "");
    for (const line of regionLines) lines.push(`- ${line}`);
    lines.push("");
  }
  const downloads = input.downloads ?? [];
  if (downloads.length > 0) {
    lines.push(
      "## Downloads",
      "",
      "Every region this run asked Geofabrik for: the final HTTP status, its Content-Type, the " +
        "bytes received, the redirects followed, whether `osmium fileinfo` reads the file, and " +
        "the seconds it took. A download that is not a PBF fails its region, never osmium.",
      "",
      "| Region | HTTP | Content-Type | Bytes | Redirects | PBF | Seconds |",
      "| --- | --- | --- | ---: | ---: | --- | ---: |",
    );
    for (const each of downloads) {
      const why = downloadFailure(each);
      lines.push(
        `| ${each.region} | ${each.curlExit !== 0 ? `curl exit ${each.curlExit}, ` : ""}${each.status} | ${cell(each.contentType || "—")} | ${each.bytes} | ${each.redirects} | ${why === null ? "yes" : `NO: ${cell(why)}`} | ${each.seconds} |`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}
