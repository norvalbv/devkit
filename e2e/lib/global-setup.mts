/**
 * Vitest globalSetup for the e2e project: build + pack + install the tarball ONCE in the main
 * process before any worker starts. Workers then call ensureInstalledPrefix() themselves and hit the
 * source-hash disk cache (no env handoff — unreliable across the threads pool). A build failure here
 * throws and aborts the whole run, which is the point.
 */
import { ensureInstalledPrefix } from './harness.mts';

export default async function setup(): Promise<void> {
  await ensureInstalledPrefix();
}
