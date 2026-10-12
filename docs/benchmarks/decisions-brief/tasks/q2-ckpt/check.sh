#!/bin/bash
exec node "$(dirname "$0")/check.mjs" gate-engine/bench/checkpoint.mjs
