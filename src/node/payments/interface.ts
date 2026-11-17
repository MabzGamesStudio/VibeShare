// The shared contract behind every payment method: the configuration shapes a node
// accepts, the base classes each method builds on, and the helpers several of them
// share. Everything here stays free of the concrete methods — they import from this
// module, never the other way around.
import { randomBytes } from 'node:crypto';
import { badRequest, HttpError, notFound, requestJson, type Ctx } from '../../shared/node/http.js';
import type { Invoice, PaymentMethodInfo, PaymentType } from '../../shared/protocol.js';
import type { Account } from '../ledger.js';
import type { Payments } from './index.js';

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
  /** JSON-RPC endpoint; a public one per chain is used when this is left empty. */
  rpcUrl?: string;
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
  /** Esplora API base URL; a public one is used when this is left empty. */
  apiUrl?: string;
  address: string;
  creditsPerCoin: number;
  confirmations?: number;
}

/**
 * Monero: the operator's address only. Because a node never asks for — and never
 * accepts — view keys, seeds or private keys, payments cannot be verified from here:
 * the payer sends the transaction id and the operator confirms it in their wallet.
 */
export interface MoneroConfig extends BaseMethodConfig {
  type: 'monero';
  network?: string;
  address: string;
  creditsPerCoin: number;
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

/**
 * Bitcoin over Lightning. Two ways, both address-only on the operator's side: an
 * LNbits wallet (which creates and checks invoices automatically) or a plain Lightning
 * address / LNURL, where the payer sends the payment hash and the operator confirms.
 */
export interface LightningConfig extends BaseMethodConfig {
  type: 'lightning';
  /** 'lnbits' when a wallet API is configured, otherwise 'address'. */
  mode?: 'lnbits' | 'address';
  /** A lightning address (you@wallet.example) or LNURL for the address mode. */
  address?: string;
  lnbitsUrl?: string;
  /** LNbits *invoice* key: it can only create and read invoices, never spend. */
  invoiceKey?: string;
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
  | MoneroConfig
  | SolanaConfig
  | LightningConfig
  | CheckoutConfig
  | ManualConfig;

// ---------------------------------------------------------------------------
// Built-in crypto options and safety

/** Public Esplora endpoint used when the operator does not run their own. */
export const DEFAULT_ESPLORA = 'https://mempool.space/api';

/** Public JSON-RPC endpoints per EVM chain, so an address is all an operator needs. */
const DEFAULT_EVM_RPC: Record<number, string> = {
  1: 'https://cloudflare-eth.com',
  10: 'https://mainnet.optimism.io',
  137: 'https://polygon-rpc.com',
  8453: 'https://mainnet.base.org',
  42161: 'https://arb1.arbitrum.io/rpc',
};

export function defaultEvmRpc(chainId?: number): string | undefined {
  return chainId ? DEFAULT_EVM_RPC[chainId] : undefined;
}

/**
 * The four crypto options every node ships with: Bitcoin, Bitcoin Lightning, Ethereum
 * and Monero. They start **disabled** with an empty address — the operator fills in an
 * address and flips them on. Only public addresses are ever asked for: no seeds, no
 * private keys, no view keys (a node cannot spend with an address).
 */
export function defaultCryptoPaymentConfigs(): PaymentConfig[] {
  return [
    {
      id: 'btc',
      type: 'bitcoin',
      label: 'Bitcoin',
      description: 'On-chain bitcoin (BTC) to the operator address.',
      enabled: false,
      address: '',
      apiUrl: DEFAULT_ESPLORA,
      creditsPerCoin: 100_000_000,
      confirmations: 1,
    },
    {
      id: 'ln',
      type: 'lightning',
      label: 'Bitcoin Lightning',
      description: 'Lightning (sats) to a lightning address — or through your own LNbits wallet.',
      enabled: false,
      mode: 'address',
      address: '',
      creditsPerCoin: 100_000_000,
    },
    {
      id: 'eth',
      type: 'evm',
      label: 'Ethereum',
      description: 'Ether (ETH) on Ethereum to the operator address.',
      enabled: false,
      network: 'Ethereum',
      chainId: 1,
      rpcUrl: '',
      address: '',
      currency: 'ETH',
      decimals: 18,
      creditsPerCoin: 1_000_000,
      confirmations: 1,
    },
    {
      id: 'xmr',
      type: 'monero',
      label: 'Monero',
      description: 'Monero (XMR) to the operator address — the operator confirms the transfer.',
      enabled: false,
      address: '',
      creditsPerCoin: 1_000,
    },
  ];
}

/** Field names that must never appear in a payment configuration. */
const FORBIDDEN_PAYMENT_FIELDS = [
  'seed',
  'seedphrase',
  'mnemonic',
  'recoveryphrase',
  'passphrase',
  'privatekey',
  'privkey',
  'private',
  'secretkey',
  'viewkey',
  'spendkey',
  'xprv',
  'zprv',
  'wif',
];

/** Looks like a seed phrase, an extended private key or a raw private key. */
function looksLikeSecret(value: string): boolean {
  const text = value.trim();
  if (/^(xprv|zprv|yprv|tprv)[1-9A-HJ-NP-Za-km-z]{20,}$/.test(text)) return true;
  if (/^0x[0-9a-fA-F]{64}$/.test(text)) return true;
  if (/^[5KL][1-9A-HJ-NP-Za-km-z]{50,51}$/.test(text)) return true;
  const words = text.split(/\s+/);
  return words.length >= 12 && words.length <= 24 && words.every((word) => /^[a-z]{3,8}$/.test(word));
}

/**
 * Payment methods take public addresses only. This rejects any configuration that
 * carries a seed phrase, private key, view key or passphrase — in a field named after
 * one, or in a value that looks like one — with an explanation of why.
 */
export function assertNoPaymentSecrets(configs: PaymentConfig[]): void {
  for (const config of configs) {
    const id = typeof config?.id === 'string' && config.id ? config.id : 'unnamed';
    for (const [key, value] of Object.entries(config as unknown as Record<string, unknown>)) {
      const field = key.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (FORBIDDEN_PAYMENT_FIELDS.includes(field)) {
        throw badRequest(
          `Payment method "${id}": "${key}" is never allowed. VibeShare only ever asks for public addresses — it cannot and must not receive seed phrases, private keys or view keys. Remove the field.`
        );
      }
      // Checked in every field: a seed phrase pasted into the wrong box is exactly the
      // accident this is here for.
      if (typeof value === 'string' && looksLikeSecret(value)) {
        throw badRequest(
          `Payment method "${id}": the value of "${key}" looks like a seed phrase or private key. Never paste one here — remove it and use a public address instead.`
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Stored state

export interface StoredInvoice extends Invoice {
  accountId: string;
  /** Exact amount expected, in the smallest unit (wei, sats, lamports). */
  expectedUnits?: string;
  paymentHash?: string;
  tx?: string;
  note?: string;
  /** When it was paid (or rejected) — what the signed receipt records. */
  settledAt?: string;
}

interface Voucher {
  credits: number;
  createdAt: string;
  note?: string;
  redeemedBy?: string;
  redeemedAt?: string;
}

export interface PaymentsData {
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

export async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const response = await requestJson<{ result?: T; error?: { message: string } }>(url, {
    body: { jsonrpc: '2.0', id: 1, method, params },
    timeoutMs: 20000,
  });
  if (response.error) throw new HttpError(502, 'rpc_error', `${method}: ${response.error.message}`);
  return response.result as T;
}

export function fill(template: string, invoice: StoredInvoice): string {
  return template
    .replaceAll('{invoice}', encodeURIComponent(invoice.id))
    .replaceAll('{account}', encodeURIComponent(invoice.accountId))
    .replaceAll('{credits}', String(invoice.credits));
}

export const notPaid = (message: string) => new HttpError(409, 'not_paid', message);

/** Crypto methods need the operator's address before they can ask anyone to pay. */
export function requireAddress(where: string, address?: string): string {
  const value = String(address ?? '').trim();
  if (!value) throw badRequest(`${where} is not configured yet — add the operator's public address in the node's payments settings first`);
  return value;
}

// ---------------------------------------------------------------------------
// Methods

/** The contract every payment method implements. */
export interface PaymentMethod {
  readonly config: PaymentConfig;
  /** What the payer sees: id, type, label, rate and limits. */
  info(): PaymentMethodInfo;
  /** Opens an invoice (methods that settle another way may throw). */
  createInvoice(account: Account, credits: number): Promise<StoredInvoice>;
  /** The payer's proof: credits the account, or moves the invoice into review. */
  claim(account: Account, body: Record<string, unknown>): Promise<ClaimResult>;
  /** Hosted checkouts settle through a webhook; the other methods throw. */
  webhook(raw: Buffer, headers: Ctx['req']['headers']): Promise<unknown>;
}

export abstract class Method<C extends PaymentConfig = PaymentConfig> implements PaymentMethod {
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

/** Invoices whose exact amount identifies the payer: base amount plus a small unique tail. */
export abstract class ExactAmountMethod<C extends EvmConfig | BitcoinConfig | SolanaConfig | MoneroConfig> extends Method<C> {
  abstract decimals(): number;
  abstract currency(): string;
  abstract paymentUri(invoice: StoredInvoice, units: bigint): string;

  /** The operator's public address this method pays to (never a key). */
  protected address(): string {
    return requireAddress(this.config.label ?? this.config.id, this.config.address);
  }

  async createInvoice(account: Account, credits: number): Promise<StoredInvoice> {
    const value = this.checkCredits(credits);
    const to = this.address();
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
      address: to,
      amount,
      currency: this.currency(),
      instructions: `Send exactly ${amount} ${this.currency()} to ${to}, then paste the transaction id.`,
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
