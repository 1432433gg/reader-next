#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DOCKER_REPO="${DOCKER_REPO:-ghcr.io/1432433gg/reader-next}"
BUMP_MODE="patch"
INPUT_VERSION=""

usage() {
  cat <<'USAGE'
Usage:
  ./scripts/release.sh [vx.y.z|x.y.z|--major|--minor|--patch]

Behavior:
  - If version is provided: release that exact version.
  - If version is omitted: auto-bump latest git tag with patch (+1).
  - 1.2.1 must be given explicitly and version files must already match the reviewed commit.
  - Docker image is published by .github/workflows/docker-publish.yml after the tag is pushed.
  - Default Docker repo: ghcr.io/1432433gg/reader-next
USAGE
}

for arg in "$@"; do
  case "$arg" in
    --major) BUMP_MODE="major" ;;
    --minor) BUMP_MODE="minor" ;;
    --patch) BUMP_MODE="patch" ;;
    -h|--help) usage; exit 0 ;;
    v*|[0-9]*.[0-9]*.[0-9]*) INPUT_VERSION="$arg" ;;
    *)
      echo "Unknown argument: $arg" >&2
      usage
      exit 1
      ;;
  esac
done

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

require_cmd git
require_cmd cargo
require_cmd npm
require_cmd node
require_cmd gh
require_cmd awk

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Working tree is not clean. Commit/stash changes first." >&2
  exit 1
fi

if [[ -n "$(git ls-files --others --exclude-standard)" ]]; then
  echo "Untracked files exist. Clean them first." >&2
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "GitHub CLI is not authenticated. Run: gh auth login" >&2
  exit 1
fi

normalize_version() {
  local raw="$1"
  raw="${raw#v}"
  if [[ ! "$raw" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "Invalid version: $1" >&2
    exit 1
  fi
  echo "$raw"
}

latest_tag="$(git tag --list 'v*' | sort -V | tail -1)"

if [[ -n "$INPUT_VERSION" ]]; then
  SEMVER="$(normalize_version "$INPUT_VERSION")"
else
  base="${latest_tag#v}"
  if [[ -z "$base" || ! "$base" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    base="$(node -p "require('./frontend/package.json').version")"
  fi
  IFS='.' read -r major minor patch <<<"$base"
  case "$BUMP_MODE" in
    major)
      SEMVER="$((major + 1)).0.0"
      ;;
    minor)
      SEMVER="${major}.$((minor + 1)).0"
      ;;
    patch)
      SEMVER="${major}.${minor}.$((patch + 1))"
      ;;
    *)
      echo "Invalid bump mode: $BUMP_MODE" >&2
      exit 1
      ;;
  esac
fi

TAG="v${SEMVER}"
MAKE_LATEST=true
if [[ $SEMVER == 1.2.1 ]]; then
  if [[ -z $INPUT_VERSION ]]; then
    echo "Specify 1.2.1 explicitly to select the numeric test release." >&2
    exit 1
  fi
  MAKE_LATEST=false
fi
current_branch="$(git branch --show-current)"
if [[ -z $current_branch ]]; then
  echo "Check out the reviewed release branch first." >&2
  exit 1
fi
echo "Releasing ${TAG}"

if git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null; then
  echo "Tag ${TAG} already exists locally." >&2
  exit 1
fi

if git ls-remote --exit-code origin "refs/tags/$TAG" >/dev/null; then
  echo "Tag $TAG already exists on origin." >&2
  exit 1
elif [[ $? -ne 2 ]]; then
  echo "Cannot verify remote tag $TAG." >&2
  exit 1
fi

if gh release view "$TAG" >/dev/null 2>&1; then
  echo "GitHub release ${TAG} already exists." >&2
  exit 1
fi

update_cargo_version() {
  local version="$1"
  local file="Cargo.toml"
  local tmp
  tmp="$(mktemp)"
  awk -v ver="$version" '
    BEGIN { in_pkg=0; done=0 }
    /^\[package\]/ { in_pkg=1; print; next }
    /^\[/ && $0 !~ /^\[package\]/ { in_pkg=0 }
    in_pkg && !done && /^version[[:space:]]*=/ {
      print "version = \"" ver "\""
      done=1
      next
    }
    { print }
  ' "$file" > "$tmp"
  mv "$tmp" "$file"
}

if [[ $MAKE_LATEST == false ]]; then
  if ! awk -v version="$SEMVER" '/^\[package\]$/ { pkg=1; next } /^\[/ { pkg=0 } pkg && $0 == "version = \"" version "\"" { ok=1 } END { exit !ok }' Cargo.toml ||
     ! awk -v version="$SEMVER" '$0 == "name = \"reader-next\"" { getline; ok=($0 == "version = \"" version "\"") } END { exit !ok }' Cargo.lock ||
     ! node -e 'const v=process.argv[1], p=require("./frontend/package.json"), l=require("./frontend/package-lock.json"); process.exit([p.version, l.version, l.packages[""].version].every(x => x===v) ? 0 : 1)' "$SEMVER"; then
    echo "The reviewed 1.2.1 commit must already contain matching version files." >&2
    exit 1
  fi
else
  update_cargo_version "$SEMVER"
  (
    cd frontend
    npm version "$SEMVER" --no-git-tag-version --allow-same-version >/dev/null
  )
  cargo update --workspace
fi

echo "Building frontend..."
(
  cd frontend
  npm ci
  npm run build
)

echo "Building Rust binary..."
cargo build --release --locked

echo "Creating commit and tag..."
git add Cargo.toml Cargo.lock frontend/package.json frontend/package-lock.json
if git diff --cached --quiet; then
  echo "Version files already match ${TAG}; tagging current commit."
else
  git commit -m "release: ${TAG}"
fi
git tag -a "$TAG" -m "$TAG"

echo "Pushing git refs..."
git push --atomic origin "$current_branch" "$TAG"

echo "Creating GitHub release..."
gh release create "$TAG" \
  --verify-tag \
  --title "$SEMVER" \
  --latest="$MAKE_LATEST" \
  --generate-notes

echo "Release completed: $TAG"
echo "GitHub release: https://github.com/1432433gg/reader-next/releases/tag/${TAG}"
echo "Docker publish workflow should create:"
echo "  ${DOCKER_REPO}:${SEMVER}"
if [[ $MAKE_LATEST == true ]]; then
  echo "  ${DOCKER_REPO}:latest"
fi
