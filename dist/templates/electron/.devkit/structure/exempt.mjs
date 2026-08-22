// Hand-maintained PERMANENT structure-rule exemptions.
//
// Generated debt lives under .devkit/baselines/ and shrinks as files are repaired. Entries here
// are intentional architectural exceptions and require an inline reason.

export const rendererStructureExempt = [
  // 'components/Foo.tsx', // example — vendored primitive, kebab root intentional
];

export const mainStructureExempt = [
  // 'auth-manager.ts', // example — colocated with subject, intentional flat root
];

// Permanent import-wall exemptions are matched before generated debt. Empty by default.
export const importWallExempt = [];
