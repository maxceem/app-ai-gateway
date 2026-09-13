#!/usr/bin/env bash
# Run from a full checkout of the source commit, after Swift tests pass.
set -euo pipefail
remote="${1:?Usage: publish-swift-package.sh <destination-repository>}"
version=$(git show HEAD:app-ai-gateway-swift/VERSION)
if [[ ! "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  echo "VERSION must be a stable semantic version, such as 1.0.0" >&2
  exit 1
fi
split=$(git subtree split --prefix app-ai-gateway-swift HEAD)
tag="refs/tags/$version"
existing=$(git ls-remote "$remote" "$tag")
refs=("$split:refs/heads/main")
if [[ -n "$existing" ]]; then
  git fetch --no-tags "$remote" "$tag"
  # A published version must belong to this history. Never replace a tag.
  git merge-base --is-ancestor FETCH_HEAD "$split" || {
    echo "Published version $version is not an ancestor of this package; refusing to overwrite it" >&2
    exit 1
  }
  echo "Version $version already exists; syncing main only"
else
  refs+=("$split:$tag")
fi
# Non-fast-forward updates fail (including stale runs). Branch and new tag
# succeed together, so a failed push cannot leave a partially published release.
git push --atomic "$remote" "${refs[@]}"
echo "Published package main (VERSION $version)"
