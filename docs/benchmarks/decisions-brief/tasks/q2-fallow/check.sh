#!/bin/bash
exec node "$(dirname "$0")/check.mjs" gate-engine/fallow/gate.mjs
