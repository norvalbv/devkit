#!/usr/bin/env node
// `devkit-oxfmt` — devkit's pinned Oxfmt, imported in-process: the bin is itself a Node script, so a
// hook calling it pays one Node start-up, not the two `devkit oxc fmt` costs. Args pass through.

import { pathToFileURL } from 'node:url';
import { resolveOxcRuntime } from '../../lib/install/oxc/runtime.mts';

await import(pathToFileURL(resolveOxcRuntime('fmt').binPath).href);
