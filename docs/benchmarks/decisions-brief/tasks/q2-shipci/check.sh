#!/bin/bash
exec node "$(dirname "$0")/check.mjs" cli/lib/ship/wait-ci.mjs
