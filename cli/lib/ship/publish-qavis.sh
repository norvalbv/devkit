#!/usr/bin/env bash
# Qavis owns receipt validation, upload policy, and PR rendering. devkit supplies the shipped range.

publish_qavis_receipt() {
  local root=$1 pr=$2 base=$3 head=$4 output=''
  [ -f "$root/.qavis/receipt.json" ] || return 0

  if ! command -v qavis >/dev/null 2>&1; then
    echo "qavis publish: pass receipt exists, but qavis is not on PATH; PR evidence was not published." >&2
    echo "  Retry after installing/upgrading qavis:" >&2
    printf '  qavis publish --pr %q --repo %q --base %q --head %q\n' \
      "$pr" "$root" "$base" "$head" >&2
    return 0
  fi

  if output=$(qavis publish --pr "$pr" --repo "$root" --base "$base" --head "$head" 2>&1); then
    [ -n "$output" ] && echo "qavis publish: $output" >&2
    return 0
  fi
  echo "qavis publish: PR opened/pushed, but evidence publication failed." >&2
  [ -n "$output" ] && echo "  $output" >&2
  echo "  Retry only the publication step:" >&2
  printf '  qavis publish --pr %q --repo %q --base %q --head %q\n' \
    "$pr" "$root" "$base" "$head" >&2
  return 0
}
