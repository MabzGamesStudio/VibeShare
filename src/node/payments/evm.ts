// Ether or an ERC-20 token on an EVM chain, checked over JSON-RPC: the receipt must
// show the exact invoice amount arriving at the operator's address.
import { badRequest } from '../../shared/node/http.js';
import { defaultEvmRpc, ExactAmountMethod, notPaid, rpc, type EvmConfig, type StoredInvoice } from './interface.js';

const ERC20_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export class EvmMethod extends ExactAmountMethod<EvmConfig> {
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
