#!/bin/bash
exec node "$(dirname "$0")/check.mjs" templates/hooks/overlay-pre-commit.sh
