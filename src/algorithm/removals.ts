// The content removal requests waiting for the operator's review. A creator's own ask
// never lands here — their content is deleted at once — so every record is one verdict
// to give. The queue is a small file of its own, so nothing else moves when it does.
import { randomId } from '../shared/crypto.js';
import type { RemovalRequest } from '../shared/protocol.js';
import { JsonFile } from '../shared/node/store.js';

export class RemovalQueue {
  private readonly file: JsonFile<{ requests: Record<string, RemovalRequest> }>;

  constructor(path: string | null) {
    this.file = new JsonFile(path, () => ({ requests: {} }));
  }

  /** Whether this account already has this content's removal waiting. */
  has(account: string, cid: string): boolean {
    return Object.values(this.file.data.requests).some((request) => request.cid === cid && request.account === account);
  }

  /** Queues one request; the caller checks for duplicates first (see has). */
  queue(input: { cid: string; account: string; message?: string }): RemovalRequest {
    const request: RemovalRequest = {
      id: randomId('rem-', 8),
      cid: input.cid,
      account: input.account,
      ...(input.message ? { message: input.message } : {}),
      at: new Date().toISOString(),
      status: 'pending',
    };
    this.file.data.requests[request.id] = request;
    this.file.changed();
    return request;
  }

  /** Every request waiting for a verdict, newest first. */
  pending(): RemovalRequest[] {
    return Object.values(this.file.data.requests).sort((a, b) => b.at.localeCompare(a.at));
  }

  get(id: string): RemovalRequest | undefined {
    return this.file.data.requests[id];
  }

  /** Drops one request (the operator rejected it). */
  drop(id: string): void {
    delete this.file.data.requests[id];
    this.file.changed();
  }

  /** Drops every request about one content: once the content is gone, they are moot. */
  dropContent(cid: string): void {
    for (const request of Object.values(this.file.data.requests)) {
      if (request.cid === cid) delete this.file.data.requests[request.id];
    }
    this.file.changed();
  }
}
