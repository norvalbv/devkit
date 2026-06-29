/**
 * Help renderer — the single source of truth for `devkit`'s help surface. Each command exports a
 * `meta = { name, summary, help }`: `summary` is its one-line entry in the top-level list, `help`
 * is the full text printed by `devkit help <cmd>` and `devkit <cmd> --help`. index.mjs derives the
 * top-level help by concatenating every command's summary, so usage text lives in ONE place per
 * command (not duplicated across a central HELP literal). README prose stays separate — it's
 * narrative, not reference.
 *
 * @typedef {{ name: string, summary: string, help: string }} CommandMeta
 */

const HEADER = "devkit — wire a repo onto @norvalbv/devkit's shared configs + gate-engine.";

const FOOTER = `Docs: see docs/glossary.md + docs/troubleshooting.md in the devkit repo.
Run \`devkit help <command>\` (or \`devkit <command> --help\`) for the full options of any command.`;

/** One aligned line for the top-level command list. */
export function renderSummaryLine(meta) {
  return `  devkit ${meta.name.padEnd(13)} ${meta.summary}`;
}

/** Full help for a single command. */
export function renderCommandHelp(meta) {
  return meta.help;
}

/** Top-level help: header + every command's summary + the global flags + docs footer. */
export function renderTopLevelHelp(metas) {
  const list = metas.map(renderSummaryLine).join('\n');
  return `${HEADER}

Usage:
  devkit <command> [options]

Commands:
${list}
  devkit --version    Print devkit's version.
  devkit --help       This help.

${FOOTER}`;
}
