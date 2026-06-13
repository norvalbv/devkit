// Hand-maintained PERMANENT structure-rule exemptions.
//
// Each entry is an INTENTIONAL architectural exception — NOT a legacy
// grandfather awaiting cleanup. Legacy grandfathers live in the auto-generated
// eslint/baselines/<tree>.mjs files (shrink-only targets); this file is
// hand-maintained and requires a reason per entry.
//
// To exempt a file:
//   1. Add the path relative to its structureRoot (e.g. src/components/).
//   2. Add an inline `// reason` comment explaining the architectural choice.
//   3. Remove the file from the corresponding generated baseline.
//
// Removing an entry restores the structure check for that file.

export const componentStructureExempt = [
  // 'Legacy/weird.tsx', // example — vendored primitive, naming intentional
];

export const pageStructureExempt = [
  // 'Marketing/landing.html', // example — static page intentionally colocated
];
