/**
 * One finding, as seen across the K independent finder runs on the same diff.
 *
 * @typedef {object} Finding
 * @property {string} id
 * @property {string} title
 * @property {{ flagged: boolean, confidence: number }[]} samples  one entry per finder run:
 *   `flagged` — did this run report the finding; `confidence` — the 0..1 confidence the model
 *   stated for it in that run (0 when the run did not report it).
 */

/** @type {Finding} */
export const EXAMPLE = {
  id: 'null-deref-42',
  title: 'user may be null at auth.mjs:42',
  samples: [
    { flagged: true, confidence: 0.92 },
    { flagged: true, confidence: 0.85 },
    { flagged: false, confidence: 0 },
  ],
};
