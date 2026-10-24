/** Shared wire-format primitives for the frozen review setup manifest. */

import { createHash } from 'node:crypto';

export const REVIEW_SETUP_VERSION = 1 as const;
export const REVIEW_SETUP_ABSENT = 'absent';
/** Target paths the setup authority freezes, present or absent; no gate projection may supply them. */
export const REVIEW_SETUP_OPTIONAL_PATHS = [
  ['correctness-overrides', '.devkit/correctness-overrides.json'],
  ['tsconfig-runtime', '.devkit/tsconfig'],
] as const;
const SHA256 = /^[a-f0-9]{64}$/;

export function reviewSetupHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function isReviewSetupHash(value: unknown): value is string {
  return typeof value === 'string' && SHA256.test(value);
}
