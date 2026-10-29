# Test fixtures

- `export.geojsonseq` — **HAND-MADE**, not read from OpenStreetMap: seven
  objects in the shape `osmium export -f geojsonseq --add-unique-id=type_id`
  writes (RFC 8142's record separator, `n`/`w`/`r` ids), with invented ids and
  representative tags. One matches nothing (a gate), one carries a value the
  filter does not take (`diet:vegan=no`).
- `contract-city.json` — **GENERATED**, never edited by hand:
  `bun scripts/cli.ts fixture` runs `export.geojsonseq` through the same code a
  real city goes through and writes it. It is the file format's fixture, copied
  byte for byte into wup-travel's `tests/fixtures/osm-city-file.json`, whose
  test parses it with wup-travel's `parseOsmCityFile`. `tests/contract.test.ts`
  fails here when the code would now write something else; regenerate it, then
  copy it to wup-travel in the same change.
