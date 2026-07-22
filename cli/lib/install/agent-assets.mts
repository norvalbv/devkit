import { basename, extname, isAbsolute } from 'node:path';
import { TextDecoder } from 'node:util';
import { type AgentAssetKind, type AgentProvider, isAgentProvider } from './agent-providers.mts';

const FRONTMATTER_RE = /^(?:\uFEFF)?---[ \t]*\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m;
const FRONTMATTER_KEY_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const AGENT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const NUMBER_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const PLAIN_COMMENT_RE = /\s+#/;
const NULL_RE = /^(?:null)$/i;
const BOOLEAN_RE = /^(?:true|false)$/i;
const BLOCK_SCALAR_RE = /^[>|](?:[1-9][+-]?|[+-][1-9]?)?$/;
const EXPLICIT_STRING_TAG_RE = /^!!str(?:[ \t]|$)/;
const TAGGED_NODE_PROPERTY_RE = /^[!&*]/;
const LINE_BREAK_RE = /\r?\n/;
const INDENT_RE = /^[ \t]/;
const WHITESPACE_RE = /[ \t]/;
const INVALID_TOML_SURFACE_CHAR_RE = /\u007f/g;
const UTF8 = new TextDecoder('utf-8', { fatal: true });

interface AgentFrontmatter {
  name: string;
  description: string;
  body: string;
}

function provider(value: string): AgentProvider {
  if (!isAgentProvider(value)) throw new Error(`Unsupported agent provider: ${value}`);
  return value;
}

function validateLogicalRel(kind: AgentAssetKind, logicalRel: string): void {
  const parts = logicalRel.split('/');
  if (
    !logicalRel ||
    isAbsolute(logicalRel) ||
    logicalRel.includes('\\') ||
    parts.some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error(`Invalid ${kind} asset path: ${logicalRel}`);
  }
  if (kind !== 'skills' && parts.length !== 1)
    throw new Error(`${kind} assets must be flat files: ${logicalRel}`);
  if (kind === 'agents' && extname(logicalRel) !== '.md')
    throw new Error(`Agent assets must use a .md logical source path: ${logicalRel}`);
}

/** Provider-native directory for one logical devkit asset kind. */
export function agentAssetDir(target: string, kind: AgentAssetKind): string {
  const targetProvider = provider(target);
  if (targetProvider === 'codex' && kind === 'skills') return '.agents/skills';
  return `.${targetProvider}/${kind}`;
}

/** Map a logical bundle path to the filename/path a provider consumes. */
export function projectedAssetRel(
  target: string,
  kind: AgentAssetKind,
  logicalRel: string,
): string {
  const targetProvider = provider(target);
  validateLogicalRel(kind, logicalRel);
  if (targetProvider === 'codex' && kind === 'agents')
    return `${logicalRel.slice(0, -extname(logicalRel).length)}.toml`;
  return logicalRel;
}

function parsePlainScalar(raw: string): unknown {
  if (raw.startsWith('#')) return '';
  const comment = raw.search(PLAIN_COMMENT_RE);
  const value = (comment === -1 ? raw : raw.slice(0, comment)).trimEnd();
  if (!value) return '';
  if (value.startsWith('[') || value.startsWith('{'))
    throw new Error('Agent frontmatter collections are not supported');
  if (value === '~' || NULL_RE.test(value)) return null;
  if (BOOLEAN_RE.test(value)) return value.toLowerCase() === 'true';
  if (NUMBER_RE.test(value)) return Number(value);
  return value;
}

function parseExplicitStringScalar(raw: string, key: string): string {
  const value = raw.slice('!!str'.length).trimStart();
  if (!value) throw new Error(`Agent frontmatter field "${key}" has no value`);
  if (value.startsWith('#')) return '';
  if (value.startsWith('"')) return quotedScalar(value, key, '"');
  if (value.startsWith("'")) return quotedScalar(value, key, "'");
  const comment = value.search(PLAIN_COMMENT_RE);
  const plain = (comment === -1 ? value : value.slice(0, comment)).trimEnd();
  if (
    !plain ||
    BLOCK_SCALAR_RE.test(plain) ||
    TAGGED_NODE_PROPERTY_RE.test(plain) ||
    plain.startsWith('[') ||
    plain.startsWith('{')
  )
    throw new Error(`Agent frontmatter field "${key}" has an unsupported tagged value`);
  return plain;
}

function quotedScalarEnd(raw: string, quote: '"' | "'"): number {
  for (let index = 1; index < raw.length; index++) {
    if (raw[index] !== quote) continue;
    if (quote === "'" && raw[index + 1] === "'") {
      index++;
      continue;
    }
    if (quote === '"') {
      let slashes = 0;
      for (let cursor = index - 1; cursor >= 0 && raw[cursor] === '\\'; cursor--) slashes++;
      if (slashes % 2) continue;
    }
    return index;
  }
  return -1;
}

function quotedScalar(raw: string, key: string, quote: '"' | "'"): string {
  const end = quotedScalarEnd(raw, quote);
  if (end === -1)
    throw new Error(`Agent frontmatter field "${key}" has an unterminated quoted scalar`);
  const trailing = raw.slice(end + 1).trim();
  if (trailing && !trailing.startsWith('#'))
    throw new Error(`Agent frontmatter field "${key}" has content after its quoted scalar`);
  const encoded = raw.slice(0, end + 1);
  if (quote === "'") return encoded.slice(1, -1).replaceAll("''", "'");
  try {
    return JSON.parse(encoded);
  } catch (error) {
    throw new Error(
      `Agent frontmatter field "${key}" has an invalid double-quoted scalar: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function parseFrontmatterScalar(raw: string, key: string): unknown {
  if (!raw) throw new Error(`Agent frontmatter field "${key}" has no value`);
  if (EXPLICIT_STRING_TAG_RE.test(raw)) return parseExplicitStringScalar(raw, key);
  if (raw.startsWith('!'))
    throw new Error(`Agent frontmatter field "${key}" uses an unsupported YAML tag`);
  if (BLOCK_SCALAR_RE.test(raw))
    throw new Error(`Agent frontmatter field "${key}" uses an unsupported block scalar`);
  if (raw.startsWith('"')) return quotedScalar(raw, key, '"');
  if (raw.startsWith("'")) return quotedScalar(raw, key, "'");
  return parsePlainScalar(raw);
}

function requiredString(fields: Map<string, unknown>, key: string): string {
  const value = fields.get(key);
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`Agent frontmatter requires a non-empty string "${key}" field`);
  return value;
}

function parseAgentFrontmatter(markdown: string): AgentFrontmatter {
  const match = FRONTMATTER_RE.exec(markdown);
  if (match?.index !== 0)
    throw new Error('Agent Markdown requires closed YAML frontmatter at the start of the file');

  const fields = new Map<string, unknown>();
  for (const [index, line] of match[1].split(LINE_BREAK_RE).entries()) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (INDENT_RE.test(line))
      throw new Error(`Agent frontmatter line ${index + 2} uses unsupported indentation`);
    const separator = line.indexOf(':');
    const key = separator === -1 ? '' : line.slice(0, separator);
    if (
      separator === -1 ||
      !FRONTMATTER_KEY_RE.test(key) ||
      (line[separator + 1] !== undefined && !WHITESPACE_RE.test(line[separator + 1]))
    ) {
      throw new Error(`Malformed agent frontmatter line ${index + 2}: ${line}`);
    }
    if (fields.has(key)) throw new Error(`Duplicate agent frontmatter field: ${key}`);
    fields.set(key, parseFrontmatterScalar(line.slice(separator + 1).trim(), key));
  }

  const body = markdown.slice(match[0].length);
  if (!body.trim()) throw new Error('Agent Markdown requires a non-empty instructions body');
  return {
    name: requiredString(fields, 'name'),
    description: requiredString(fields, 'description'),
    body,
  };
}

/** Whether a string can round-trip through filesystem/TOML UTF-8 without replacement collisions. */
export function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index++;
        continue;
      }
      return false;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

function assertValidUnicode(value: string, field: string): void {
  if (!isWellFormedUnicode(value))
    throw new Error(`Agent ${field} contains an unpaired Unicode surrogate`);
}

// JSON string syntax is a strict subset of TOML basic-string syntax for the escapes JSON emits.
// Escape DEL explicitly because JSON leaves it raw while TOML forbids a raw U+007F control char.
function tomlBasicString(value: string, field: string): string {
  assertValidUnicode(value, field);
  return JSON.stringify(value).replace(INVALID_TOML_SURFACE_CHAR_RE, '\\u007F');
}

/** Convert one Claude-style Markdown agent into Codex's deterministic native TOML shape. */
export function convertAgentMarkdownToCodexToml(markdown: string, logicalRel: string): string {
  validateLogicalRel('agents', logicalRel);
  const { name, description, body } = parseAgentFrontmatter(markdown);
  const expectedName = basename(logicalRel, '.md');
  if (!AGENT_NAME_RE.test(name)) throw new Error(`Invalid agent name: ${name}`);
  if (name !== expectedName)
    throw new Error(
      `Agent frontmatter name "${name}" does not match source filename "${logicalRel}"`,
    );
  return (
    `name = ${tomlBasicString(name, 'name')}\n` +
    `description = ${tomlBasicString(description, 'description')}\n` +
    `developer_instructions = ${tomlBasicString(body, 'developer_instructions')}\n`
  );
}

/** Provider-native bytes for one logical bundle file. Non-Codex projections remain byte-identical. */
export function projectAgentAsset(
  target: string,
  kind: AgentAssetKind,
  logicalRel: string,
  source: Uint8Array,
): Buffer {
  const targetProvider = provider(target);
  validateLogicalRel(kind, logicalRel);
  if (targetProvider !== 'codex' || kind !== 'agents') return Buffer.from(source);
  let markdown: string;
  try {
    markdown = UTF8.decode(source);
  } catch (error) {
    throw new Error(
      `Agent source "${logicalRel}" is not valid UTF-8: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return Buffer.from(convertAgentMarkdownToCodexToml(markdown, logicalRel), 'utf8');
}
