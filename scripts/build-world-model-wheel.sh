#!/usr/bin/env bash
# Reproducibly rebuild the vendored native experiential wheel: the original
# pinned build plus the reviewed patches in agents/vendor/world-model/patches.
# The upstream repository was removed, so the original wheel is the source.
#   scripts/build-world-model-wheel.sh [original-wheel] [output-dir]
# Defaults: the original wheel from commit ce9f59312 and agents/vendor/world-model.
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
base_name="experiential-0.7.158+rose.bf75987e-py3-none-any.whl"
base_sha256="f15392b6c09676f1d9905be0afe5e2c3aa8222a1674cffefc94a00c2ddb2cf36"
version="0.7.158+rose.bf75987e.elapsed1"
wheel_tool="wheel==0.45.1"
out_dir="${2:-$repo_root/agents/vendor/world-model}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
if [ -n "${1:-}" ]; then
    cp "$1" "$work/$base_name"
else
    git -C "$repo_root" show "ce9f59312:agents/vendor/world-model/$base_name" > "$work/$base_name"
fi
[ "$(sha256sum "$work/$base_name" | cut -d ' ' -f 1)" = "$base_sha256" ] || {
    echo "Original experiential wheel differs from its recorded SHA-256" >&2
    exit 1
}
mkdir "$work/tree"
(cd "$work/tree" && python3 -m zipfile -e "../$base_name" .)
for patch_file in "$repo_root"/agents/vendor/world-model/patches/*.patch; do
    patch --quiet --forward -p1 -d "$work/tree" < "$patch_file"
done
find "$work/tree" -name '*.orig' -delete
mv "$work/tree/experiential-0.7.158+rose.bf75987e.dist-info" "$work/tree/experiential-$version.dist-info"
sed -i "s/^Version: 0.7.158+rose.bf75987e$/Version: $version/" "$work/tree/experiential-$version.dist-info/METADATA"
grep -qx "Version: $version" "$work/tree/experiential-$version.dist-info/METADATA"
rm "$work/tree/experiential-$version.dist-info/RECORD"
find "$work/tree" -type d -exec chmod 755 {} + && find "$work/tree" -type f -exec chmod 644 {} +
# The original pin's commit time keeps the archive byte-for-byte reproducible.
mkdir "$work/dist"
SOURCE_DATE_EPOCH=1791303018 uvx --from "$wheel_tool" wheel pack "$work/tree" -d "$work/dist" >&2
mkdir -p "$out_dir"
cp "$work/dist/experiential-$version-py3-none-any.whl" "$out_dir/"
sha256sum "$out_dir/experiential-$version-py3-none-any.whl"
