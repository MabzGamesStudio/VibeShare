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
import type { Invoice, PaymentMethodInfo, PaymentReceipt, PaymentType } from '../shared/protocol.js';
import { receiptSigningPayload } from '../shared/protocol.js';
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

/** Crypto methods need the operator's address before they can ask anyone to pay. */
function requireAddress(where: string, address?: string): string {
  const value = String(address ?? '').trim();
  if (!value) throw badRequest(`${where} is not configured yet — add the operator's public address in the node's payments settings first`);
  return value;
}

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
abstract class ExactAmountMethod<C extends EvmConfig | BitcoinConfig | SolanaConfig | MoneroConfig> extends Method<C> {
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
      needsProof: true,
    };
  }

  paymentUri(_invoice: StoredInvoice, units: bigint): string {
    const chain = this.config.chainId ? `@${this.config.chainId}` : '';
    if (this.config.token) return `ethereum:${this.config.token}${chain}/transfer?address=${this.address()}&uint256=${units}`;
    return `ethereum:${this.address()}${chain}?value=${units}`;
  }

  async verify(txHash: string, units: bigint): Promise<number | null> {
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw badRequest('Not a transaction hash');
    const url = this.config.rpcUrl?.trim() || defaultEvmRpc(this.config.chainId);
    if (!url) throw badRequest('This chain has no built-in RPC endpoint — set one in the payments settings');
    const receipt = await rpc<{ status: string; blockNumber: string; logs: { address: string; topics: string[]; data: string }[] } | null>(
      url,
      'eth_getTransactionReceipt',
      [txHash]
    );
    if (!receipt) throw notPaid('The transaction is not mined yet');
    if (receipt.status !== '0x1') throw notPaid('The transaction failed');
    const address = this.address().toLowerCase();
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
      needsProof: true,
    };
  }
  paymentUri(_invoice: StoredInvoice, units: bigint): string {
    return `bitcoin:${this.address()}?amount=${formatUnits(units, 8)}`;
  }

  async verify(txid: string, units: bigint): Promise<number | null> {
    if (!/^[0-9a-fA-F]{64}$/.test(txid)) throw badRequest('Not a bitcoin transaction id');
    const api = (this.config.apiUrl?.trim() || DEFAULT_ESPLORA).replace(/\/$/, '');
    const tx = await requestJson<{
      vout: { scriptpubkey_address?: string; value: number }[];
      status: { confirmed: boolean; block_height?: number; block_time?: number };
    }>(`${api}/tx/${txid}`);
    const paid = tx.vout.some((out) => out.scriptpubkey_address === this.address() && BigInt(out.value) === units);
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
      needsProof: true,
    };
  }
  paymentUri(invoice: StoredInvoice, units: bigint): string {
    const token = this.config.mint ? `&spl-token=${this.config.mint}` : '';
    return `solana:${this.address()}?amount=${formatUnits(units, this.decimals())}${token}&memo=${invoice.id}`;
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
          .filter((entry) => entry.owner === this.address() && entry.mint === this.config.mint)
          .reduce((total, entry) => total + BigInt(entry.uiTokenAmount.amount), 0n);
      received = sum(tx.meta.postTokenBalances) - sum(tx.meta.preTokenBalances);
    } else {
      const keys = tx.transaction.message.accountKeys.map((key) => (typeof key === 'string' ? key : key.pubkey));
      const index = keys.indexOf(this.address());
      if (index >= 0) received = BigInt(tx.meta.postBalances[index] - tx.meta.preBalances[index]);
    }
    if (received !== units) throw notPaid('The transaction does not pay the invoice amount to this node');
    return tx.blockTime ? tx.blockTime * 1000 : null;
  }
}

/**
 * Monero. A node never receives a view key (that is a private key) and Monero amounts
 * are hidden without one, so nothing can be checked from here: the invoice names the
 * exact amount and the operator's address, the payer sends the transfer and pastes its
 * transaction id, and the operator confirms it in their own wallet.
 */
class MoneroMethod extends ExactAmountMethod<MoneroConfig> {
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

class LightningMethod extends Method<LightningConfig> {
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
  monero: MoneroMethod,
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
