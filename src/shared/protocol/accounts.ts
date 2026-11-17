// Accounts, sessions, credits and payment invoices/receipts. Browser-safe.
import type { PaymentMethodInfo, PaymentType } from './info.js';

// ---------------------------------------------------------------------------
// Accounts and credits (each node keeps its own, independent ledger)

export interface SessionResponse {
  token: string;
  accountId: string;
  expiresAt?: string;
  balance: number;
}

export interface AccountView {
  id: string;
  kind: 'anonymous' | 'key';
  balance: number;
  earned: number;
  spent: number;
  createdAt: string;
}

export interface LedgerEntry {
  at: string;
  amount: number;
  balance: number;
  reason: string;
  ref?: string;
}

export interface Invoice {
  id: string;
  method: string;
  credits: number;
  status: 'open' | 'paid' | 'expired' | 'pending-review' | 'rejected';
  createdAt: string;
  expiresAt?: string;
  pay: {
    address?: string;
    amount?: string;
    currency?: string;
    /** e.g. ethereum:, bitcoin:, solana: or lightning: URI for wallets. */
    uri?: string;
    checkoutUrl?: string;
    instructions?: string;
  };
}

/**
 * A payment receipt: what the node operator asked to be paid (the transfer request)
 * plus, once the payment is made, the credits granted and the client's own proof of
 * the transaction. The node signs it, so the client can keep it as evidence.
 */
export interface PaymentReceipt {
  id: string;
  invoiceId: string;
  method: string;
  type: PaymentType;
  /** The node that asked for the payment and signed the receipt. */
  nodeId: string;
  nodeName?: string;
  /** The account that pays (or asked for the invoice). */
  accountId: string;
  /** The payment request as the operator issued it. */
  request: {
    credits: number;
    address?: string;
    amount?: string;
    currency?: string;
    uri?: string;
    instructions?: string;
    createdAt: string;
    expiresAt?: string;
  };
  /** The client's proof of the transfer: a transaction id, payment hash or note. */
  tx?: string;
  note?: string;
  credits: number;
  status: 'open' | 'pending-review' | 'paid' | 'expired' | 'rejected';
  /** When the credits were granted (or the review decision was made). */
  settledAt?: string;
  /** The operator's signature over `receiptSigningPayload` of this receipt. */
  sig?: string;
}

/** The canonical text a receipt signature covers (everything but the signature). */
export function receiptSigningPayload(receipt: Omit<PaymentReceipt, 'sig'>): string {
  return (
    'vibeshare-receipt\n' +
    JSON.stringify([
      receipt.id,
      receipt.invoiceId,
      receipt.method,
      receipt.type,
      receipt.nodeId,
      receipt.accountId,
      receipt.request.credits,
      receipt.request.address ?? '',
      receipt.request.amount ?? '',
      receipt.request.currency ?? '',
      receipt.request.createdAt,
      receipt.tx ?? '',
      receipt.credits,
      receipt.status,
      receipt.settledAt ?? '',
    ])
  );
}
