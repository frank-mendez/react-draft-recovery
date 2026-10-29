import { createAutosaveScheduler } from '../src/autosave.ts';
import type { DocumentSubmission, RecoveryController } from './index.ts';

type Article = { title: string };
/** Keep with the editor session across effect disconnect/reconnect. */
export interface BrowserAutosaveSession {
  documentUnresolved: boolean;
  readonly listeners: Set<() => void>;
}
export const createBrowserAutosaveSession = (): BrowserAutosaveSession => ({ documentUnresolved: false, listeners: new Set() });

/** Copy into an application and call from an effect after obtaining a controller. */
export function connectBrowserAutosave(controller: RecoveryController<Article>, browser: Window, session: BrowserAutosaveSession, maxRemoteBytes = 64 * 1024) {
  let connected = true;
  const scheduler = createAutosaveScheduler(controller, {
    debounceMs: 1000,
    online: browser.navigator.onLine,
    // Match the actual adapter's wire representation, including its envelope.
    validateRemote: value => new TextEncoder().encode(JSON.stringify({ value })).byteLength > maxRemoteBytes
      ? { kind: 'permanent', code: 'payload_too_large', message: 'Shorten the draft before remote recovery can save it.' }
      : null,
  });
  scheduler.setPaused(session.documentUnresolved);
  const needsConfirmation = () => {
    const state = controller.getSnapshot();
    return session.documentUnresolved || state.document.dirty || state.document.saving || state.dirty ||
      state.candidate.kind === 'available' || state.status === 'unknown' || state.status === 'conflict';
  };
  const pagehide = () => { void scheduler.flushLocal(); };
  const online = () => scheduler.setOnline(true);
  const offline = () => scheduler.setOnline(false);
  const beforeunload = (event: BeforeUnloadEvent) => {
    if (!needsConfirmation()) return;
    event.preventDefault();
    event.returnValue = ''; // Legacy browsers; the browser chooses the warning text.
  };
  browser.addEventListener('pagehide', pagehide);
  browser.addEventListener('online', online);
  browser.addEventListener('offline', offline);
  // Attach only while needed, reducing interference with the back/forward cache.
  const syncWarning = () => {
    scheduler.setPaused(session.documentUnresolved);
    browser.removeEventListener('beforeunload', beforeunload);
    if (connected && needsConfirmation()) browser.addEventListener('beforeunload', beforeunload);
  };
  session.listeners.add(syncWarning);
  const setDocumentGate = (blocked: boolean) => {
    session.documentUnresolved = blocked;
    for (const listener of session.listeners) listener();
  };
  const stop = controller.subscribe(syncWarning);
  syncWarning();
  return {
    scheduler,
    /** Call from your router's supported blocker/link/action integration. */
    async confirmNavigation(confirm: () => Promise<boolean>) {
      if (needsConfirmation() && !await confirm()) return false;
      // This example refuses navigation if local preservation failed. An app may
      // offer a second, explicit leave-without-saving choice instead.
      return (await scheduler.flushLocal()).kind === 'ok';
    },
    async saveDocument(submit: DocumentSubmission<Article>) {
      // Persist this gate with your editor session if it can outlive the effect.
      if (session.documentUnresolved) return { kind: 'permanent' as const, code: 'document_unresolved', message: 'Verify the previous document save first.' };
      setDocumentGate(true);
      const result = await controller.saveDocument(submit);
      setDocumentGate(result.kind === 'unknown');
      return result;
    },
    /** Only after the app has verified the server outcome and reconciled identity. */
    documentResolutionComplete() { setDocumentGate(false); },
    disconnect() {
      connected = false; session.listeners.delete(syncWarning); stop(); scheduler.dispose();
      browser.removeEventListener('pagehide', pagehide);
      browser.removeEventListener('online', online);
      browser.removeEventListener('offline', offline);
      browser.removeEventListener('beforeunload', beforeunload);
    },
  };
}
