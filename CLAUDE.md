# CLAUDE.md — wup-osm

OpenStreetMap venues for WUP Travel's vegan, dogs and LGBTQ+ pages. A
monthly GitHub Action (`.github/workflows/osm-extracts.yml`) cuts each city
out of Geofabrik's extracts, keeps what the filter in `src/venues.ts` names,
and commits `osm/<slug>.json` here. Moved out of `Grapejuice-io/wup-travel`
in its B44f item 1; that repository's `CLAUDE.md` and `docs/` are the rest of
the record.

- **wup-travel reads this repository.** Its `osm_import` step fetches
  `<osm_files_base_url><slug>.json`, by default
  `https://raw.githubusercontent.com/Grapejuice-io/wup-osm/main/osm/`. So a
  path, a file name or the format changed here is a change to wup-travel too.
- **The format is the contract.** The filter lives here only; wup-travel
  keeps only the parser. `tests/fixtures/contract-city.json` is generated
  (`bun scripts/cli.ts fixture`) and copied into wup-travel's
  `tests/fixtures/osm-city-file.json` in the same change.
- **The data is ODbL 1.0, © OpenStreetMap contributors** (`LICENSE-DATA`,
  `README.md`). Keep the notice wherever the data goes.
- **This repository is public. No one's email address goes in it** — not in
  the User-Agent, not in a commit's author line you write, not in a file. The
  repository is the contact channel.
- **bun only.** `bun install`, `bun run verify` before a push. `bun.lock` is
  the lockfile; never commit a `package-lock.json`.
- **Work on `main`. Never a branch.** The Action commits to `main` with its own
  `GITHUB_TOKEN` (`contents: write`): no secret, no token for another
  repository.
- **Never run the extracts from a session.** A run is 45 minutes of
  downloads; it runs on GitHub, by schedule or by hand from the Actions tab.
- Every task ends in a commit, pushed. Say what you did not do, and why.
