import type { DocumentSaveResult, DocumentSubmission, RecoveryController } from './index.js';

type Article = { title: string };
/** App-owned policy. Approval applies to the exact snapshot shown to the human. */
export async function publishArticle(
  recovery: RecoveryController<Article>,
  approve: (article: Article) => Promise<boolean>,
  publish: DocumentSubmission<Article>,
): Promise<DocumentSaveResult<Article>> {
  return recovery.saveDocument(async request => {
    if (!request.value.title.trim()) {
      return { kind: 'permanent', code: 'validation_failed', message: 'A title is required.' };
    }
    // Remote recovery stays paused while the dialog is open; local edits persist.
    if (!await approve(request.value)) {
      return { kind: 'permanent', code: 'approval_required', message: 'Publication was not approved.' };
    }
    // The server must independently enforce authorization, editorial policy and
    // document.version concurrency. Its response is the new document ID/version.
    return publish(request);
  });
}
