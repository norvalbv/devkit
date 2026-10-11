#!/bin/bash
exec node "$(dirname "$0")/check.mjs" cli/lib/ship/base-drift/freshness.mjs
