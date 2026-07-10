// Hand-maintained PERMANENT structure-rule exemptions.
//
// Each entry is an INTENTIONAL architectural exception — NOT a legacy
// grandfather awaiting cleanup. Those live in the auto-generated
// eslint/baselines/<tree>.mjs files (shrink-only targets); this file is
// hand-maintained and requires a reason per entry.
//
// To exempt a file:
//   1. Add the relative path (relative to its structureRoot, e.g. src/renderer/).
//   2. Add an inline `// reason` comment explaining the architectural choice.
//   3. Remove the file from the corresponding generated baseline.
//
// Removing an entry restores the structure check for that file.

export const rendererStructureExempt = [
  // 'components/Foo.tsx', // example — vendored primitive, kebab root intentional
];

export const mainStructureExempt = [
  // 'auth-manager.ts', // example — colocated with subject, intentional flat root
];

// Permanent IMPORT-WALL exemptions — independent-modules Module entries, spread
// FIRST in eslint.config.mjs (first match wins). Each carries its own reason;
// these never shrink (unlike the generated eslint/baselines/imports.mjs).
//
// EMPTY by default. Example (an Electron tRPC bridge needing main's AppRouter type):
//   {
//     name: 'renderer-trpc-bridge (permanent exempt)',
//     pattern: 'src/renderer/lib/trpc.ts',
//     allowImportsFrom: ['{renderer_base}', 'src/main/lib/trpc/routers/**'],
//   },
export const importWallExempt = [];
