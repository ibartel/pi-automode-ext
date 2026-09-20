#!/usr/bin/env bash
# Release helper for @ibartel74/pi-automode-ext
#
# Usage: npm run release -- <version> [--dry-run]
#   e.g. npm run release -- 1.1.0
#        npm run release -- 1.1.0 --dry-run
#
# Does: clean-tree/sync checks -> version bump -> CHANGELOG fold ->
# check+tests -> release commit -> tag (retagging inherited upstream tags
# on collision) -> push -> GitHub release -> watch the publish workflow.
set -euo pipefail

REPO="ibartel/pi-automode-ext"
DRY_RUN=0
VERSION="${1:-}"
[[ "${2:-}" == "--dry-run" || "${1:-}" == "--dry-run" ]] && DRY_RUN=1
[[ "$VERSION" == "--dry-run" ]] && { DRY_RUN=1; VERSION="${2:-}"; }

if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "usage: npm run release -- <X.Y.Z> [--dry-run]" >&2
  exit 1
fi

run() {
  if (( DRY_RUN )); then echo "[dry-run] $*"; else "$@"; fi
}

# --- preflight ---------------------------------------------------------------
if [[ -n "$(git status --porcelain)" ]]; then
  echo "error: working tree is not clean; commit or stash first" >&2
  exit 1
fi
git fetch -q origin main
if [[ "$(git rev-parse main)" != "$(git rev-parse origin/main)" ]]; then
  echo "error: local main is not in sync with origin/main" >&2
  exit 1
fi
if [[ -n "$(git tag -l "v$VERSION")" ]] \
  && [[ "$(git rev-parse "v$VERSION" 2>/dev/null)" != "$(git rev-parse main)" ]]; then
  echo "note: tag v$VERSION exists from inherited upstream history; it will be retagged at HEAD"
fi

PREV_VERSION="$(node --print "require('./package.json').version")"
if [[ "$VERSION" == "$PREV_VERSION" ]]; then
  echo "error: version $VERSION is already the current version" >&2
  exit 1
fi

TODAY="$(date +%Y-%m-%d)"

# --- version bump ------------------------------------------------------------
run npm version "$VERSION" --no-git-tag-version

# --- changelog ---------------------------------------------------------------
if ! grep -q '^## \[Unreleased\]$' CHANGELOG.md; then
  echo "error: CHANGELOG.md has no '## [Unreleased]' section" >&2
  exit 1
fi
if (( DRY_RUN )); then
  echo "[dry-run] fold [Unreleased] into [$VERSION] - $TODAY and update link refs"
else
  # Fold: new empty [Unreleased] + dated section where the old one was.
  awk -v ver="$VERSION" -v today="$TODAY" '
    !done && $0 == "## [Unreleased]" {
      print "## [Unreleased]"
      print ""
      print "## [" ver "] - " today
      done = 1
      next
    }
    { print }
  ' CHANGELOG.md > CHANGELOG.md.tmp && mv CHANGELOG.md.tmp CHANGELOG.md

  # Link refs: retitle the old Unreleased compare, add one for the release.
  if grep -q '^\[Unreleased\]:' CHANGELOG.md; then
    sed -i '' \
      -e "s#^\[Unreleased\]: \(.*\)compare/v.*\.\.\.HEAD#[Unreleased]: \1compare/v${VERSION}...HEAD\n[${VERSION}]: \1compare/v${PREV_VERSION}...v${VERSION}#" \
      CHANGELOG.md
  fi
fi

# --- verify ------------------------------------------------------------------
run npm run check
run npm test
run npm pack --dry-run

# --- release notes from the changelog section --------------------------------
NOTES="$(awk -v ver="$VERSION" '
  $0 == "## [" ver "] - " '"$TODAY"'" { in_section = 1; next }
  in_section && /^## \[/ { exit }
  in_section { print }
' CHANGELOG.md | sed -e '/./,$!d')"
if [[ -z "$NOTES" ]]; then
  NOTES="Release $VERSION. See [CHANGELOG.md](https://github.com/$REPO/blob/main/CHANGELOG.md)."
fi

# --- commit, tag, push, release ----------------------------------------------
run git add package.json package-lock.json CHANGELOG.md
run git commit -m "chore(release): $VERSION"
if git rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null; then
  run git tag -d "v$VERSION"
fi
run git tag "v$VERSION"
run git push origin main "v$VERSION"
if (( DRY_RUN )); then
  echo "[dry-run] gh release create v$VERSION"
else
  gh release create "v$VERSION" --title "v$VERSION" --notes "$NOTES"
  echo "Release created. Watching publish workflow..."
  sleep 8
  RUN_ID="$(gh run list --workflow publish.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
  gh run watch "$RUN_ID" --exit-status >/dev/null && echo "Published @ibartel74/pi-automode-ext@$VERSION to npm." \
    || { echo "workflow failed: https://github.com/$REPO/actions/runs/$RUN_ID" >&2; exit 1; }
  npm view "@ibartel74/pi-automode-ext@$VERSION" version
fi
