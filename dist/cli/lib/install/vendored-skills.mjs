/**
 * The third-party skills devkit VENDORS rather than installs — copied into `skills/<name>/` at a
 * pinned upstream commit and shipped inside the package like every other bundled asset.
 *
 * Why vendor at all: the alternative (shelling out to the upstream installer, e.g.
 * `claude plugin install`) is Claude-only, writes to the user's GLOBAL config instead of the repo,
 * needs the network at install time, and sits outside devkit's manifest/doctor/clean ownership
 * model. A vendored copy installs offline from devkit's own bundle and is removable by deselecting
 * its component. It is delivered to `.devkit/vendored-skills/` (install/adhd-skill.mts) rather than
 * the consumer's `.claude/skills/`, which belongs to their own hand-authored skills.
 *
 * Why a COMMIT pin and not a version: these upstreams publish no tags or releases, so a SHA is the
 * only thing that identifies "the bytes we reviewed". `sha256` is the content hash of the vendored
 * file, asserted by vendored-skills.test.mts — an accidental local edit fails the suite, and a
 * genuine upstream bump has to move the pin deliberately (see scripts/sync-vendored-skills.mjs).
 */
export const VENDORED_SKILLS = [
    {
        name: 'i-have-adhd',
        repo: 'https://github.com/ayghri/i-have-adhd',
        commit: '07684c4ab625dd7d1ea6e99e065f60bc0ac6a1ba',
        path: 'skills/i-have-adhd/SKILL.md',
        sha256: 'cae8c063977214b372c6897b7c93ac8faa573214a8635896f767e3bac092adf8',
        license: 'MIT',
        holder: 'Ayoub Ghriss',
    },
];
