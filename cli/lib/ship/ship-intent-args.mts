export function parseArgs(argv: string[]) {
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  const links: string[] = [];
  const donates: string[] = [];
  const paths: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      paths.push(...argv.slice(i + 1));
      break;
    }
    if (a === '--no-qavis-publish' || a === '--resumed' || a === '--merge-paths')
      booleans.add(a.slice(2));
    else if (a === '--link') links.push(argv[++i] ?? '');
    else if (a === '--donate') donates.push(argv[++i] ?? '');
    else if (a.startsWith('--')) values.set(a.slice(2), argv[++i] ?? '');
  }
  return { values, booleans, links, donates, paths };
}

export function fail(msg: string): number {
  console.error(`ship-intent: ${msg}`);
  return 1;
}
