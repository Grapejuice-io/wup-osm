/**
 * The OSM workflow's command line, run by Bun in the Action.
 *
 *   bun scripts/cli.ts filter               the osmium tags-filter expressions
 *   bun scripts/cli.ts plan                 regions, one a line: <region> <slug,slug>
 *   bun scripts/cli.ts resolve <index.json> every region path checked against Geofabrik's
 *                                           index; one found under another path BY NAME is
 *                                           written to data/regions.json. Prints one
 *                                           line per region not found as written:
 *                                           <resolved|unknown> TAB <region> TAB <why>
 *   bun scripts/cli.ts bbox <slug>          minlon,minlat,maxlon,maxlat
 *   bun scripts/cli.ts city <slug> <region> <timestamp> <export.geojsonseq>
 *                                           writes osm/<slug>.json if it changed
 *   bun scripts/cli.ts verdict <download.tsv>
 *                                           why that one download is not a PBF, or nothing
 *   bun scripts/cli.ts coverage <failures.tsv> <seconds> <downloads.tsv> <regions.tsv>
 *                                           writes docs/osm-coverage.md
 *   bun scripts/cli.ts fixture              writes tests/fixtures/contract-city.json, the
 *                                           format's fixture, from tests/fixtures/export.geojsonseq
 *
 * Paths are relative to the repository root, which is where the Action runs.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { osmiumExpressions, type OsmCityFile } from "../src/venues.ts";
import {
  bboxOf,
  changed,
  cityFile,
  contractFixture,
  coverageMarkdown,
  downloadFailure,
  indexRegions,
  parseDownloadLine,
  radiusOf,
  readOwnFile,
  regionPlan,
  resolutionLine,
  resolveRegions,
  serialise,
  venuesFromGeojsonSeq,
  withResolvedRegions,
  type DownloadRecord,
  type City,
  type OsmConfig,
} from "./lib.ts";

const read = (path: string) => JSON.parse(readFileSync(path, "utf8")) as unknown;
const cities = (read("data/cities.json") as { cities: City[] }).cities;
const regionsFile = read("data/regions.json") as {
  note?: string;
  regions: Record<string, string>;
};
const regions = regionsFile.regions;
const config = read("data/config.json") as OsmConfig;
const cityOf = (slug: string) => {
  const city = cities.find((each) => each.slug === slug);
  if (!city) throw new Error(`no city ${slug} in data/cities.json`);
  return city;
};
const fileOf = (slug: string): OsmCityFile | null => {
  const path = `osm/${slug}.json`;
  return existsSync(path) ? readOwnFile(read(path)) : null;
};

const [command, ...args] = process.argv.slice(2);
switch (command) {
  case "filter": {
    console.log(osmiumExpressions().join(" "));
    break;
  }
  case "plan": {
    const missing = cities.filter((city) => !regions[city.slug]).map((city) => city.slug);
    if (missing.length > 0) throw new Error(`no region for: ${missing.join(", ")}`);
    for (const { region, cities: slugs } of regionPlan(regions)) {
      console.log(`${region} ${slugs.join(",")}`);
    }
    break;
  }
  case "resolve": {
    const plan = regionPlan(regions).map((each) => each.region);
    const index = read(args[0]!);
    if (indexRegions(index).length === 0) {
      throw new Error(`error: ${args[0]} holds no region with a .pbf download`);
    }
    const resolutions = resolveRegions(index, plan);
    const next = withResolvedRegions(regions, resolutions);
    if (JSON.stringify(next) !== JSON.stringify(regions)) {
      writeFileSync(
        "data/regions.json",
        `${JSON.stringify({ ...regionsFile, regions: next }, null, 2)}\n`,
      );
    }
    for (const resolution of resolutions) {
      const line = resolutionLine(resolution);
      if (line !== null) console.log(`${resolution.status}\t${resolution.region}\t${line}`);
    }
    break;
  }
  case "verdict": {
    const record = parseDownloadLine(readFileSync(args[0]!, "utf8").split("\n")[0] ?? "");
    if (!record) throw new Error(`no download recorded in ${args[0]}`);
    const why = downloadFailure(record);
    if (why !== null) console.log(why);
    break;
  }
  case "bbox": {
    const slug = args[0]!;
    console.log(bboxOf(cityOf(slug), radiusOf(config, slug)).join(","));
    break;
  }
  case "city": {
    const [slug, region, timestamp, exported] = args as [string, string, string, string];
    const city = cityOf(slug);
    const next = cityFile({
      city,
      region,
      timestamp,
      radiusKm: radiusOf(config, slug),
      venues: venuesFromGeojsonSeq(readFileSync(exported, "utf8")),
    });
    const previous = fileOf(slug);
    if (changed(previous, next)) {
      writeFileSync(`osm/${slug}.json`, serialise(next));
      console.log(`${slug}: ${next.venues.length} venue(s), written`);
    } else {
      console.log(`${slug}: ${next.venues.length} venue(s), unchanged`);
    }
    break;
  }
  case "coverage": {
    const failures = new Map<string, string>();
    if (args[0] && existsSync(args[0])) {
      for (const line of readFileSync(args[0], "utf8").split("\n")) {
        const [slug, ...why] = line.split("\t");
        if (slug) failures.set(slug, why.join(" "));
      }
    }
    const files = new Map<string, OsmCityFile>();
    for (const city of cities) {
      const file = fileOf(city.slug);
      if (file) files.set(city.slug, file);
    }
    const seconds = args[1] ? Number(args[1]) : null;
    const lines = (path: string | undefined) =>
      path && existsSync(path) ? readFileSync(path, "utf8").split("\n") : [];
    const downloads = lines(args[2])
      .map(parseDownloadLine)
      .filter((record): record is DownloadRecord => record !== null);
    const regionLines = lines(args[3]).flatMap((line) => {
      const why = line.split("\t")[2];
      return why ? [why] : [];
    });
    writeFileSync(
      "docs/osm-coverage.md",
      coverageMarkdown({
        generatedAt: new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC",
        cities,
        regions,
        files,
        failures,
        runSeconds: Number.isFinite(seconds) ? seconds : null,
        regionLines,
        downloads,
      }),
    );
    break;
  }
  case "fixture": {
    writeFileSync(
      "tests/fixtures/contract-city.json",
      serialise(contractFixture(readFileSync("tests/fixtures/export.geojsonseq", "utf8"))),
    );
    console.log("tests/fixtures/contract-city.json written");
    break;
  }
  default:
    throw new Error(`unknown command: ${command ?? "(none)"}`);
}
