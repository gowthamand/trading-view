const HQ = 'https://hq.sinajs.cn/list=hf_';
const DAILY = 'https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20_=/GlobalFuturesService.getGlobalFuturesDailyKLine?source=web&symbol=';
const MINUTES = 'https://gu.sina.cn/ft/api/jsonp.php/var%20_=/GlobalService.getMink?symbol=';
const HEADERS = { Referer: 'https://finance.sina.com.cn', 'User-Agent': 'Mozilla/5.0' };
const DAYS: Record<string, number> = { '1mo': 31, '3mo': 92, '6mo': 183, '1y': 366, '3y': 3 * 366, '5y': 5 * 366, '10y': 10 * 366 };
export const SINA_PREFIX = 'SINA:';

type Point = { t: number; c: number };
const cache = new Map<string, { at: number; data: any }>();

async function cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.data;
  const data = await load();
  cache.set(key, { at: Date.now(), data });
  return data;
}

async function get(url: string) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`Sina: HTTP ${res.status}`);
  return res.text();
}

function bars(code: string, type: 'daily' | '5' | '30'): Promise<Point[]> {
  return cached(`${code}|${type}`, type === 'daily' ? 600_000 : 30_000, async () => {
    const text = await get(type === 'daily' ? DAILY + code : `${MINUTES}${code}&type=${type}`);
    const rows: any[] = JSON.parse(text.match(/\((\[.*\])\)/s)?.[1] ?? '[]');
    return rows
      .map((r) => ({
        t: r.date ? Date.parse(`${r.date}T12:00:00Z`) : Date.parse(`${String(r.d).replace(' ', 'T')}+08:00`),
        c: Number(r.close ?? r.c),
      }))
      .filter((p) => p.c > 0 && !isNaN(p.t));
  });
}

export const isSina = (symbol: string) => symbol.startsWith(SINA_PREFIX);

export async function sinaQuote(symbol: string) {
  const code = symbol.slice(SINA_PREFIX.length);
  const f = await cached(`${code}|quote`, 4_000, async () => (await get(HQ + code)).match(/"([^"]*)"/)?.[1].split(',') ?? []);
  const price = Number(f[0]);
  const prev = Number(f[7]);
  if (!price) throw new Error(`${symbol}: no data`);
  const yearAgo = Date.now() - 365 * 86400_000;
  const year = (await bars(code, 'daily').catch(() => [] as Point[])).filter((p) => p.t >= yearAgo).map((p) => p.c);
  return {
    symbol,
    price,
    change: prev ? price - prev : 0,
    changePct: prev ? ((price - prev) / prev) * 100 : 0,
    volume: Number(f[14]) || 0,
    high52: year.length ? Math.max(price, ...year) : 0,
    low52: year.length ? Math.min(price, ...year) : 0,
    currency: 'USD',
    time: Date.parse(`${f[12]}T${f[6]}+08:00`) || Date.now(),
  };
}

export async function sinaHistory(symbol: string, range: unknown): Promise<Point[]> {
  const code = symbol.slice(SINA_PREFIX.length);
  if (range === '1d' || range === '5d') {
    const pts = await bars(code, range === '1d' ? '5' : '30');
    if (!pts.length) return pts;
    const end = pts[pts.length - 1].t;
    if (range === '5d') return pts.filter((p) => end - p.t <= 7 * 86400_000);
    let i = pts.length - 1;
    while (i > 0 && pts[i].t - pts[i - 1].t < 5 * 3600_000) i--;
    return pts.slice(i);
  }
  const days = range === 'max' ? 0 : (DAYS[String(range)] ?? DAYS['1y']);
  const pts = await bars(code, 'daily');
  return days ? pts.filter((p) => p.t >= Date.now() - days * 86400_000) : pts;
}
