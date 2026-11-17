// On-chain bitcoin, checked with an Esplora API (mempool.space, blockstream.info or
// self-hosted): a paying output of the exact invoice amount, plus confirmations.
import { badRequest, requestJson } from '../../shared/node/http.js';
import { DEFAULT_ESPLORA, ExactAmountMethod, formatUnits, notPaid, type BitcoinConfig, type StoredInvoice } from './interface.js';

export class BitcoinMethod extends ExactAmountMethod<BitcoinConfig> {
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
