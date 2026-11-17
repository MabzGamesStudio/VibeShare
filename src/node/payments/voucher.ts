// Voucher codes: redeem a code the operator sold or gave away anywhere (shop,
// gift cards, events).
import { randomBytes } from 'node:crypto';
import { sha256hex } from '../../shared/crypto.js';
import { base32Encode } from '../../shared/encoding.js';
import { badRequest, HttpError, notFound } from '../../shared/node/http.js';
import type { Account } from '../ledger.js';
import { Method, type ClaimResult, type VoucherConfig } from './interface.js';

export class VoucherMethod extends Method<VoucherConfig> {
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

export function voucherCode(): string {
  const text = base32Encode(randomBytes(10)).toUpperCase();
  return `VS-${text.slice(0, 4)}-${text.slice(4, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}`;
}
