// Anything else: the payer follows the operator's instructions and the operator
// approves the payment by hand.
import type { Account } from '../ledger.js';
import { fill, Method, type ClaimResult, type ManualConfig, type StoredInvoice } from './interface.js';

export class ManualMethod extends Method<ManualConfig> {
  info() {
    return { ...this.baseInfo('Manual payment'), description: this.config.description ?? 'Approved by the operator' };
  }

  async createInvoice(account: Account, credits: number): Promise<StoredInvoice> {
    const value = this.checkCredits(credits);
    const invoice = this.payments.newInvoice(account, this.config.id, value, this.expiry(), {});
    invoice.pay.instructions = fill(this.config.instructions, invoice);
    this.payments.changed();
    return invoice;
  }

  async claim(account: Account, body: Record<string, unknown>): Promise<ClaimResult> {
    const invoice = this.ownInvoice(account, body.invoiceId);
    if (invoice.status === 'open' || invoice.status === 'expired') {
      invoice.status = 'pending-review';
      invoice.note = String(body.note ?? '').slice(0, 500);
      this.payments.changed();
    }
    return { credited: 0, balance: account.balance, invoice };
  }
}
