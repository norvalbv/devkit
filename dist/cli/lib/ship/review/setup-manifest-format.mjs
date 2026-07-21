/** Shared wire-format primitives for the frozen review setup manifest. */
import { createHash } from 'node:crypto';
export const REVIEW_SETUP_VERSION = 1;
export const REVIEW_SETUP_ABSENT = 'absent';
const SHA256 = /^[a-f0-9]{64}$/;
export function reviewSetupHash(value) {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function isReviewSetupHash(value) {
    return typeof value === 'string' && SHA256.test(value);
}
