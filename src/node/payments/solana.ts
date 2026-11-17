// SOL or an SPL token, checked over Solana JSON-RPC: the exact invoice amount must
// show up in the transaction's balance changes.
import { badRequest } from '../../shared/node/http.js';
import { ExactAmountMethod, formatUnits, notPaid, rpc, type SolanaConfig, type StoredInvoice } from './interface.js';

export class SolanaMethod extends ExactAmountMethod<SolanaConfig> {
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
