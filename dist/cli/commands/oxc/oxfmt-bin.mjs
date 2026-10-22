#!/usr/bin/env node
// `devkit-oxfmt` — devkit's pinned Oxfmt, imported in-process: the bin is itself a Node script, so a
// hook calling it pays one Node start-up, not the two `devkit oxc fmt` costs. Args pass through.
var __rewriteRelativeImportExtension = (this && this.__rewriteRelativeImportExtension) || function (path, preserveJsx) {
    if (typeof path === "string" && /^\.\.?\//.test(path)) {
        return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function (m, tsx, d, ext, cm) {
            return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : (d + ext + "." + cm.toLowerCase() + "js");
        });
    }
    return path;
};
import { pathToFileURL } from 'node:url';
import { resolveOxcRuntime } from '../../lib/install/oxc/runtime.mjs';
await import(__rewriteRelativeImportExtension(pathToFileURL(resolveOxcRuntime('fmt').binPath).href));
