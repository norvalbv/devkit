export interface CommentFinding {
  id: string;
  path: string;
  extension: string;
  adapterVersion: string;
  kind: 'line' | 'block';
  startLine: number;
  endLine: number;
  comment: string;
  context: string;
  relevantDiff: string;
  /** Hash of the code the paragraph sits on; stable when the comment shrinks or disappears. */
  anchor: string;
  /** Added or modified text lines — the count the budget judged. */
  textLines: number;
}

export interface TouchedParagraph {
  anchor: string;
  /** The paragraph's current text lines, so a deletion-only shortening still reads as ≤2. */
  textLines: number;
}

/** Shape of every touched standalone comment in the staged change. `paragraphs` buckets touched
 * paragraphs by their CURRENT text lines (declared sc-2620 follow-up); findings carry the added count. */
export interface CommentInventory {
  files: number;
  paragraphs: { one: number; two: number; over: number };
  trailingAdded: number;
  decisionsStaged: boolean;
  touched: TouchedParagraph[];
}

export interface DetectionResult {
  findings: CommentFinding[];
  unsupported: Array<{ extension: string; path: string }>;
  inventory: CommentInventory;
}

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;

export interface JsonObject {
  [key: string]: JsonValue;
}

export function parseJson(raw: string): JsonValue {
  return JSON.parse(raw);
}

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return Object.prototype.toString.call(value) === '[object Object]';
}

export function isJsonString(value: JsonValue | undefined): value is string {
  return Object.prototype.toString.call(value) === '[object String]';
}

export function isJsonInteger(value: JsonValue | undefined): value is number {
  return Number.isInteger(value);
}
