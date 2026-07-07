#!/bin/bash
# PreCompact hook — context-aware compaction advice. Reads the compaction event payload and
# emits a short strategic tip via `user_message`. Fully generic (no repo-specific paths) — it
# only reacts to the event's context-usage / message-count / first-compaction fields.

input=$(cat)

context_percent=$(echo "$input" | grep -o '"context_usage_percent":[0-9]*' | grep -o '[0-9]*' || echo "0")
message_count=$(echo "$input" | grep -o '"message_count":[0-9]*' | grep -o '[0-9]*' || echo "0")
is_first=$(echo "$input" | grep -o '"is_first_compaction":[a-z]*' | grep -o '[a-z]*' || echo "false")

if [ "$is_first" = "true" ]; then
  msg="💡 First compaction at ${context_percent}% context (${message_count} messages). Tip: Compact after exploration phases, before implementation."
elif [ "$message_count" -gt 100 ]; then
  msg="💡 Context at ${context_percent}% (${message_count} messages). Long session - consider if older context is still relevant."
else
  msg="💡 Compacting at ${context_percent}% context (${message_count} messages)."
fi

echo "{\"user_message\": \"$msg\"}"
exit 0
