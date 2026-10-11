#!/bin/sh
# devkit overlay pre-commit hook: runs the deterministic gates on the staged change.
guard-deterministic --staged
