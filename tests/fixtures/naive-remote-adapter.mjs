// Deliberately nonconforming: conditional row writes, nullable absence, and
// current-row operation recognition. This is a negative control, not an adapter.
export function createNaiveFixture() {
  const rows = new Map();
  const deniedUsers = new Set();
  let validationAllowed = true;
  let revision = 0;
  const key = s => JSON.stringify([s.userId, s.documentId, s.editorId]);
  const read = s => rows.get(key(s))?.snapshot ?? { kind: 'absent', revision: 'missing' };
  const denied = () => ({ kind: 'permanent', code: 'forbidden', message: 'Denied' });
  return {
    setAuthorized(user, allowed) { allowed ? deniedUsers.delete(user) : deniedUsers.add(user); },
    setValidationAllowed(allowed) { validationAllowed = allowed; },
    advanceTime() {},
    adapterFor(principal) {
      const allowed = scope => principal === scope.userId && !deniedUsers.has(principal);
      const mutate = (kind, req) => {
        if (!allowed(req.scope)) return denied();
        const row = rows.get(key(req.scope));
        if (row?.operationId === req.operationId) return { kind: 'ok', value: row.snapshot };
        if (kind === 'save' && !validationAllowed) return denied();
        const current = read(req.scope);
        if (req.expectedRevision !== current.revision) return { kind: 'conflict', current };
        if (kind === 'discard') {
          rows.delete(key(req.scope));
          return { kind: 'ok', value: read(req.scope) };
        }
        const snapshot = { kind: 'present', revision: String(++revision), value: structuredClone(req.value) };
        rows.set(key(req.scope), { snapshot, operationId: req.operationId });
        return { kind: 'ok', value: snapshot };
      };
      return {
        replayWindowMs: 60_000,
        async load(scope) { return allowed(scope) ? { kind: 'ok', value: read(scope) } : denied(); },
        async save(req) { return mutate('save', req); },
        async discard(req) { return mutate('discard', req); },
      };
    },
  };
}
