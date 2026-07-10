// DOMAIN REGISTRY — the closed vocabulary of lib/ domain folders.
//
// lib/ roots are folder-only (a flat file at lib/ root is a lint error), and a
// first-level lib/ subfolder must be one of the names below. This is what stops
// agents inventing junk-drawer folders (lib/misc/, lib/helpers/) or dumping
// files flat instead of picking a domain.
//
// THESE START (NEARLY) EMPTY — they are YOUR registry, grown one append at a
// time as your app gains concerns. `devkit init --stack electron` grandfathers
// every existing lib file at init, so an empty registry never bricks an existing
// repo; new lib folders added AFTER init must register here first.
//
// ADDING A NEW DOMAIN is deliberate and cheap: append ONE name to the right
// array below (kebab-case, named after the CONCERN it owns — never a grab-bag
// like "misc"/"common"/"helpers"), say why in the commit message, then re-run
// `devkit init --stack electron` so any pre-existing files in the new domain are
// grandfathered. Both eslint.config.mjs and the baseline generator import THIS
// file, so the rule and the generator can never disagree.

/** First-level domains under src/renderer/lib/ (renderer-process logic, by concern). */
export const RENDERER_LIB_DOMAINS = [
  'utils', // safe seed — generic renderer helpers (pure functions, no React)
];

/**
 * Named root folders of src/main (no generic kebab match at main root). A new
 * root folder needs BOTH a one-line append here AND a named entry in
 * eslint.config.mjs mainStructure (shapes differ per root).
 */
export const MAIN_ROOT_FOLDERS = ['lib', 'windows'];

/** First-level domains under src/main/lib/ (main-process modules, by domain). */
export const MAIN_LIB_DOMAINS = [];

/** First-level domains under socket-server/src/lib/ (backend, by domain). */
export const SOCKET_LIB_DOMAINS = [];

/** First-level domains under vercel-serverless/lib/ (webhook handlers' shared code). */
export const VERCEL_LIB_DOMAINS = [];
