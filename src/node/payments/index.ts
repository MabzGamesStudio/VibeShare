// The payments module's public surface: the Payments class that runs the invoices,
// vouchers and routes, and the same exports payments.ts always had. The individual
// methods live in their own modules behind the PaymentMethod contract.
import { randomId, sha256hex } from '../../shared/crypto.js';
import { badRequest, HttpError, notFound, readBody, readJson, type Ctx, type Router } from '../../shared/node/http.js';
import { log } from '../../shared/node/log.js';
import { receiptSigningPayload, type Invoice, type PaymentMethodInfo, type PaymentReceipt, type PaymentType } from '../../shared/protocol.js';
import { JsonFile } from '../../shared/node/store.js';
import type { Auth } from '../auth.js';
import type { Account, Ledger } from '../ledger.js';
import { Method, type ClaimResult, type PaymentConfig, type PaymentsData, type StoredInvoice } from './interface.js';
import { VoucherMethod, voucherCode } from './voucher.js';
import { EvmMethod } from './evm.js';
import { BitcoinMethod } from './bitcoin.js';
import { MoneroMethod } from './monero.js';
import { SolanaMethod } from './solana.js';
import { LightningMethod } from './lightning.js';
import { CheckoutMethod } from './checkout.js';
import { ManualMethod } from './manual.js';

const METHOD_CLASSES: Record<PaymentType, new (config: never, payments: Payments) => Method> = {
  voucher: VoucherMethod,
  evm: EvmMethod,
  bitcoin: BitcoinMethod,
  monero: MoneroMethod,
  solana: SolanaMethod,
  lightning: LightningMethod,
  checkout: CheckoutMethod,
  manual: ManualMethod,
};

/** Every way a node sells credits, with the invoices and vouchers behind them. */
export class Payments {
  readonly data: PaymentsData;
  private store: JsonFile<PaymentsData>;
  private cache: { key: string; methods: Method[] } = { key: '', methods: [] };

  constructor(
    path: string | null,
    readonly ledger: Ledger,
    private readonly configs: () => PaymentConfig[],
    /** The node that issues receipts: its id, name and signing key. */
    private readonly issuer?: () => { id: string; name?: string; sign: (payload: string) => string }
  ) {
    this.store = new JsonFile<PaymentsData>(path, () => ({ invoices: {}, used: {}, vouchers: {} }));
    this.data = this.store.data;
  }

  changed(): void {
    this.store.changed();
  }

  flush(): void {
    this.store.flush();
  }

  methods(): Method[] {
    const configs = this.configs().filter((config) => config.enabled !== false);
    const key = JSON.stringify(configs);
    if (key !== this.cache.key) {
      const methods: Method[] = [];
      for (const config of configs) {
        const Class = METHOD_CLASSES[config.type];
        if (!Class) log.warn(`Unknown payment type ${(config as { type: string }).type}`);
        else methods.push(new Class(config as never, this));
      }
      this.cache = { key, methods };
    }
    return this.cache.methods;
  }

  info(): PaymentMethodInfo[] {
    return this.methods().map((method) => method.info());
  }

  method(id: string): Method {
    const method = this.methods().find((candidate) => candidate.config.id === id);
    if (!method) throw notFound(`No payment method ${id}`);
    return method;
  }

  invoice(id: string): StoredInvoice | undefined {
    const invoice = this.data.invoices[id];
    if (invoice?.status === 'open' && invoice.expiresAt && Date.parse(invoice.expiresAt) < Date.now()) {
      invoice.status = 'expired';
      this.changed();
    }
    return invoice;
  }

  openInvoices(method: string): StoredInvoice[] {
    return Object.values(this.data.invoices).filter(
      (invoice) => invoice.method === method && invoice.status === 'open' && this.invoice(invoice.id)?.status === 'open'
    );
  }

  newInvoice(account: Account, method: string, credits: number, expiresAt: string, pay: Invoice['pay']): StoredInvoice {
    const invoice: StoredInvoice = {
      id: randomId('inv-', 10),
      method,
      credits,
      status: 'open',
      createdAt: new Date().toISOString(),
      expiresAt,
      pay,
      accountId: account.id,
    };
    this.data.invoices[invoice.id] = invoice;
    this.changed();
    return invoice;
  }

  /** Marks an invoice paid and credits its account once. */
  settle(invoice: StoredInvoice, usedKey: string, tx: string, credits = invoice.credits): ClaimResult {
    if (this.data.used[usedKey]) throw new HttpError(409, 'already_claimed', 'This payment was already credited');
    if (invoice.status === 'paid') throw new HttpError(409, 'already_paid', 'This invoice is already paid');
    this.data.used[usedKey] = invoice.id;
    invoice.status = 'paid';
    invoice.tx = tx;
    invoice.credits = credits;
    invoice.settledAt = new Date().toISOString();
    this.changed();
    const account = this.ledger.credit(invoice.accountId, credits, `payment ${invoice.method}`, invoice.id);
    return { credited: credits, balance: account.balance, invoice: publicInvoice(invoice) };
  }

  /** The payment type behind a method id (also for methods that are switched off). */
  typeOf(methodId: string): PaymentType {
    return this.configs().find((config) => config.id === methodId)?.type ?? 'manual';
  }

  /**
   * The signed receipt of an invoice: what the operator asked to be paid (the transfer
   * request), the payer's proof of the transfer, and the credits granted. The node signs
   * it, so the payer can keep it as evidence — and check the signature later.
   */
  receiptFor(invoice: StoredInvoice, status: StoredInvoice['status'] = invoice.status): PaymentReceipt {
    const issuer = this.issuer?.();
    const receipt: Omit<PaymentReceipt, 'sig'> = {
      id: `rcpt-${invoice.id}`,
      invoiceId: invoice.id,
      method: invoice.method,
      type: this.typeOf(invoice.method),
      nodeId: issuer?.id ?? '',
      nodeName: issuer?.name,
      accountId: invoice.accountId,
      request: {
        credits: invoice.credits,
        address: invoice.pay.address,
        amount: invoice.pay.amount,
        currency: invoice.pay.currency,
        uri: invoice.pay.uri,
        instructions: invoice.pay.instructions,
        createdAt: invoice.createdAt,
        expiresAt: invoice.expiresAt,
      },
      tx: invoice.tx,
      note: invoice.note,
      credits: invoice.credits,
      status,
      settledAt: status === 'paid' || status === 'rejected' ? invoice.settledAt : undefined,
    };
    return issuer ? { ...receipt, sig: issuer.sign(receiptSigningPayload(receipt)) } : receipt;
  }

  createVouchers(credits: number, count: number, note?: string): string[] {
    const codes: string[] = [];
    for (let i = 0; i < count; i++) {
      const code = voucherCode();
      this.data.vouchers[sha256hex(code)] = { credits, createdAt: new Date().toISOString(), note };
      codes.push(code);
    }
    this.changed();
    return codes;
  }

  routes(router: Router, auth: Auth, requireAdmin: (ctx: Ctx) => void): void {
    router.get('/v1/payments', () => ({ methods: this.info() }));
    router.post('/v1/payments/:method/invoices', async (ctx) => {
      const account = auth.require(ctx);
      const body = await readJson<{ credits?: number }>(ctx.req);
      return publicInvoice(await this.method(ctx.params.method).createInvoice(account, Number(body.credits)));
    });
    router.get('/v1/payments/invoices/:id', (ctx) => {
      const account = auth.require(ctx);
      const invoice = this.invoice(ctx.params.id);
      if (!invoice || invoice.accountId !== account.id) throw notFound('No such invoice');
      return publicInvoice(invoice);
    });
    // The signed receipt of the payment request and of what was credited.
    router.get('/v1/payments/invoices/:id/receipt', (ctx) => {
      const account = auth.require(ctx);
      const invoice = this.invoice(ctx.params.id);
      if (!invoice || invoice.accountId !== account.id) throw notFound('No such invoice');
      return { receipt: this.receiptFor(invoice) };
    });
    router.post('/v1/payments/:method/claim', async (ctx) => {
      const account = auth.require(ctx);
      const body = await readJson<Record<string, unknown>>(ctx.req);
      const result = await this.method(ctx.params.method).claim(account, body);
      return { ...result, invoice: result.invoice ? publicInvoice(result.invoice as StoredInvoice) : undefined };
    });
    router.post('/v1/payments/:method/webhook', async (ctx) => {
      const raw = await readBody(ctx.req, 256 * 1024);
      const result = await this.method(ctx.params.method).webhook(raw, ctx.req.headers);
      return { ok: true, result };
    });

    router.get('/v1/admin/invoices', (ctx) => {
      requireAdmin(ctx);
      const status = ctx.query.get('status');
      const invoices = Object.values(this.data.invoices)
        .filter((invoice) => !status || invoice.status === status)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 500);
      return { invoices };
    });
    router.post('/v1/admin/invoices/:id/approve', async (ctx) => {
      requireAdmin(ctx);
      const invoice = this.invoice(ctx.params.id);
      if (!invoice) throw notFound('No such invoice');
      const body = await readJson<{ credits?: number }>(ctx.req);
      return this.settle(invoice, `manual:${invoice.id}`, 'approved', body.credits ?? invoice.credits);
    });
    router.post('/v1/admin/invoices/:id/reject', (ctx) => {
      requireAdmin(ctx);
      const invoice = this.invoice(ctx.params.id);
      if (!invoice) throw notFound('No such invoice');
      if (invoice.status === 'paid') throw badRequest('The invoice is already paid');
      invoice.status = 'rejected';
      invoice.settledAt = new Date().toISOString();
      // Nothing was accepted here, so the payer's proof can be claimed again.
      for (const [key, id] of Object.entries(this.data.used)) if (id === invoice.id) delete this.data.used[key];
      this.changed();
      return publicInvoice(invoice);
    });
    router.post('/v1/admin/vouchers', async (ctx) => {
      requireAdmin(ctx);
      const body = await readJson<{ credits?: number; count?: number; note?: string }>(ctx.req);
      const credits = Math.floor(Number(body.credits));
      const count = Math.min(Math.max(Math.floor(Number(body.count ?? 1)), 1), 1000);
      if (!(credits > 0)) throw badRequest('credits must be positive');
      return { codes: this.createVouchers(credits, count, body.note) };
    });
    router.get('/v1/admin/vouchers', (ctx) => {
      requireAdmin(ctx);
      const vouchers = Object.values(this.data.vouchers).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return {
        total: vouchers.length,
        redeemed: vouchers.filter((voucher) => voucher.redeemedBy).length,
        recent: vouchers.slice(0, 200),
      };
    });
  }
}

export function publicInvoice(invoice: StoredInvoice | Invoice): Invoice {
  const { id, method, credits, status, createdAt, expiresAt, pay } = invoice;
  return { id, method, credits, status, createdAt, expiresAt, pay };
}

// The same public surface payments.ts always had, so every import path keeps working.
export {
  DEFAULT_ESPLORA,
  defaultEvmRpc,
  defaultCryptoPaymentConfigs,
  assertNoPaymentSecrets,
  formatUnits,
  unitsForCredits,
} from './interface.js';
export type {
  VoucherConfig,
  EvmConfig,
  BitcoinConfig,
  MoneroConfig,
  SolanaConfig,
  LightningConfig,
  CheckoutConfig,
  ManualConfig,
  PaymentConfig,
  StoredInvoice,
  ClaimResult,
} from './interface.js';
export { voucherCode } from './voucher.js';
