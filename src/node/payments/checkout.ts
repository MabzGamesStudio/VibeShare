// Any hosted checkout (Stripe Payment Links, Ko-fi, Gumroad, BTCPay, Coinbase
// Commerce, PayPal…) that can call a webhook to confirm the payment.
import { hmacHex, safeEqual } from '../../shared/crypto.js';
import { forbidden, notFound, type Ctx } from '../../shared/node/http.js';
import type { Account } from '../ledger.js';
import { fill, Method, notPaid, type CheckoutConfig, type ClaimResult, type StoredInvoice } from './interface.js';

export class CheckoutMethod extends Method<CheckoutConfig> {
  info() {
    return {
      ...this.baseInfo(`Pay with ${this.config.currency}`),
      currency: this.config.currency,
      rate: { credits: this.config.creditsPerUnit, per: `1 ${this.config.currency}` },
    };
  }

  async createInvoice(account: Account, credits: number): Promise<StoredInvoice> {
    const value = this.checkCredits(credits);
    const invoice = this.payments.newInvoice(account, this.config.id, value, this.expiry(), {});
    invoice.pay.checkoutUrl = fill(this.config.checkoutUrl, invoice);
    invoice.pay.amount = (value / this.config.creditsPerUnit).toFixed(2);
    invoice.pay.currency = this.config.currency;
    invoice.pay.instructions = 'Complete the checkout; credits arrive as soon as the payment is confirmed.';
    this.payments.changed();
    return invoice;
  }

  async claim(account: Account, body: Record<string, unknown>): Promise<ClaimResult> {
    const invoice = this.ownInvoice(account, body.invoiceId);
    if (invoice.status !== 'paid') throw notPaid('No payment has been confirmed for this invoice yet');
    return { credited: 0, balance: this.payments.ledger.require(account.id).balance, invoice };
  }

  async webhook(raw: Buffer, headers: Ctx['req']['headers']): Promise<unknown> {
    if (this.config.format === 'stripe') return this.stripe(raw, String(headers['stripe-signature'] ?? ''));
    const signature = String(headers['x-vs-signature'] ?? '');
    if (!safeEqual(signature, hmacHex(this.config.secret, raw))) throw forbidden('Bad webhook signature');
    const event = JSON.parse(raw.toString('utf8')) as { eventId?: string; invoice?: string; amount?: number; credits?: number };
    const invoice = this.payments.invoice(String(event.invoice ?? ''));
    if (!invoice || invoice.method !== this.config.id) throw notFound('No such invoice');
    const credits = event.credits ?? Math.floor((event.amount ?? 0) * this.config.creditsPerUnit);
    return this.payments.settle(invoice, `checkout:${event.eventId ?? invoice.id}`, String(event.eventId ?? ''), credits);
  }

  private stripe(raw: Buffer, header: string): unknown {
    const parts = Object.fromEntries(header.split(',').map((part) => part.split('=') as [string, string]));
    const expected = hmacHex(this.config.secret, `${parts.t}.${raw.toString('utf8')}`);
    if (!parts.t || !parts.v1 || !safeEqual(parts.v1, expected)) throw forbidden('Bad Stripe signature');
    if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 600) throw forbidden('Stale Stripe event');
    const event = JSON.parse(raw.toString('utf8')) as {
      id: string;
      type: string;
      data: { object: { client_reference_id?: string; amount_total?: number; payment_status?: string } };
    };
    if (event.type !== 'checkout.session.completed' || event.data.object.payment_status === 'unpaid') return { ignored: true };
    const invoice = this.payments.invoice(String(event.data.object.client_reference_id ?? ''));
    if (!invoice || invoice.method !== this.config.id) throw notFound('No such invoice');
    const credits = Math.floor(((event.data.object.amount_total ?? 0) / 100) * this.config.creditsPerUnit);
    return this.payments.settle(invoice, `stripe:${event.id}`, event.id, credits);
  }
}
