#!/usr/bin/env bash

set -euo pipefail

script_path=${BASH_SOURCE[0]}
script_dir=${script_path%/*}
if [[ "$script_dir" == "$script_path" ]]; then
  script_dir=.
fi
script_dir=$(cd -- "$script_dir" && pwd -P)

beads_dir=$(
  bd where --json |
    deno eval '
      const input = await new Response(Deno.stdin.readable).text();
      const result = JSON.parse(input);
      const payload = result.data ?? result;
      if (typeof payload.path !== "string" || payload.path.length === 0) {
        throw new Error("bd where --json returned no path");
      }
      console.log(payload.path);
    '
)
beads_dir=$(cd -- "$beads_dir" && pwd -P)

exec deno run \
  --allow-run=bd \
  --allow-read="$beads_dir" \
  --allow-write="$beads_dir" \
  "$script_dir/search.ts" \
  --beads-dir="$beads_dir" \
  "$@"
