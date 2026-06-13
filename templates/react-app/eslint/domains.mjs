// DOMAIN REGISTRY — growable, EXPORTED but EMPTY.
//
// A plain Vite/CRA React app organises its `src/` however it likes (utils/,
// services/, store/, hooks/, constants/, pages/, …). The react-app preset does
// NOT impose a closed lib/<domain> taxonomy (that is a frink-renderer-specific
// rule). So these registries ship EMPTY and are OPTIONAL: nothing in your repo
// is forced into a domain, and every existing top-level folder is left alone.
//
// They exist purely as OPT-IN amendment hooks. If you later decide you DO want a
// closed vocabulary for one folder (say you add `src/lib/` and want to stop
// agents inventing `lib/misc/`), append the concern name to the matching array
// below, wire `{<name>_domain}` into eslint.config.mjs, and re-run the baseline
// generator so pre-existing files are grandfathered. Until you do that, an empty
// array compiles to a match-NOTHING regex in eslint.config.mjs (never a crash).
//
// ADDING A DOMAIN (only if you opt in): append ONE kebab-case name, named after
// the CONCERN it owns — never a grab-bag like "misc"/"common"/"helpers".

/**
 * Closed vocabulary for first-level folders under a `src/lib/` root, IF you
 * choose to govern one. EMPTY by default => `src/lib/` is ungoverned (open).
 * e.g. ['http', 'storage'] then reference `{lib_domain}` in eslint.config.mjs.
 */
export const LIB_DOMAINS = [];

/**
 * Closed vocabulary for first-level folders under a `src/services/` root, IF you
 * choose to govern one. EMPTY by default => `src/services/` is open.
 */
export const SERVICE_DOMAINS = [];
