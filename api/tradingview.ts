import { randomBytes } from 'node:crypto';
import { connect } from 'node:tls';

const SCAN = 'https://scanner.tradingview.com/futures/scan';
const WS_HOST = 'data.tradingview.com';
const WS_PATH = '/socket.io/websocket';
const COLUMNS = ['close', 'change', 'change_abs', 'volume', 'currency', 'price_52_week_high', 'price_52_week_low', 'Perf.W', 'Perf.1M', 'Perf.3M', 'Perf.6M', 'Perf.Y'];
const TTL = 30_000;
const HISTORY_TTL = 60_000;
export const TV_PREFIX = 'TV:';

type Point = { t: number; c: number };
type TvSpec = { interval: string; count: number };

const quoteCache = new Map<string, { at: number; data: any }>();
const historyCache = new Map<string, { at: number; data: Point[] }>();

export const isTv = (symbol: string) => symbol.startsWith(TV_PREFIX);

export async function tvQuote(symbol: string) {
  const hit = quoteCache.get(symbol);
  if (hit && Date.now() - hit.at < TTL) return hit.data;
  const res = await fetch(SCAN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
    body: JSON.stringify({ symbols: { tickers: [symbol.slice(TV_PREFIX.length)] }, columns: COLUMNS }),
  });
  if (!res.ok) throw new Error(`${symbol}: HTTP ${res.status}`);
  const d: any[] | undefined = (await res.json())?.data?.[0]?.d;
  if (!d || d[0] == null) throw new Error(`${symbol}: no data`);
  const [price, changePct, change, volume, currency, high52, low52, perfW, perfM, perf3M, perf6M, perfY] = d;
  const quote = {
    symbol,
    price,
    change: change ?? 0,
    changePct: changePct ?? 0,
    volume: volume ?? 0,
    high52: high52 ?? 0,
    low52: low52 ?? 0,
    currency: currency ?? 'USD',
    time: Date.now(),
    perfW: perfW ?? 0,
    perfM: perfM ?? 0,
    perf3M: perf3M ?? 0,
    perf6M: perf6M ?? 0,
    perfY: perfY ?? 0,
  };
  quoteCache.set(symbol, { at: Date.now(), data: quote });
  return quote;
}

export async function tvHistory(symbol: string, range: unknown, interval: unknown) {
  const spec = historySpec(range, interval);
  const key = `${symbol}|${spec.interval}|${spec.count}`;
  const hit = historyCache.get(key);
  if (hit && Date.now() - hit.at < HISTORY_TTL) return hit.data;
  const ticker = symbol.slice(TV_PREFIX.length);
  let pts = await tvBars(ticker, spec).catch(() => [] as Point[]);
  if (range === '1d') pts = await dayHistory(symbol, ticker, pts);
  const data = pts.length ? pts : await syntheticHistory(symbol, range);
  historyCache.set(key, { at: Date.now(), data });
  return data;
}

function historySpec(range: unknown, interval: unknown): TvSpec {
  const r = String(range ?? '1y');
  const i = String(interval ?? '1d');
  if (r === '1d') return { interval: 'D', count: 2 };
  if (r === '5d') return { interval: 'D', count: 6 };
  if (i === '1wk') return { interval: 'W', count: r === '5y' ? 260 : 156 };
  if (i === '1mo') return { interval: 'M', count: r === '10y' ? 120 : 360 };
  return { interval: 'D', count: ({ '1mo': 31, '3mo': 92, '6mo': 183, '1y': 366 } as Record<string, number>)[r] ?? 366 };
}

async function dayHistory(symbol: string, ticker: string, pts: Point[]): Promise<Point[]> {
  const q = await tvQuote(symbol).catch(() => null);
  if (!q?.price) return pts;
  const end = { t: q.time || Date.now(), c: q.price };
  if (q.change) return [{ t: end.t - 86400_000, c: q.price - q.change }, end];
  const source = pts.length > 2 ? pts : await tvBars(ticker, { interval: 'D', count: 30 }).catch(() => pts);
  const prev = [...source].reverse().find((p) => p.c !== end.c);
  if (prev) return [prev, end];
  return pts.length ? [...pts.slice(0, -1), end] : [end];
}

async function syntheticHistory(symbol: string, range: unknown): Promise<Point[]> {
  const q = await tvQuote(symbol);
  const r = String(range ?? '1y');
  const pct = ({ '1d': q.changePct, '5d': q.perfW, '1mo': q.perfM, '3mo': q.perf3M, '6mo': q.perf6M, '1y': q.perfY } as Record<string, number>)[r];
  const count = ({ '1d': 2, '5d': 6, '1mo': 22, '3mo': 13, '6mo': 26, '1y': 52 } as Record<string, number>)[r] ?? 0;
  const days = ({ '1d': 1, '5d': 7, '1mo': 31, '3mo': 92, '6mo': 183, '1y': 366 } as Record<string, number>)[r] ?? 0;
  if (!count || pct == null) return [];
  const start = pct ? q.price / (1 + pct / 100) : q.price - q.change;
  const end = q.time || Date.now();
  return Array.from({ length: count }, (_, i) => {
    const k = count === 1 ? 1 : i / (count - 1);
    return { t: end - (1 - k) * days * 86400_000, c: (start || q.price) + (q.price - (start || q.price)) * k };
  });
}

async function tvBars(ticker: string, spec: TvSpec): Promise<Point[]> {
  return new Promise((resolve) => {
    const session = `cs_${Math.random().toString(36).slice(2, 14)}`;
    const symbol = `={"symbol":"${ticker}","adjustment":"splits"}`;
    const socket = connect(443, WS_HOST, { servername: WS_HOST });
    let buf = Buffer.alloc(0);
    let upgraded = false;
    let settled = false;
    const finish = (data: Point[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(data);
    };
    const write = (payload: string) => socket.write(wsFrame(payload));
    const timer = setTimeout(() => finish([]), 12_000);
    socket.on('secureConnect', () => {
      const key = randomBytes(16).toString('base64');
      socket.write(`GET ${WS_PATH} HTTP/1.1\r\nHost: ${WS_HOST}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nOrigin: https://www.tradingview.com\r\nUser-Agent: Mozilla/5.0\r\n\r\n`);
    });
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        const head = buf.subarray(0, end).toString();
        buf = buf.subarray(end + 4);
        if (!head.includes(' 101 ')) return finish([]);
        upgraded = true;
        write(frame('set_auth_token', ['unauthorized_user_token']));
        write(frame('chart_create_session', [session, '']));
        write(frame('resolve_symbol', [session, 'sym_1', symbol]));
        write(frame('create_series', [session, 's1', 's1', 'sym_1', spec.interval, spec.count, '']));
      }
      for (const raw of readWsFrames()) {
        if (raw.startsWith('~h~')) {
          write(raw);
          continue;
        }
        for (const msg of messages(raw)) {
          if (msg.m === 'timescale_update') finish(points(msg));
          if (msg.m === 'series_error' || msg.m === 'symbol_error' || msg.m === 'critical_error') finish([]);
        }
      }
    });
    socket.on('error', () => finish([]));

    function readWsFrames() {
      const out: string[] = [];
      while (buf.length >= 2) {
        const opcode = buf[0] & 0x0f;
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) break;
          len = buf.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          if (buf.length < 10) break;
          len = Number(buf.readBigUInt64BE(2));
          off = 10;
        }
        const masked = !!(buf[1] & 0x80);
        const maskOff = off;
        if (masked) off += 4;
        if (buf.length < off + len) break;
        let payload = Buffer.from(buf.subarray(off, off + len));
        if (masked) {
          const mask = buf.subarray(maskOff, maskOff + 4);
          for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        }
        buf = buf.subarray(off + len);
        if (opcode === 1) out.push(payload.toString());
        if (opcode === 8) finish([]);
      }
      return out;
    }
  });
}

function wsFrame(text: string) {
  const payload = Buffer.from(text);
  const mask = randomBytes(4);
  const len = payload.length;
  const head = len < 126 ? Buffer.from([0x81, 0x80 | len]) : len < 65536 ? Buffer.from([0x81, 0x80 | 126, len >> 8, len & 255]) : Buffer.from([0x81, 0x80 | 127, 0, 0, 0, 0, (len / 2 ** 24) & 255, (len / 2 ** 16) & 255, (len / 2 ** 8) & 255, len & 255]);
  const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
  return Buffer.concat([head, mask, body]);
}

function frame(method: string, params: unknown[]) {
  const body = JSON.stringify({ m: method, p: params });
  return `~m~${body.length}~m~${body}`;
}

function messages(raw: string) {
  const out: any[] = [];
  let i = 0;
  while (i < raw.length) {
    const start = raw.indexOf('~m~', i);
    if (start < 0) break;
    const end = raw.indexOf('~m~', start + 3);
    if (end < 0) break;
    const len = Number(raw.slice(start + 3, end));
    const bodyStart = end + 3;
    const body = raw.slice(bodyStart, bodyStart + len);
    i = bodyStart + len;
    try { out.push(JSON.parse(body)); } catch {}
  }
  return out;
}

function points(msg: any): Point[] {
  return (msg.p?.[1]?.s1?.s ?? [])
    .map((bar: any) => ({ t: bar.v?.[0] * 1000, c: bar.v?.[4] }))
    .filter((p: Point) => Number.isFinite(p.t) && Number.isFinite(p.c));
}
