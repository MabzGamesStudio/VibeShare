// Receipts the client keeps for itself: every payment request a node issued, the proof
// of the transfer the client made, the credits the node granted, and the node's
// signature over all of it. They live in the client's own store — nothing is uploaded.
import { verifySignature } from '../shared/crypto.js';
import { receiptSigningPayload, type PaymentReceipt } from '../shared/protocol.js';
import type { ClientStoreLike } from './model.js';

export interface StoredReceipt extends PaymentReceipt {
  /** When this client saved (or last refreshed) it. */
  savedAt: string;
  /** Whether the node's signature checks out against the contents. */
  verified: boolean;
}

/** The maximum number of receipts kept on this device (newest first). */
const MAX_RECEIPTS = 500;

function signatureOk(receipt: PaymentReceipt): boolean {
  if (!receipt.sig || !receipt.nodeId) return false;
  const { sig, ...unsigned } = receipt;
  try {
    return verifySignature(receipt.nodeId, receiptSigningPayload(unsigned), sig);
  } catch {
    return false;
  }
}

/** Saves a receipt (or refreshes the one for that invoice) after checking its signature. */
export function recordReceipt(store: ClientStoreLike, receipt: PaymentReceipt): StoredReceipt {
  const book = store.receipts.data;
  const stored: StoredReceipt = { ...receipt, savedAt: new Date().toISOString(), verified: signatureOk(receipt) };
  book.receipts = [stored, ...(book.receipts ?? []).filter((entry) => entry.id !== receipt.id)].slice(0, MAX_RECEIPTS);
  store.receipts.changed();
  return stored;
}

export function listReceipts(store: ClientStoreLike): StoredReceipt[] {
  return store.receipts.data.receipts ?? [];
}

export function removeReceipt(store: ClientStoreLike, id: string): boolean {
  const book = store.receipts.data;
  const before = (book.receipts ?? []).length;
  book.receipts = (book.receipts ?? []).filter((entry) => entry.id !== id);
  if (book.receipts.length === before) return false;
  store.receipts.changed();
  return true;
}

