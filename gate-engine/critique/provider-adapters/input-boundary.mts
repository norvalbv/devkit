import { types as utilTypes } from 'node:util';
import { sha256Bytes } from '../evidence-record.mts';

export function plainHookPayload(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object') return null;
  try {
    if (utilTypes.isProxy(value) || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function ownHookValue(record: Record<string, unknown>, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    return descriptor?.enumerable && Object.hasOwn(descriptor, 'value')
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

export function boundedOpaqueIdentifier(value: unknown, maxBytes: number): value is string {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxBytes ||
    Buffer.byteLength(value, 'utf8') > maxBytes ||
    value.trim().length === 0
  )
    return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return false;
  }
  return true;
}

export function versionedTupleHash(domain: string, values: readonly string[]): string {
  return sha256Bytes(Buffer.from(JSON.stringify([domain, 1, ...values]), 'utf8'));
}
