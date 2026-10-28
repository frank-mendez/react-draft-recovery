import type { LocalRecord, Result, Scope } from '../contracts/index.js';
const ok = <T>(value: T): Result<T> => ({ kind: 'ok', value });
const failure = (code: string, message: string): Result<never> => ({ kind: 'permanent', code, message });
export const isScope = (value: unknown): value is Scope => typeof value === 'object' && value !== null &&
  ['userId', 'documentId', 'editorId'].every(key => typeof (value as Record<string, unknown>)[key] === 'string');

export function validateRecord(value: unknown, scope: Scope): Result<LocalRecord> {
  if (typeof value !== 'object' || value === null) return failure('invalid_envelope', 'Invalid draft envelope.');
  const r = value as Partial<LocalRecord>;
  if (r.formatVersion !== 1 || !isScope(r.scope) || ['userId', 'documentId', 'editorId'].some(key => r.scope![key as keyof Scope] !== scope[key as keyof Scope]) ||
    !(r.baseRevision === null || (typeof r.baseRevision === 'string' && r.baseRevision.length > 0)) ||
    !Number.isSafeInteger(r.dataVersion) || (r.dataVersion ?? -1) < 0 || typeof r.payload !== 'string' ||
    typeof r.savedAt !== 'string' || !Number.isFinite(Date.parse(r.savedAt))) {
    return failure('invalid_envelope', 'Invalid or unsupported draft envelope.');
  }
  return ok(r as LocalRecord);
}

