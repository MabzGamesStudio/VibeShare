// A stand-in for Tor in tests: a SOCKS5 proxy that records what it is asked to reach and
// maps .onion names to local ports, and a control port that "publishes" onion services.
import { randomBytes } from 'node:crypto';
import { createServer, connect, type AddressInfo, type Server, type Socket } from 'node:net';

export interface SocksRequest {
  host: string;
  port: number;
  username?: string;
}

export interface FakeTor {
  socksPort: number;
  controlPort: number;
  /** Every connection asked of the proxy. */
  requests: SocksRequest[];
  /** Control commands received. */
  commands: string[];
  /** .onion name → local port. */
  onions: Map<string, number>;
  /** Password the control port wants (empty: cookie file / none). */
  password: string;
  close(): Promise<void>;
}

function read(socket: Socket, n: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const chunk = socket.read(n) as Buffer | null;
      if (chunk) {
        socket.off('readable', attempt);
        socket.off('error', reject);
        resolve(chunk);
      }
    };
    socket.on('readable', attempt);
    socket.on('error', reject);
    attempt();
  });
}

async function socks(client: Socket, tor: FakeTor): Promise<void> {
  client.pause();
  const [, count] = await read(client, 2);
  const methods = [...(await read(client, count))];
  let username: string | undefined;
  if (methods.includes(0x02)) {
    client.write(Buffer.from([0x05, 0x02]));
    const [, ulen] = await read(client, 2);
    username = (await read(client, ulen)).toString();
    const [plen] = await read(client, 1);
    await read(client, plen);
    client.write(Buffer.from([0x01, 0x00]));
  } else {
    client.write(Buffer.from([0x05, 0x00]));
  }
  const head = await read(client, 4);
  let host: string;
  if (head[3] === 0x03) {
    const [len] = await read(client, 1);
    host = (await read(client, len)).toString();
  } else if (head[3] === 0x01) {
    host = [...(await read(client, 4))].join('.');
  } else {
    await read(client, 16);
    host = '::';
  }
  const portBytes = await read(client, 2);
  const port = portBytes.readUInt16BE(0);
  tor.requests.push({ host, port, username });
  const reply = (code: number) => client.write(Buffer.from([0x05, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
  let target: { host: string; port: number };
  if (host.endsWith('.onion')) {
    const local = tor.onions.get(host);
    if (!local) return void (reply(0xf0), client.end());
    target = { host: '127.0.0.1', port: local };
  } else if (host === '127.0.0.1' || host === 'localhost') {
    target = { host: '127.0.0.1', port };
  } else {
    // The test network has nothing else: "host unreachable".
    return void (reply(0x04), client.end());
  }
  const upstream = connect(target);
  upstream.once('connect', () => {
    reply(0x00);
    upstream.pipe(client);
    client.pipe(upstream);
    client.resume();
  });
  upstream.once('error', () => (reply(0x05), client.end()));
  client.on('error', () => upstream.destroy());
  upstream.on('error', () => client.destroy());
}

function control(client: Socket, tor: FakeTor): void {
  let buffer = '';
  let authed = false;
  const send = (lines: string[]) => client.write(lines.map((line, i) => `${i < lines.length - 1 ? '250-' : '250 '}${line}\r\n`).join(''));
  client.setEncoding('utf8');
  client.on('data', (data: string) => {
    buffer += data;
    let end;
    while ((end = buffer.indexOf('\r\n')) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      tor.commands.push(line);
      if (line.startsWith('PROTOCOLINFO')) {
        send(['PROTOCOLINFO 1', `AUTH METHODS=${tor.password ? 'HASHEDPASSWORD' : 'NULL'}`, 'VERSION Tor="0.4.8.0"', 'OK']);
      } else if (line.startsWith('AUTHENTICATE')) {
        const given = line.slice(13).replace(/^"|"$/g, '');
        if (tor.password && given !== tor.password) client.write('515 Authentication failed\r\n');
        else ((authed = true), send(['OK']));
      } else if (line.startsWith('ADD_ONION')) {
        if (!authed) return void client.write('514 Authentication required\r\n');
        const [, key, mapping] = line.split(' ');
        const target = Number(mapping.split(',')[1].split(':')[1]);
        const id = key.startsWith('NEW:') ? randomBytes(35).toString('hex').slice(0, 56) : Buffer.from(key.split(':')[1], 'base64').toString();
        tor.onions.set(`${id}.onion`, target);
        client.once('close', () => tor.onions.delete(`${id}.onion`));
        send(key.startsWith('NEW:') ? [`ServiceID=${id}`, `PrivateKey=ED25519-V3:${Buffer.from(id).toString('base64')}`, 'OK'] : [`ServiceID=${id}`, 'OK']);
      } else {
        client.write('510 Unrecognized command\r\n');
      }
    }
  });
  client.on('error', () => undefined);
}

export async function startFakeTor(password = ''): Promise<FakeTor> {
  const sockets = new Set<Socket>();
  const tor = { requests: [], commands: [], onions: new Map(), password } as unknown as FakeTor;
  const track = (socket: Socket) => (sockets.add(socket), socket.once('close', () => sockets.delete(socket)));
  const socksServer: Server = createServer((client) => {
    track(client);
    socks(client, tor).catch(() => client.destroy());
  });
  const controlServer: Server = createServer((client) => {
    track(client);
    control(client, tor);
  });
  const listen = (server: Server) => new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
  tor.socksPort = await listen(socksServer);
  tor.controlPort = await listen(controlServer);
  tor.close = async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all([socksServer, controlServer].map((server) => new Promise((resolve) => server.close(resolve))));
  };
  return tor;
}
