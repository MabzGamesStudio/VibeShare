import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';
import { hmacHex } from '../src/shared/crypto.js';
import type { Invoice } from '../src/shared/protocol.js';
import { admin, clientFor, startProvider } from './helpers.js';

const ADDRESS = '0x00000000000000000000000000000000000000aa';
const TOKEN = '0x00000000000000000000000000000000000000cc';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const hex = (value: bigint | number) => '0x' + BigInt(value).toString(16);

/** One fake server for every chain/payment API the methods talk to. */
async function mockChains() {
  const evm = new Map<string, { to: string; value: bigint; token?: boolean; status?: string; block: number }>();
  const btc = new Map<string, { address: string; sats: bigint; height?: number }>();
  const sol = new Map<string, { lamports: bigint }>();
  const lightning = new Map<string, boolean>();
  const state = { head: 100, now: Math.floor(Date.now() / 1000), btcTip: 800 };

  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const json = (value: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value));
    const url = req.url ?? '';
    if (url === '/evm') {
      const [arg] = body.params;
      const tx = evm.get(arg);
      switch (body.method) {
        case 'eth_getTransactionReceipt':
          return json({
            result: tx && {
              status: tx.status ?? '0x1',
              blockNumber: hex(tx.block),
              logs: tx.token
                ? [{ address: TOKEN, topics: [TRANSFER, '0x' + '0'.repeat(64), '0x' + '0'.repeat(24) + tx.to.slice(2)], data: hex(tx.value) }]
                : [],
            },
          });
        case 'eth_getTransactionByHash':
          return json({ result: tx && { to: tx.to, value: hex(tx.value) } });
        case 'eth_blockNumber':
          return json({ result: hex(state.head) });
        case 'eth_getBlockByNumber':
          return json({ result: { timestamp: hex(state.now) } });
      }
    }
    if (url.startsWith('/esplora/tx/')) {
      const tx = btc.get(url.split('/').pop()!);
      if (!tx) return res.writeHead(404).end('not found');
      return json({
        vout: [{ scriptpubkey_address: tx.address, value: Number(tx.sats) }],
        status: { confirmed: tx.height !== undefined, block_height: tx.height, block_time: state.now },
      });
    }
    if (url === '/esplora/blocks/tip/height') return res.writeHead(200).end(String(state.btcTip));
    if (url === '/solana') {
      const tx = sol.get(body.params[0]);
      return json({
        result: tx && {
          blockTime: state.now,
          meta: { err: null, preBalances: [5_000_000_000, 0], postBalances: [5_000_000_000 - Number(tx.lamports), Number(tx.lamports)] },
          transaction: { message: { accountKeys: [{ pubkey: 'Payer11111111111111111111111111111111111111' }, { pubkey: 'Shop111111111111111111111111111111111111111' }] } },
        },
      });
    }
    if (url === '/lnbits/api/v1/payments' && req.method === 'POST') {
      const hash = 'h' + lightning.size;
      lightning.set(hash, false);
      return json({ payment_hash: hash, payment_request: `lnbc${body.amount}n1fake` });
    }
    if (url.startsWith('/lnbits/api/v1/payments/')) return json({ paid: lightning.get(url.split('/').pop()!) ?? false });
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, evm, btc, sol, lightning, state, close: () => server.close() };
}

describe('payment methods', async () => {
  const chains = await mockChains();
  const provider = await startProvider({
    signup: { grant: 0 },
    payments: [
      { id: 'eth', type: 'evm', network: 'Testnet', chainId: 1, rpcUrl: `${chains.base}/evm`, address: ADDRESS, currency: 'ETH', decimals: 18, creditsPerCoin: 1_000_000, confirmations: 2 },
      { id: 'usdc', type: 'evm', network: 'Testnet', rpcUrl: `${chains.base}/evm`, address: ADDRESS, currency: 'USDC', decimals: 6, token: TOKEN, creditsPerCoin: 1000 },
      { id: 'btc', type: 'bitcoin', apiUrl: `${chains.base}/esplora`, address: 'bc1qshop', creditsPerCoin: 100_000_000, confirmations: 1 },
      { id: 'sol', type: 'solana', rpcUrl: `${chains.base}/solana`, address: 'Shop111111111111111111111111111111111111111', currency: 'SOL', creditsPerCoin: 1000 },
      { id: 'ln', type: 'lightning', lnbitsUrl: `${chains.base}/lnbits`, invoiceKey: 'key', creditsPerCoin: 100_000_000 },
      { id: 'card', type: 'checkout', checkoutUrl: 'https://pay.example/link?ref={invoice}', secret: 'shh', creditsPerUnit: 100, currency: 'USD' },
      { id: 'stripe', type: 'checkout', format: 'stripe', checkoutUrl: 'https://buy.stripe.com/x?client_reference_id={invoice}', secret: 'whsec', creditsPerUnit: 100, currency: 'USD' },
      { id: 'paypal', type: 'manual', instructions: 'Send to pay@example.org with note {invoice}' },
    ],
  });
  const url = provider.url();
  after(async () => {
    await provider.stop();
    chains.close();
  });

  const buyer = clientFor(url, 'pseudonym');
  const invoice = (method: string, credits: number) => buyer.json<Invoice & { pay: { amount: string } }>(`/v1/payments/${method}/invoices`, { body: { credits } });
  const claim = (method: string, body: Record<string, unknown>) => buyer.json<{ credited: number; balance: number }>(`/v1/payments/${method}/claim`, { body });

  it('lists the methods in the signed node info', async () => {
    const info = await buyer.fetchInfo();
    assert.deepEqual(info.payments.map((m) => m.id), ['eth', 'usdc', 'btc', 'sol', 'ln', 'card', 'stripe', 'paypal']);
    assert.deepEqual(info.payments[0].rate, { credits: 1_000_000, per: '1 ETH' });
  });

  it('credits ETH payments of the exact invoice amount once confirmed, and only once', async () => {
    const inv = await invoice('eth', 500);
    const wei = BigInt(Math.round(Number(inv.pay.amount) * 1e9)) * 10n ** 9n;
    assert.ok(wei > 0n && inv.pay.uri?.startsWith(`ethereum:${ADDRESS}@1?value=`));
    const units = BigInt(inv.pay.uri!.split('value=')[1]);
    chains.evm.set('0x' + '1'.repeat(64), { to: ADDRESS, value: units, block: 100 });
    await assert.rejects(claim('eth', { invoiceId: inv.id, txHash: '0x' + '1'.repeat(64) }), /confirmations/);
    chains.state.head = 101;
    const result = await claim('eth', { invoiceId: inv.id, txHash: '0x' + '1'.repeat(64) });
    assert.deepEqual([result.credited, result.balance], [500, 500]);
    const again = await invoice('eth', 500);
    await assert.rejects(claim('eth', { invoiceId: again.id, txHash: '0x' + '1'.repeat(64) }), /already claimed/);
  });

  it('refuses transactions that pay the wrong amount', async () => {
    const inv = await invoice('eth', 100);
    chains.evm.set('0x' + '2'.repeat(64), { to: ADDRESS, value: 1n, block: 90 });
    await assert.rejects(claim('eth', { invoiceId: inv.id, txHash: '0x' + '2'.repeat(64) }), /does not send the invoice amount/);
  });

  it('credits ERC-20 transfers', async () => {
    const inv = await invoice('usdc', 2000);
    const units = BigInt(inv.pay.uri!.split('uint256=')[1]);
    assert.ok(units > 2_000_000n && units < 2_100_000n, 'two USDC plus a small unique tail');
    chains.evm.set('0x' + '3'.repeat(64), { to: ADDRESS, value: units, token: true, block: 50 });
    assert.equal((await claim('usdc', { invoiceId: inv.id, txHash: '0x' + '3'.repeat(64) })).credited, 2000);
  });

  it('credits on-chain bitcoin', async () => {
    const inv = await invoice('btc', 10_000);
    const sats = BigInt(Math.round(Number(inv.pay.amount) * 1e8));
    const txid = 'a'.repeat(64);
    chains.btc.set(txid, { address: 'bc1qshop', sats });
    await assert.rejects(claim('btc', { invoiceId: inv.id, txid }), /confirm/);
    chains.btc.set(txid, { address: 'bc1qshop', sats, height: 800 });
    assert.equal((await claim('btc', { invoiceId: inv.id, txid })).credited, 10_000);
  });

  it('credits SOL transfers', async () => {
    const inv = await invoice('sol', 50);
    const lamports = BigInt(Math.round(Number(inv.pay.amount) * 1e9));
    const signature = '5'.repeat(88);
    chains.sol.set(signature, { lamports });
    assert.equal((await claim('sol', { invoiceId: inv.id, signature })).credited, 50);
  });

  it('credits Lightning invoices once LNbits reports them paid', async () => {
    const inv = await invoice('ln', 1000);
    assert.match(inv.pay.uri!, /^lightning:lnbc/);
    await assert.rejects(claim('ln', { invoiceId: inv.id }), /not paid/);
    chains.lightning.set('h0', true);
    assert.equal((await claim('ln', { invoiceId: inv.id })).credited, 1000);
  });

  it('credits hosted checkouts from signed webhooks (generic and Stripe)', async () => {
    const inv = await invoice('card', 500);
    assert.equal(inv.pay.checkoutUrl, `https://pay.example/link?ref=${inv.id}`);
    const body = JSON.stringify({ eventId: 'evt1', invoice: inv.id, amount: 5 });
    const forged = await fetch(`${url}/v1/payments/card/webhook`, { method: 'POST', body, headers: { 'x-vs-signature': 'bad' } });
    assert.equal(forged.status, 403);
    const ok = await fetch(`${url}/v1/payments/card/webhook`, { method: 'POST', body, headers: { 'x-vs-signature': hmacHex('shh', body) } });
    assert.equal(ok.status, 200);
    const status = await buyer.json<Invoice>(`/v1/payments/invoices/${inv.id}`);
    assert.equal(status.status, 'paid');

    const stripeInvoice = await invoice('stripe', 300);
    const event = JSON.stringify({
      id: 'evt_stripe_1',
      type: 'checkout.session.completed',
      data: { object: { client_reference_id: stripeInvoice.id, amount_total: 300, payment_status: 'paid' } },
    });
    const t = Math.floor(Date.now() / 1000);
    const signature = `t=${t},v1=${hmacHex('whsec', `${t}.${event}`)}`;
    const stripe = await fetch(`${url}/v1/payments/stripe/webhook`, { method: 'POST', body: event, headers: { 'stripe-signature': signature } });
    assert.equal(stripe.status, 200);
    const account = await buyer.json<{ account: { balance: number } }>('/v1/account');
    assert.equal(account.account.balance, 500 + 2000 + 10_000 + 50 + 1000 + 500 + 300);
  });

  it('sends manual payments to the operator for approval', async () => {
    const inv = await invoice('paypal', 700);
    assert.equal(inv.pay.instructions, `Send to pay@example.org with note ${inv.id}`);
    const pending = await buyer.json<{ invoice: Invoice }>('/v1/payments/paypal/claim', { body: { invoiceId: inv.id, note: 'sent 7 USD' } });
    assert.equal(pending.invoice.status, 'pending-review');
    const queue = await admin<{ invoices: { id: string }[] }>(url, '/v1/admin/invoices?status=pending-review');
    assert.deepEqual(queue.invoices.map((i) => i.id), [inv.id]);
    await admin(url, `/v1/admin/invoices/${inv.id}/approve`, { body: {} });
    assert.equal((await buyer.json<Invoice>(`/v1/payments/invoices/${inv.id}`)).status, 'paid');
  });
});
