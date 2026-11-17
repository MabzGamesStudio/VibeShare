/**
 * Monero. A node never receives a view key (that is a private key) and Monero amounts
 * are hidden without one, so nothing can be checked from here: the invoice names the
 * exact amount and the operator's address, the payer sends the transfer and pastes its
 * transaction id, and the operator confirms it in their own wallet.
 */
import { badRequest, HttpError } from '../../shared/node/http.js';
import type { Account } from '../ledger.js';
import { ExactAmountMethod, formatUnits, notPaid, type ClaimResult, type MoneroConfig, type StoredInvoice } from './interface.js';

export class MoneroMethod extends ExactAmountMethod<MoneroConfig> {
  decimals(): number {
    return 12;
  }
  currency(): string {
    return 'XMR';
  }
  info() {
    return {
      ...this.baseInfo('Monero'),
      network: this.config.network ?? 'monero',
      currency: 'XMR',
      rate: { credits: this.config.creditsPerCoin, per: '1 XMR' },
      needsProof: true,
      review: true,
    };
  }
  paymentUri(_invoice: StoredInvoice, units: bigint): string {
    return `monero:${this.address()}?tx_amount=${formatUnits(units, 12)}`;
  }

  async verify(): Promise<number | null> {
    throw notPaid('Monero transfers are confirmed by the operator');
  }

  async claim(account: Account, body: Record<string, unknown>): Promise<ClaimResult> {
    const invoice = this.ownInvoice(account, body.invoiceId);
    if (invoice.status === 'paid') return { credited: 0, balance: account.balance, invoice };
    const tx = String(body.txid ?? body.txHash ?? body.tx ?? '').trim();
    if (!tx) throw badRequest('Paste the Monero transaction id so the operator can check the transfer');
    const key = `monero:${tx.toLowerCase()}`;
    if (this.payments.data.used[key]) throw new HttpError(409, 'already_claimed', 'This transaction was already claimed');
    this.payments.data.used[key] = invoice.id;
    invoice.tx = tx;
    invoice.note = String(body.note ?? '').slice(0, 500) || undefined;
    invoice.status = 'pending-review';
    this.payments.changed();
    return { credited: 0, balance: account.balance, invoice };
  }
}
