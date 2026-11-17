#!/usr/bin/env bash
# Bash half of the machine-wide ship slot (queue/ship-queue.mts). Every function is a no-op unless
# this bash is the acquirer's: DEVKIT_SHIP_SLOT_RELEASE=1 plus the slot token and dir.

_ship_queue_slot_active() {
  [ "${DEVKIT_SHIP_SLOT_RELEASE:-}" = 1 ] && [ -n "${DEVKIT_SHIP_SLOT:-}" ] &&
    [ -n "${DEVKIT_SHIP_SLOT_DIR:-}" ]
}

_ship_queue_slot_cli() {
  local dir script
  dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  script="$dir/slot.mts"; [ -f "$script" ] || script="$dir/slot.mjs"
  node "$script" "$@"
}

# ship_queue_slot_register — the acquirer's FIRST action: record this process group on the claim,
# or refuse to run once the claim has moved on (the dispatcher died before this bash registered).
ship_queue_slot_register() {
  _ship_queue_slot_active || return 0
  local pgid
  pgid=$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ') || pgid=''
  case "$pgid" in
    '' | *[!0-9]*)
      echo "ship: cannot read this ship's process group (ps failed), so the queue could not track it; not starting" >&2
      exit 1 ;;
  esac
  _ship_queue_slot_cli register "$DEVKIT_SHIP_SLOT_DIR" "$DEVKIT_SHIP_SLOT" "$pgid" && return 0
  echo "ship: this ship no longer holds the machine-wide queue slot, so it will not start; re-run it" >&2
  exit 1
}

# ship_queue_slot_note_log <log> — record this attempt's gate log for `devkit ship --queue`.
ship_queue_slot_note_log() {
  _ship_queue_slot_active || return 0
  _ship_queue_slot_cli note-log "$DEVKIT_SHIP_SLOT_DIR" "$DEVKIT_SHIP_SLOT" "$1" || true
}

# ship_queue_slot_release — hand the slot on once every artifact is durable (before --wait-ci).
# A failure is announced, never swallowed: the slot then frees when this ship exits.
ship_queue_slot_release() {
  _ship_queue_slot_active || return 0
  local status=0
  _ship_queue_slot_cli release "$DEVKIT_SHIP_SLOT_DIR" "$DEVKIT_SHIP_SLOT" || status=$?
  case "$status" in
    0) ;;
    4) echo "ship: this ship no longer held the queue slot (already released or reclaimed)" >&2 ;;
    5) echo "ship: a nested ship still runs under the queue slot; it frees when that ends or this ship exits" >&2 ;;
    *) echo "ship: the queue slot stays held until this ship exits; queued ships wait through this CI poll" >&2 ;;
  esac
}
