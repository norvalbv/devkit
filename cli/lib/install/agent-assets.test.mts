import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { packageDir } from '../fs-helpers.mts';
import {
  agentAssetDir,
  convertAgentMarkdownToCodexToml,
  projectAgentAsset,
  projectedAssetRel,
} from './agent-assets.mts';

function tomlValues(toml: string): Record<string, string> {
  return Object.fromEntries(
    toml
      .trimEnd()
      .split('\n')
      .map((line) => {
        const separator = line.indexOf(' = ');
        return [line.slice(0, separator), JSON.parse(line.slice(separator + 3))];
      }),
  );
}

describe('agent asset projections', () => {
  it('maps the explicit Codex target onto its native skill, agent, and hook paths', () => {
    expect(agentAssetDir('codex', 'skills')).toBe('.agents/skills');
    expect(agentAssetDir('codex', 'agents')).toBe('.codex/agents');
    expect(agentAssetDir('codex', 'hooks')).toBe('.codex/hooks');
    expect(projectedAssetRel('codex', 'agents', 'correctness-reviewer.md')).toBe(
      'correctness-reviewer.toml',
    );

    expect(agentAssetDir('claude', 'skills')).toBe('.claude/skills');
    expect(projectedAssetRel('cursor', 'agents', 'correctness-reviewer.md')).toBe(
      'correctness-reviewer.md',
    );
  });

  it('converts required metadata and the exact Markdown body with TOML-safe escaping', () => {
    const markdown = [
      '---',
      'name: quote-reviewer',
      String.raw`description: "Quotes: \"yes\"; path C:\\tmp; literal \\n marker" # metadata comment`,
      'tools: Read, Grep, Bash',
      'model: opus',
      'color: blue',
      '---',
      '',
      '# Review "quoted" code',
      '',
      String.raw`Keep C:\tmp and triple quotes """ intact.`,
      '',
    ].join('\n');

    const toml = convertAgentMarkdownToCodexToml(markdown, 'quote-reviewer.md');
    expect(toml.split('\n').filter(Boolean)).toHaveLength(3);
    expect(tomlValues(toml)).toEqual({
      name: 'quote-reviewer',
      description: String.raw`Quotes: "yes"; path C:\tmp; literal \n marker`,
      developer_instructions: String.raw`
# Review "quoted" code

Keep C:\tmp and triple quotes """ intact.
`,
    });
    expect(toml).not.toContain('tools =');
    expect(toml).not.toContain('model =');
    expect(toml).not.toContain('color =');

    expect(
      projectAgentAsset('codex', 'agents', 'quote-reviewer.md', Buffer.from(markdown)).toString(
        'utf8',
      ),
    ).toBe(toml);
    expect(
      projectAgentAsset('claude', 'agents', 'quote-reviewer.md', Buffer.from(markdown)),
    ).toEqual(Buffer.from(markdown));
  });

  it('preserves a YAML value explicitly tagged as a string', () => {
    const markdown = '---\nname: reviewer\ndescription: !!str true\n---\nbody\n';
    expect(tomlValues(convertAgentMarkdownToCodexToml(markdown, 'reviewer.md')).description).toBe(
      'true',
    );
  });

  it.each([
    ['missing frontmatter', '# body'],
    ['frontmatter after body text', 'preface\n---\nname: reviewer\ndescription: valid\n---\nbody'],
    ['unterminated frontmatter', '---\nname: reviewer\ndescription: valid\n# body'],
    ['duplicate key', '---\nname: reviewer\nname: other\ndescription: valid\n---\nbody'],
    ['missing description', '---\nname: reviewer\n---\nbody'],
    ['empty description', '---\nname: reviewer\ndescription: ""\n---\nbody'],
    ['comment-only description', '---\nname: reviewer\ndescription: # missing\n---\nbody'],
    [
      'tagged comment-only description',
      '---\nname: reviewer\ndescription: !!str # missing\n---\nbody',
    ],
    ['tagged block scalar', '---\nname: reviewer\ndescription: !!str |\n---\nbody'],
    [
      'tagged block scalar with comment',
      '---\nname: reviewer\ndescription: !!str | # note\n---\nbody',
    ],
    ['tagged indented block scalar', '---\nname: reviewer\ndescription: !!str |2\n---\nbody'],
    ['tagged anchor', '---\nname: reviewer\ndescription: !!str &label true\n---\nbody'],
    ['collection description', '---\nname: reviewer\ndescription: [not, a, string]\n---\nbody'],
    ['empty body', '---\nname: reviewer\ndescription: valid\n---\n'],
    ['malformed field', '---\nname reviewer\ndescription: valid\n---\nbody'],
    ['malformed quoted scalar', '---\nname: reviewer\ndescription: "bad\\q"\n---\nbody'],
    [
      'content after quoted scalar',
      "---\nname: reviewer\ndescription: 'valid' trailing\n---\nbody",
    ],
    ['filename mismatch', '---\nname: other\ndescription: valid\n---\nbody'],
  ])('rejects %s rather than silently emitting a partial agent', (_case, markdown) => {
    expect(() => convertAgentMarkdownToCodexToml(markdown, 'reviewer.md')).toThrow();
  });

  it('converts every bundled Claude agent deterministically', () => {
    const agentsDir = join(packageDir(), 'agents');
    const files = readdirSync(agentsDir)
      .filter((name) => name.endsWith('.md'))
      .sort();
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const markdown = readFileSync(join(agentsDir, file), 'utf8');
      const first = convertAgentMarkdownToCodexToml(markdown, file);
      expect(convertAgentMarkdownToCodexToml(markdown, file)).toBe(first);
      expect(Object.keys(tomlValues(first))).toEqual([
        'name',
        'description',
        'developer_instructions',
      ]);
    }
  });
});
