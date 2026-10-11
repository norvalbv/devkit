#!/bin/bash
exec node "$(dirname "$0")/check.mjs" gate-engine/deterministic/extra-gates.mjs
