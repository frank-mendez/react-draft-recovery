const ok = value => ({ kind: 'ok', value });
const failure = (kind, code, message) => ({ kind, code, message });
const unavailable = () => failure('retryable', 'storage_unavailable', 'Legacy draft storage is unavailable.');
const legacyPrefix = 'legacy:v1:';

export function legacyStorageKey({ userId, documentId, writerId }) {
  return legacyPrefix + [userId, documentId, writerId].map(encodeURIComponent).join(':');
}

/** Translate a legacy row into the library envelope after validating its owner. */
export function normalizeLegacyRecord(raw, id, query) {
  if (typeof raw !== 'string' || typeof id !== 'string' || !id.startsWith(legacyPrefix) ||
      typeof query?.userId !== 'string' || !query.userId) return null;
  let legacy;
  try { legacy = JSON.parse(raw); } catch { return null; }
  if (!legacy || legacy.version !== 1 || legacy.userId !== query.userId ||
      (query.documentId !== undefined && legacy.documentId !== query.documentId) ||
      typeof legacy.documentId !== 'string' || !legacy.documentId ||
      typeof legacy.writerId !== 'string' || !legacy.writerId ||
      typeof legacy.body !== 'string' || typeof legacy.savedAt !== 'string' ||
      !Number.isFinite(Date.parse(legacy.savedAt))) return null;
  if (id !== legacyStorageKey(legacy)) return null;

  return {
    id,
    revision: raw,
    record: {
      formatVersion: 1,
      scope: { userId: legacy.userId, documentId: legacy.documentId, editorId: legacy.writerId },
      baseRevision: null,
      dataVersion: 1,
      // Deliberately whitelist editable content. Legacy approval or workflow fields
      // belong to the application and never enter the recovery payload.
      payload: JSON.stringify({ body: legacy.body }),
      savedAt: legacy.savedAt,
    },
  };
}

/** Consumer-owned adapter for the example's `legacy:v1:` localStorage records. */
export function createLegacyAdapter(getStorage = () => globalThis.localStorage) {
  const read = (query, id) => {
    if (typeof id !== 'string' || !id.startsWith(legacyPrefix)) return null;
    return normalizeLegacyRecord(getStorage().getItem(id), id, query);
  };
  return {
    async list(query) {
      try {
        const storage = getStorage();
        const entries = [];
        for (let index = 0; index < storage.length; index++) {
          const id = storage.key(index);
          if (id?.startsWith(legacyPrefix)) {
            const normalized = normalizeLegacyRecord(storage.getItem(id), id, query);
            if (normalized) entries.push(normalized);
          }
        }
        return ok(entries);
      } catch { return unavailable(); }
    },
    async read(query, id) {
      try { return ok(read(query, id)); }
      catch { return unavailable(); }
    },
    async remove(query, id, revision) {
      try {
        const current = read(query, id);
        if (!current || current.revision !== revision) {
          return failure('permanent', 'candidate_changed', 'The legacy draft changed; refresh before cleanup.');
        }
        getStorage().removeItem(id);
        return ok(undefined);
      } catch { return unavailable(); }
    },
  };
}
