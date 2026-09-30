// Integration test harness: real PostgreSQL (TEST_DATABASE_URL), real Express app on an ephemeral port, fetch.
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import net from 'node:net';
import pg from 'pg';
import { env } from '../src/env';
import { closeDb, db, truncateAll } from '../src/db';
import { migrateToLatest } from '../src/db/migrate';
import { createApp, type AppOptions } from '../src/app';
import { closeAllTransports } from '../src/services/email';

if (env.NODE_ENV !== 'test') throw new Error('Les tests doivent tourner avec NODE_ENV=test (npm test)');

/** Creates the test database if it doesn't exist (connects to the `postgres` maintenance db of the same server). */
async function ensureDatabase() {
  const url = new URL(env.DATABASE_URL);
  const name = decodeURIComponent(url.pathname.slice(1));
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (!rowCount) await client.query(`CREATE DATABASE ${client.escapeIdentifier(name)}`);
  } finally {
    await client.end();
  }
}

let prepared: Promise<void> | null = null;

export interface TestCtx {
  base: string;
  close: () => Promise<void>;
}

/** Call in `before()`: database ready + migrated + emptied, app listening. */
export async function startApp(opts: AppOptions = {}): Promise<TestCtx> {
  prepared ??= (async () => {
    await ensureDatabase();
    await migrateToLatest(db, { quiet: true });
  })();
  await prepared;
  await truncateAll();
  const server: Server = await new Promise((resolve) => {
    const s = createApp(opts).listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}

/** Call in the last `after()` of a file. */
export async function shutdown(ctx?: TestCtx) {
  await ctx?.close();
  closeAllTransports();
  await closeDb();
}

// ---------- HTTP helpers ----------

export interface Res<T = any> {
  status: number;
  body: T;
  text: string;
  headers: Headers;
  cookies: Record<string, string>;
}

export async function http<T = any>(
  ctx: TestCtx,
  method: string,
  path: string,
  opts: { token?: string; json?: unknown; form?: Record<string, string>; cookies?: Record<string, string>; body?: string } = {},
): Promise<Res<T>> {
  const headers: Record<string, string> = {};
  let body: string | undefined = opts.body;
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.json);
  }
  if (opts.form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(opts.form).toString();
  }
  if (opts.cookies) headers.cookie = Object.entries(opts.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  const res = await fetch(ctx.base + path, { method, headers, body, redirect: 'manual' });
  const text = await res.text();
  let parsed: unknown = text;
  if (res.headers.get('content-type')?.includes('application/json')) parsed = JSON.parse(text);
  const cookies: Record<string, string> = {};
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    cookies[pair.slice(0, i)] = pair.slice(i + 1);
  }
  return { status: res.status, body: parsed as T, text, headers: res.headers, cookies };
}

let seq = 0;
export async function registerUser(ctx: TestCtx, name = 'Test') {
  const email = `user${++seq}-${Date.now()}@test.local`;
  const r = await http(ctx, 'POST', '/api/auth/register', { json: { email, password: 'secret123', name } });
  if (r.status !== 201) throw new Error(`register failed: ${r.status} ${r.text}`);
  return { token: r.body.token as string, user: r.body.user as { id: number; email: string }, email };
}

/** An authenticated client bound to one user. */
export function client(ctx: TestCtx, token: string) {
  return {
    get: <T = any>(p: string) => http<T>(ctx, 'GET', p, { token }),
    post: <T = any>(p: string, json?: unknown) => http<T>(ctx, 'POST', p, { token, json: json ?? {} }),
    patch: <T = any>(p: string, json: unknown) => http<T>(ctx, 'PATCH', p, { token, json }),
    put: <T = any>(p: string, json: unknown) => http<T>(ctx, 'PUT', p, { token, json }),
    del: <T = any>(p: string) => http<T>(ctx, 'DELETE', p, { token }),
  };
}

// ---------- fake SMTP server ----------

export interface FakeSmtp {
  port: number;
  messages: { from: string; to: string[]; data: string }[];
  close: () => Promise<void>;
}

/**
 * Minimal SMTP server. Behaviour by recipient local part: `bounce*` → 550, `temp*` → 451, otherwise accepted.
 * AUTH PLAIN with user `bad` → 535.
 */
export function fakeSmtp(): Promise<FakeSmtp> {
  const messages: FakeSmtp['messages'] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => undefined);
    let buf = '';
    let inData = false;
    let data = '';
    let from = '';
    let to: string[] = [];
    const reply = (s: string) => sock.write(`${s}\r\n`);
    reply('220 fake.local ESMTP');
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let i: number;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            messages.push({ from, to, data });
            data = '';
            reply('250 2.0.0 queued');
          } else data += `${line}\n`;
          continue;
        }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO') {
          sock.write('250-fake.local\r\n250-AUTH PLAIN\r\n250 8BITMIME\r\n');
        } else if (cmd === 'HELO') reply('250 fake.local');
        else if (cmd === 'AUTH') {
          const b64 = line.split(' ')[2] ?? '';
          const user = Buffer.from(b64, 'base64').toString('utf8').split('\0')[1];
          reply(user === 'bad' ? '535 5.7.8 Authentication credentials invalid' : '235 2.7.0 Authentication successful');
        } else if (cmd === 'MAIL') {
          from = line;
          to = [];
          reply('250 2.1.0 OK');
        } else if (cmd === 'RCPT') {
          const addr = /<([^>]+)>/.exec(line)?.[1] ?? '';
          if (addr.startsWith('bounce')) reply('550 5.1.1 User unknown');
          else if (addr.startsWith('temp')) reply('451 4.7.1 Try again later');
          else {
            to.push(addr);
            reply('250 2.1.5 OK');
          }
        } else if (cmd === 'DATA') {
          inData = true;
          reply('354 End data with <CR><LF>.<CR><LF>');
        } else if (cmd === 'RSET') {
          from = '';
          to = [];
          reply('250 2.0.0 OK');
        } else if (cmd === 'NOOP') reply('250 OK');
        else if (cmd === 'QUIT') {
          reply('221 Bye');
          sock.end();
        } else reply('502 5.5.2 Command not recognized');
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        messages,
        close: () =>
          new Promise((r) => {
            for (const s of sockets) s.destroy();
            server.close(() => r());
          }),
      });
    });
  });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
