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
}

export interface DetectionResult {
  findings: CommentFinding[];
  unsupported: Array<{ extension: string; path: string }>;
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
