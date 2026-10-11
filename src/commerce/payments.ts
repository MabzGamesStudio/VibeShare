import { randomBytes } from 'node:crypto';
import { hmacHex, randomId, safeEqual, sha256hex } from '../shared/crypto.js';
import { base32Encode } from '../shared/encoding.js';
import {
  badRequest,
  forbidden,
  HttpError,
  notFound,
  readBody,
  readJson,
  requestJson,
  type Ctx,
  type Router,
} from '../shared/http.js';
import { log } from '../shared/log.js';
import type { Invoice, PaymentMethodInfo, PaymentType } from '../shared/protocol.js';
import { JsonFile } from '../shared/store.js';
import type { Auth } from './auth.js';
import type { Account, Ledger } from './ledger.js';

// ---------------------------------------------------------------------------
// Configuration of each payment method a node accepts

interface BaseMethodConfig {
  /** Unique per node; appears in URLs. */
  id: string;
  type: PaymentType;
  label?: string;
  description?: string;
  enabled?: boolean;
  minCredits?: number;
  maxCredits?: number;
  /** Minutes an invoice stays open (default 60). */
  invoiceMinutes?: number;
}

/** Redeem codes the operator sells or gives away anywhere (shop, gift cards, events). */
export interface VoucherConfig extends BaseMethodConfig {
  type: 'voucher';
}

/** Ether or an ERC-20 token on any EVM chain (Ethereum, Base, Arbitrum, Polygon, …), checked over JSON-RPC. */
export interface EvmConfig extends BaseMethodConfig {
  type: 'evm';
  network: string;
  chainId?: number;
  rpcUrl: string;
  address: string;
  currency: string;
  decimals: number;
  /** ERC-20 contract address; omit for the chain's native coin. */
  token?: string;
  /** Credits for one whole coin/token. */
  creditsPerCoin: number;
  confirmations?: number;
}

/** On-chain bitcoin, checked with an Esplora API (mempool.space, blockstream.info or self-hosted). */
export interface BitcoinConfig extends BaseMethodConfig {
  type: 'bitcoin';
  network?: string;
  apiUrl: string;
  address: string;
  creditsPerCoin: number;
  confirmations?: number;
}

/** SOL or an SPL token (USDC, …), checked over Solana JSON-RPC. */
export interface SolanaConfig extends BaseMethodConfig {
  type: 'solana';
  rpcUrl: string;
  address: string;
  currency: string;
  /** SPL token mint; omit for SOL. */
  mint?: string;
  decimals?: number;
  creditsPerCoin: number;
}

/** Bitcoin over Lightning through an LNbits wallet. */
export interface LightningConfig extends BaseMethodConfig {
  type: 'lightning';
  lnbitsUrl: string;
  invoiceKey: string;
  /** Credits for one bitcoin (100,000,000 sats). */
  creditsPerCoin: number;
}

/**
 * Any hosted checkout (Stripe Payment Links, Ko-fi, Gumroad, BTCPay, Coinbase Commerce, PayPal…)
 * that can call a webhook. `checkoutUrl` may contain {invoice}, {account} and {credits}.
 */
export interface CheckoutConfig extends BaseMethodConfig {
  type: 'checkout';
  checkoutUrl: string;
  /** Shared secret used to check webhook signatures. */
  secret: string;
  format?: 'generic' | 'stripe';
  /** Credits per 1.00 of the currency paid. */
  creditsPerUnit: number;
  currency: string;
}

/** Anything else: the operator checks the payment and approves it by hand. */
export interface ManualConfig extends BaseMethodConfig {
  type: 'manual';
  /** Shown to the payer; may contain {invoice}, {account} and {credits}. */
  instructions: string;
}

export type PaymentConfig =
  | VoucherConfig
  | EvmConfig
  | BitcoinConfig
  | SolanaConfig
  | LightningConfig
  | CheckoutConfig
  | ManualConfig;

// ---------------------------------------------------------------------------
// Stored state

export interface StoredInvoice extends Invoice {
  accountId: string;
  /** Exact amount expected, in the smallest unit (wei, sats, lamports). */
  expectedUnits?: string;
  paymentHash?: string;
  tx?: string;
  note?: string;
}

interface Voucher {
  credits: number;
  createdAt: string;
  note?: string;
  redeemedBy?: string;
  redeemedAt?: string;
}

interface PaymentsData {
  invoices: Record<string, StoredInvoice>;
  /** Transactions / events already credited, to stop double claims. */
  used: Record<string, string>;
  /** Vouchers by sha256 of the code. */
  vouchers: Record<string, Voucher>;
}

export interface ClaimResult {
  credited: number;
  balance: number;
  invoice?: Invoice;
}

// ---------------------------------------------------------------------------
// Helpers

export function formatUnits(units: bigint, decimals: number): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const fraction = (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? '.' + fraction : ''}`;
}

/** Smallest units for `credits` at `creditsPerCoin`, rounded up. */
export function unitsForCredits(credits: number, creditsPerCoin: number, decimals: number): bigint {
  const numerator = BigInt(Math.floor(credits)) * 10n ** BigInt(decimals) * 1000n;
  const denominator = BigInt(Math.round(creditsPerCoin * 1000));
  return (numerator + denominator - 1n) / denominator;
}

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const response = await requestJson<{ result?: T; error?: { message: string } }>(url, {
    body: { jsonrpc: '2.0', id: 1, method, params },
    timeoutMs: 20000,
  });
  if (response.error) throw new HttpError(502, 'rpc_error', `${method}: ${response.error.message}`);
  return response.result as T;
}

function fill(template: string, invoice: StoredInvoice): string {
  return template
    .replaceAll('{invoice}', encodeURIComponent(invoice.id))
    .replaceAll('{account}', encodeURIComponent(invoice.accountId))
    .replaceAll('{credits}', String(invoice.credits));
}

const notPaid = (message: string) => new HttpError(409, 'not_paid', message);

// ---------------------------------------------------------------------------
// Methods

abstract class Method<C extends PaymentConfig = PaymentConfig> {
  constructor(
    readonly config: C,
    protected readonly payments: Payments
  ) {}

  abstract info(): PaymentMethodInfo;

  protected baseInfo(defaultLabel: string): PaymentMethodInfo {
    return {
      id: this.config.id,
      type: this.config.type,
      label: this.config.label ?? defaultLabel,
      description: this.config.description,
      minCredits: this.config.minCredits,
      maxCredits: this.config.maxCredits,
    };
  }

  async createInvoice(_account: Account, _credits: number): Promise<StoredInvoice> {
    throw badRequest(`${this.config.id} does not use invoices`);
  }

  abstract claim(account: Account, body: Record<string, unknown>): Promise<ClaimResult>;

  async webhook(_raw: Buffer, _headers: Ctx['req']['headers']): Promise<unknown> {
    throw notFound('This payment method has no webhook');
  }

  protected checkCredits(credits: unknown): number {
    const value = Math.floor(Number(credits));
    if (!Number.isFinite(value) || value <= 0) throw badRequest('credits must be a positive number');
    if (this.config.minCredits && value < this.config.minCredits) throw badRequest(`At least ${this.config.minCredits} credits`);
    if (this.config.maxCredits && value > this.config.maxCredits) throw badRequest(`At most ${this.config.maxCredits} credits`);
    return value;
  }

  protected ownInvoice(account: Account, invoiceId: unknown): StoredInvoice {
    const invoice = this.payments.invoice(String(invoiceId ?? ''));
    if (!invoice || invoice.accountId !== account.id || invoice.method !== this.config.id) throw notFound('No such invoice');
    return invoice;
  }

  protected expiry(): string {
    return new Date(Date.now() + (this.config.invoiceMinutes ?? 60) * 60_000).toISOString();
  }
}

class VoucherMethod extends Method<VoucherConfig> {
  info() {
    return { ...this.baseInfo('Voucher code'), description: this.config.description ?? 'Redeem a code from the operator' };
  }

  async claim(account: Account, body: Record<string, unknown>): Promise<ClaimResult> {
    const code = String(body.code ?? '')
      .trim()
      .toUpperCase();
    if (!code) throw badRequest('code is required');
    const voucher = this.payments.data.vouchers[sha256hex(code)];
    if (!voucher) throw notFound('Unknown voucher code');
    if (voucher.redeemedBy) throw new HttpError(409, 'already_redeemed', 'This voucher was already redeemed');
    voucher.redeemedBy = account.id;
    voucher.redeemedAt = new Date().toISOString();
    this.payments.changed();
    const updated = this.payments.ledger.credit(account.id, voucher.credits, 'voucher', code.slice(0, 7));
    return { credited: voucher.credits, balance: updated.balance };
  }
}

/** Invoices whose exact amount identifies the payer: base amount plus a small unique tail. */
abstract class ExactAmountMethod<C extends EvmConfig | BitcoinConfig | SolanaConfig> extends Method<C> {
  abstract decimals(): number;
  abstract currency(): string;
  abstract paymentUri(invoice: StoredInvoice, units: bigint): string;

  async createInvoice(account: Account, credits: number): Promise<StoredInvoice> {
    const value = this.checkCredits(credits);
    const base = unitsForCredits(value, this.config.creditsPerCoin, this.decimals());
    const tailMax = base / 1000n > 1000n ? base / 1000n : 1000n;
    const open = new Set(
      this.payments
        .openInvoices(this.config.id)
        .map((invoice) => invoice.expectedUnits)
        .filter(Boolean)
    );
    let units = base;
    do {
      units = base + 1n + (BigInt('0x' + randomBytes(8).toString('hex')) % tailMax);
    } while (open.has(units.toString()));
    const amount = formatUnits(units, this.decimals());
    const invoice = this.payments.newInvoice(account, this.config.id, value, this.expiry(), {
      address: this.config.address,
      amount,
      currency: this.currency(),
      instructions: `Send exactly ${amount} ${this.currency()} to ${this.config.address}, then paste the transaction id.`,
    });
    invoice.expectedUnits = units.toString();
    invoice.pay.uri = this.paymentUri(invoice, units);
    this.payments.changed();
    return invoice;
  }

  async claim(account: Account, body: Record<string, unknown>): Promise<ClaimResult> {
    const invoice = this.ownInvoice(account, body.invoiceId);
    if (invoice.status === 'paid') return { credited: 0, balance: account.balance, invoice };
    const tx = String(body.txHash ?? body.txid ?? body.signature ?? '').trim();
    if (!tx) throw badRequest('txHash is required');
    const key = `${this.config.type}:${tx.toLowerCase()}`;
    if (this.payments.data.used[key]) throw new HttpError(409, 'already_claimed', 'This transaction was already claimed');
    const paidAt = await this.verify(tx, BigInt(invoice.expectedUnits ?? '0'));
    const created = Date.parse(invoice.createdAt);
    if (paidAt !== null && (paidAt < created - 5 * 60_000 || paidAt > Date.parse(invoice.expiresAt ?? '') + 24 * 3600_000)) {
      throw notPaid('The transaction is outside the invoice window');
    }
    return this.payments.settle(invoice, key, tx);
  }

  /** Checks the transaction and returns its time in ms (null when unknown); throws when it does not pay the invoice. */
  abstract verify(tx: string, units: bigint): Promise<number | null>;
}

const ERC20_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

class EvmMethod extends ExactAmountMethod<EvmConfig> {
  decimals() {
    return this.config.decimals;
  }
  currency() {
    return this.config.currency;
  }
  info() {
    return {
      ...this.baseInfo(`${this.config.currency} on ${this.config.network}`),
      network: this.config.network,
      currency: this.config.currency,
      rate: { credits: this.config.creditsPerCoin, per: `1 ${this.config.currency}` },
    };
  }

  paymentUri(_invoice: StoredInvoice, units: bigint): string {
    const chain = this.config.chainId ? `@${this.config.chainId}` : '';
    if (this.config.token) return `ethereum:${this.config.token}${chain}/transfer?address=${this.config.address}&uint256=${units}`;
    return `ethereum:${this.config.address}${chain}?value=${units}`;
  }

  async verify(txHash: string, units: bigint): Promise<number | null> {
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw badRequest('Not a transaction hash');
    const url = this.config.rpcUrl;
    const receipt = await rpc<{ status: string; blockNumber: string; logs: { address: string; topics: string[]; data: string }[] } | null>(
      url,
      'eth_getTransactionReceipt',
      [txHash]
    );
    if (!receipt) throw notPaid('The transaction is not mined yet');
    if (receipt.status !== '0x1') throw notPaid('The transaction failed');
    const address = this.config.address.toLowerCase();
    if (this.config.token) {
      const token = this.config.token.toLowerCase();
      const paid = receipt.logs.some(
        (entry) =>
          entry.address.toLowerCase() === token &&
          entry.topics[0] === ERC20_TRANSFER &&
          entry.topics[2]?.toLowerCase().endsWith(address.slice(2)) &&
          BigInt(entry.data) === units
      );
      if (!paid) throw notPaid('The transaction does not transfer the invoice amount to this node');
    } else {
      const tx = await rpc<{ to: string | null; value: string } | null>(url, 'eth_getTransactionByHash', [txHash]);
      if (!tx || tx.to?.toLowerCase() !== address || BigInt(tx.value) !== units) {
        throw notPaid('The transaction does not send the invoice amount to this node');
      }
    }
    const head = BigInt(await rpc<string>(url, 'eth_blockNumber', []));
    const confirmations = head - BigInt(receipt.blockNumber) + 1n;
    if (confirmations < BigInt(this.config.confirmations ?? 1)) {
      throw notPaid(`Waiting for confirmations (${confirmations}/${this.config.confirmations ?? 1})`);
    }
    const block = await rpc<{ timestamp: string } | null>(url, 'eth_getBlockByNumber', [receipt.blockNumber, false]);
    return block ? Number(BigInt(block.timestamp)) * 1000 : null;
  }
}

class BitcoinMethod extends ExactAmountMethod<BitcoinConfig> {
  decimals() {
    return 8;
  }
  currency() {
    return 'BTC';
  }
  info() {
    return {
      ...this.baseInfo('Bitcoin'),
      network: this.config.network ?? 'bitcoin',
      currency: 'BTC',
      rate: { credits: this.config.creditsPerCoin, per: '1 BTC' },
    };
  }
  paymentUri(_invoice: StoredInvoice, units: bigint): string {
    return `bitcoin:${this.config.address}?amount=${formatUnits(units, 8)}`;
  }

  async verify(txid: string, units: bigint): Promise<number | null> {
    if (!/^[0-9a-fA-F]{64}$/.test(txid)) throw badRequest('Not a bitcoin transaction id');
    const api = this.config.apiUrl.replace(/\/$/, '');
    const tx = await requestJson<{
      vout: { scriptpubkey_address?: string; value: number }[];
      status: { confirmed: boolean; block_height?: number; block_time?: number };
    }>(`${api}/tx/${txid}`);
    const paid = tx.vout.some((out) => out.scriptpubkey_address === this.config.address && BigInt(out.value) === units);
    if (!paid) throw notPaid('The transaction does not pay the invoice amount to this node');
    const needed = this.config.confirmations ?? 1;
    if (needed > 0) {
      if (!tx.status.confirmed || tx.status.block_height === undefined) throw notPaid('Waiting for the transaction to confirm');
      const tip = Number(await (await fetch(`${api}/blocks/tip/height`, { signal: AbortSignal.timeout(15000) })).text());
      const confirmations = tip - tx.status.block_height + 1;
      if (confirmations < needed) throw notPaid(`Waiting for confirmations (${confirmations}/${needed})`);
    }
    return tx.status.block_time ? tx.status.block_time * 1000 : null;
  }
}

class SolanaMethod extends ExactAmountMethod<SolanaConfig> {
  decimals() {
    return this.config.decimals ?? (this.config.mint ? 6 : 9);
  }
  currency() {
    return this.config.currency;
  }
  info() {
    return {
      ...this.baseInfo(`${this.config.currency} on Solana`),
      network: 'solana',
      currency: this.config.currency,
      rate: { credits: this.config.creditsPerCoin, per: `1 ${this.config.currency}` },
    };
  }
  paymentUri(invoice: StoredInvoice, units: bigint): string {
    const token = this.config.mint ? `&spl-token=${this.config.mint}` : '';
    return `solana:${this.config.address}?amount=${formatUnits(units, this.decimals())}${token}&memo=${invoice.id}`;
  }

  async verify(signature: string, units: bigint): Promise<number | null> {
    if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(signature)) throw badRequest('Not a Solana transaction signature');
    type Balance = { owner?: string; mint: string; uiTokenAmount: { amount: string } };
    const tx = await rpc<{
      blockTime?: number;
      meta: { err: unknown; preBalances: number[]; postBalances: number[]; preTokenBalances?: Balance[]; postTokenBalances?: Balance[] };
      transaction: { message: { accountKeys: ({ pubkey: string } | string)[] } };
    } | null>(this.config.rpcUrl, 'getTransaction', [
      signature,
      { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' },
    ]);
    if (!tx) throw notPaid('The transaction is not confirmed yet');
    if (tx.meta.err) throw notPaid('The transaction failed');
    let received = 0n;
    if (this.config.mint) {
      const sum = (list: Balance[] | undefined) =>
        (list ?? [])
          .filter((entry) => entry.owner === this.config.address && entry.mint === this.config.mint)
          .reduce((total, entry) => total + BigInt(entry.uiTokenAmount.amount), 0n);
      received = sum(tx.meta.postTokenBalances) - sum(tx.meta.preTokenBalances);
    } else {
      const keys = tx.transaction.message.accountKeys.map((key) => (typeof key === 'string' ? key : key.pubkey));
      const index = keys.indexOf(this.config.address);
      if (index >= 0) received = BigInt(tx.meta.postBalances[index] - tx.meta.preBalances[index]);
    }
    if (received !== units) throw notPaid('The transaction does not pay the invoice amount to this node');
    return tx.blockTime ? tx.blockTime * 1000 : null;
  }
}

class LightningMethod extends Method<LightningConfig> {
  info() {
    return {
      ...this.baseInfo('Bitcoin Lightning'),
      network: 'lightning',
      currency: 'BTC',
      rate: { credits: this.config.creditsPerCoin, per: '1 BTC' },
    };
  }

  async createInvoice(account: Account, credits: number): Promise<StoredInvoice> {
    const value = this.checkCredits(credits);
    const sats = unitsForCredits(value, this.config.creditsPerCoin, 8);
    const minutes = this.config.invoiceMinutes ?? 60;
    const created = await requestJson<{ payment_hash: string; payment_request?: string; bolt11?: string }>(
      `${this.config.lnbitsUrl.replace(/\/$/, '')}/api/v1/payments`,
      {
        body: { out: false, amount: Number(sats), memo: `${value} credits`, expiry: minutes * 60 },
        headers: { 'x-api-key': this.config.invoiceKey },
      }
    );
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
    const status = await requestJson<{ paid: boolean }>(
      `${this.config.lnbitsUrl.replace(/\/$/, '')}/api/v1/payments/${invoice.paymentHash}`,
      { headers: { 'x-api-key': this.config.invoiceKey } }
    );
    if (!status.paid) throw notPaid('The Lightning invoice is not paid yet');
    return this.payments.settle(invoice, `lightning:${invoice.paymentHash}`, invoice.paymentHash ?? '');
  }
}

class CheckoutMethod extends Method<CheckoutConfig> {
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

class ManualMethod extends Method<ManualConfig> {
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

const METHOD_CLASSES: Record<PaymentType, new (config: never, payments: Payments) => Method> = {
  voucher: VoucherMethod,
  evm: EvmMethod,
  bitcoin: BitcoinMethod,
  solana: SolanaMethod,
  lightning: LightningMethod,
  checkout: CheckoutMethod,
  manual: ManualMethod,
};

export function voucherCode(): string {
  const text = base32Encode(randomBytes(10)).toUpperCase();
  return `VS-${text.slice(0, 4)}-${text.slice(4, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}`;
}

/** Every way a node sells credits, with the invoices and vouchers behind them. */
export class Payments {
  readonly data: PaymentsData;
  private store: JsonFile<PaymentsData>;
  private cache: { key: string; methods: Method[] } = { key: '', methods: [] };

  constructor(
    path: string | null,
    readonly ledger: Ledger,
    private readonly configs: () => PaymentConfig[]
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
    this.changed();
    const account = this.ledger.credit(invoice.accountId, credits, `payment ${invoice.method}`, invoice.id);
    return { credited: credits, balance: account.balance, invoice: publicInvoice(invoice) };
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
