#!/usr/bin/env bash
# The OSM workflow's download-and-cut loop (wup-travel B44 item 1, B44b item
# 1), run by .github/workflows/osm-extracts.yml from the repository root. A script of
# its own so it can be run outside the Action against a stand-in server
# (OSM_BASE), which is how it was tested.
#
# For each region of `bun scripts/cli.ts plan`, ONE AT A TIME: download
# its extract, record what came back, cut each of its cities, delete it.
#
# Every cause of a failure lands in two places, because the run's log may
# not be readable by whoever reads the result: a line of
# $RUNNER_TEMP/failures.tsv (the coverage report's NOT READ cell) and an
# ::error:: annotation (which `gh run view` shows). Every download is also a
# line of $RUNNER_TEMP/downloads.tsv (the report's Downloads table).
#
# Needs: RUNNER_TEMP, OSM_USER_AGENT; OSM_BASE defaults to Geofabrik.
# Reads $RUNNER_TEMP/regions.tsv (the resolve step's) for regions the index
# does not hold.
set -u -o pipefail

base="${OSM_BASE:-https://download.geofabrik.de/}"
work="$RUNNER_TEMP/osm"
failures="$RUNNER_TEMP/failures.tsv"
downloads="$RUNNER_TEMP/downloads.tsv"
resolved="$RUNNER_TEMP/regions.tsv"
: > "$failures"
: > "$downloads"
[ -f "$resolved" ] || : > "$resolved"
mkdir -p osm "$work"

# One line of printable text: tabs, newlines and control bytes become
# spaces, runs of spaces one, at most $2 characters (default 300).
clean() {
  LC_ALL=C tr -c '[:print:]' ' ' | tr -s ' ' | cut -c "1-${1:-300}" | sed 's/^ //; s/ $//'
}
# An annotation's text, as the runner's command syntax wants it.
annotate() {
  local level=$1 message=$2
  message=${message//'%'/'%25'}
  echo "::${level}::${message}"
}

expressions=$(bun scripts/cli.ts filter)
echo "filter: $expressions"
bun scripts/cli.ts plan > "$work/plan.txt"

# stdin of the loop is the plan; nothing inside may read it.
while read -r region slugs; do
  pbf="$work/region.osm.pbf"
  fail() {
    for slug in ${slugs//,/ }; do printf '%s\t%s\n' "$slug" "$1" >> "$failures"; done
    annotate error "$region: $1"
  }
  unknown=$(awk -F'\t' -v r="$region" '$1 == "unknown" && $2 == r { print $3; exit }' "$resolved")
  if [ -n "$unknown" ]; then
    fail "$unknown"
    continue
  fi
  echo "::group::$region ($slugs)"

  started=$(date +%s)
  rm -f "$pbf" "$work/curl.err"
  # No -f: a refusal's body is evidence and is kept. -L: a redirect is
  # followed, and its count recorded.
  written=$(curl -sS -L --retry 3 --retry-delay 20 -A "$OSM_USER_AGENT" \
    -w '%{http_code}|%{content_type}|%{size_download}|%{num_redirects}' \
    -o "$pbf" "${base}${region}-latest.osm.pbf" 2> "$work/curl.err" < /dev/null)
  curl_exit=$?
  # "|", not a tab: a tab is whitespace to `read`, and an empty Content-Type
  # would shift every field after it.
  IFS='|' read -r status type bytes redirects <<< "$written"
  curl_error=$(head -n 1 "$work/curl.err" 2> /dev/null | clean)
  if [ -s "$pbf" ] && osmium fileinfo "$pbf" > /dev/null 2> "$work/fileinfo.err" < /dev/null; then
    fileinfo=ok
  else
    fileinfo=$(head -n 1 "$work/fileinfo.err" 2> /dev/null | clean)
    [ -s "$pbf" ] || fileinfo="no file"
    [ -n "$fileinfo" ] || fileinfo="failed"
  fi
  head=$( (head -c 200 "$pbf" 2> /dev/null || true) | clean 200)
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$region" "$curl_exit" "$curl_error" "${status:-000}" "$(printf '%s' "${type:-}" | clean)" \
    "${bytes:-0}" "${redirects:-0}" "$fileinfo" "$head" "$(( $(date +%s) - started ))" \
    > "$work/download.tsv"
  cat "$work/download.tsv" >> "$downloads"
  echo "download: HTTP ${status:-000}, ${type:-no type}, ${bytes:-0} bytes, ${redirects:-0} redirect(s), fileinfo: $fileinfo"

  why=$(bun scripts/cli.ts verdict "$work/download.tsv" < /dev/null)
  if [ -n "$why" ]; then
    fail "$why"
    rm -f "$pbf"
    echo "::endgroup::"
    continue
  fi

  stamp=$(osmium fileinfo -g header.option.osmosis_replication_timestamp "$pbf" < /dev/null 2> /dev/null || true)
  [ -n "$stamp" ] || stamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  for slug in ${slugs//,/ }; do
    box=$(bun scripts/cli.ts bbox "$slug" < /dev/null)
    cut="$work/$slug.osm.pbf"
    kept="$work/$slug.filtered.osm.pbf"
    seq="$work/$slug.geojsonseq"
    err="$work/$slug.err"
    stage=""
    # $expressions is unquoted on purpose: one word per expression.
    if ! osmium extract --overwrite -b "$box" -s complete_ways "$pbf" -o "$cut" 2> "$err" < /dev/null; then
      stage="extract -b $box"
    elif ! osmium tags-filter --overwrite "$cut" $expressions -o "$kept" 2> "$err" < /dev/null; then
      stage="tags-filter"
    elif ! osmium export --overwrite -f geojsonseq --add-unique-id=type_id "$kept" -o "$seq" 2> "$err" < /dev/null; then
      stage="export"
    fi
    if [ -n "$stage" ]; then
      message="osmium $stage failed: $(head -n 1 "$err" | clean)"
      printf '%s\t%s\n' "$slug" "$message" >> "$failures"
      annotate error "$slug: $message"
    elif ! bun scripts/cli.ts city "$slug" "$region" "$stamp" "$seq" 2> "$err" < /dev/null; then
      message="writing $slug failed: $(tail -n 1 "$err" | clean)"
      printf '%s\t%s\n' "$slug" "$message" >> "$failures"
      annotate error "$slug: $message"
    fi
    rm -f "$cut" "$kept" "$seq" "$err"
  done
  rm -f "$pbf"
  echo "::endgroup::"
done < "$work/plan.txt"
exit 0
