// Hand-maintained PERMANENT structure-rule exemptions for the flat component-lib.
//
// Each entry is an INTENTIONAL architectural exception — NOT a legacy grandfather. The flat rule
// already passes a clean primitives lib, so this is usually empty. Add an entry only for a file that
// will NEVER conform (e.g. a vendored primitive with an unconventional name).
//
// To exempt a file:
//   1. Add its path relative to the structureRoot (scanRoots[0], default 'src').
//   2. Add an inline `// reason` comment explaining the architectural choice.
// Removing an entry restores the structure check for that file.

export const libStructureExempt = [
  // 'legacy-icon.tsx', // example — vendored asset, kebab name intentional
];
