// Hand-maintained PERMANENT structure-rule exemptions — the only hand-edited baseline.
//
// Each entry is an INTENTIONAL architectural exception, NOT a legacy grandfather awaiting cleanup.
// Use the generated eslint/baselines/<tree>.mjs for those (auto-generated, shrink-only target).
//
// To exempt a file:
//   1. Add its tree-relative path here (relative to that tree's `root`), to the matching array.
//   2. Add an inline `// reason` comment explaining the architectural choice.
//   3. Remove the file from the corresponding generated baseline (the generator re-walks the tree
//      and re-adds violators on regen, so coordinate timing).
//
// Removing an entry restores the structure check for that file.

// One array per declared structure tree. Key = the tree's `name`; value = tree-relative paths that
// are permanently allowed to break the placement rule. Spread into that tree's rule ignore set.
export const structureExempt = {
  // cli: ['index.mjs'],          // example — entry shim, intentional flat root
};

// Permanent IMPORT-WALL exemptions — independent-modules Module entries, spread FIRST in the
// generated eslint.config shim (first match wins). Each carries its own reason; these never shrink
// (unlike the generated eslint/baselines/imports.mjs). Empty when a repo declares no import walls.
export const importWallExempt = [
  // {
  //   // Example: a single sanctioned cross-boundary import that inference forces.
  //   name: 'some-bridge (permanent exempt)',
  //   pattern: 'src/renderer/lib/trpc.ts',
  //   allowImportsFrom: ['{renderer_base}', 'src/main/lib/trpc/routers/**'],
  // },
];
