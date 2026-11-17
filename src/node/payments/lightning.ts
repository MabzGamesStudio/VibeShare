// Bitcoin over Lightning: an LNbits wallet creates and checks invoices itself; a plain
// lightning address cannot, so the payer proves the payment and the operator confirms.
import { badRequest, HttpError, requestJson } from '../../shared/node/http.js';
import type { Account } from '../ledger.js';
import { formatUnits, Method, notPaid, requireAddress, unitsForCredits, type ClaimResult, type LightningConfig, type StoredInvoice } from './interface.js';

export class LightningMethod extends Method<LightningConfig> {
  /** Address mode needs no wallet API — that is the default when none is configured. */
  private get addressMode(): boolean {
    if (this.config.mode) return this.config.mode === 'address';
    return !(this.config.lnbitsUrl && this.config.invoiceKey);
  }

  info() {
    return {
      ...this.baseInfo('Bitcoin Lightning'),
      network: 'lightning',
      currency: 'BTC',
      rate: { credits: this.config.creditsPerCoin, per: '1 BTC' },
      description:
        this.config.description ?? (this.addressMode ? 'Pay a lightning address (sats); the operator confirms the transfer.' : undefined),
      // An LNbits wallet checks the payment itself; a plain lightning address cannot,
      // so the payer proves the payment and the operator confirms it.
      needsProof: this.addressMode,
      review: this.addressMode,
    };
  }

  async createInvoice(account: Account, credits: number): Promise<StoredInvoice> {
    const value = this.checkCredits(credits);
    const sats = unitsForCredits(value, this.config.creditsPerCoin, 8);
    const minutes = this.config.invoiceMinutes ?? 60;
    if (this.addressMode) {
      const address = requireAddress(this.config.label ?? this.config.id, this.config.address);
      const invoice = this.payments.newInvoice(account, this.config.id, value, this.expiry(), {
        address,
        amount: `${sats} sats`,
        currency: 'BTC',
        uri: `lightning:${address}`,
        instructions: `Pay exactly ${sats} satoshis (${formatUnits(sats, 8)} BTC) to ${address}, then paste the payment hash your wallet shows.`,
      });
      invoice.expectedUnits = sats.toString();
      this.payments.changed();
      return invoice;
    }
    const wallet = (this.config.lnbitsUrl ?? '').replace(/\/$/, '');
    if (!wallet || !this.config.invoiceKey) throw badRequest('This Lightning method needs an LNbits URL and invoice key, or a lightning address');
    const created = await requestJson<{ payment_hash: string; payment_request?: string; bolt11?: string }>(`${wallet}/api/v1/payments`, {
      body: { out: false, amount: Number(sats), memo: `${value} credits`, expiry: minutes * 60 },
      headers: { 'x-api-key': this.config.invoiceKey },
    });
    const request = created.payment_request ?? created.bolt11 ?? '';
    const invoice = this.payments.newInvoice(account, this.config.id, value, this.expiry(), {
      amount: formatUnits(sats, 8),
      currency: 'BTC',
      uri: `lightning:${request}`,
      address: request,
      instructions: `Pay the Lightning invoice (${sats} sats).`,
    });
    invoice.paymentHash = created.payment_hash;
    this.payments.changed();
    return invoice;
  }

  async claim(account: Account, body: Record<string, unknown>): Promise<ClaimResult> {
    const invoice = this.ownInvoice(account, body.invoiceId);
    if (invoice.status === 'paid') return { credited: 0, balance: account.balance, invoice };
    if (this.addressMode) {
      const proof = String(body.paymentHash ?? body.payment_hash ?? body.preimage ?? body.txid ?? body.txHash ?? '').trim();
      if (!proof) throw badRequest('Paste the payment hash (or preimage) your wallet shows for this payment');
      const key = `lightning:${proof.toLowerCase()}`;
      if (this.payments.data.used[key]) throw new HttpError(409, 'already_claimed', 'This payment was already claimed');
      this.payments.data.used[key] = invoice.id;
      invoice.tx = proof;
      invoice.note = String(body.note ?? '').slice(0, 500) || undefined;
      invoice.status = 'pending-review';
      this.payments.changed();
      return { credited: 0, balance: account.balance, invoice };
    }
    const wallet = (this.config.lnbitsUrl ?? '').replace(/\/$/, '');
    const status = await requestJson<{ paid: boolean }>(`${wallet}/api/v1/payments/${invoice.paymentHash}`, {
      headers: { 'x-api-key': this.config.invoiceKey ?? '' },
    });
    if (!status.paid) throw notPaid('The Lightning invoice is not paid yet');
    return this.payments.settle(invoice, `lightning:${invoice.paymentHash}`, invoice.paymentHash ?? '');
  }
}
