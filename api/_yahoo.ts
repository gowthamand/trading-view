/** Shared Yahoo Finance helpers, used by the Vercel functions in api/ and by src/server.ts locally. */
import { ORO_PREFIX, isOro, oroQuote } from './_oropocket.js';

const YAHOO = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const UA = { 'User-Agent': 'Mozilla/5.0' };
const cache = new Map<string, { at: number; data: unknown }>();

/** Fetch a Yahoo chart response, cached for `ttl` ms. */
async function yahooChart(symbol: string, range: string, interval: string, ttl: number) {
  const key = `${symbol}|${range}|${interval}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.data as any;
  // Yahoo has no 3y range, so use explicit timestamps for it
  const span = range === '3y'
    ? `period1=${Math.floor(Date.now() / 1000) - 3 * 365 * 86400}&period2=${Math.floor(Date.now() / 1000)}`
    : `range=${range}`;
  const url = `${YAHOO}${encodeURIComponent(symbol)}?${span}&interval=${interval}`;
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`${symbol}: HTTP ${res.status}`);
  const json: any = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(`${symbol}: no data`);
  cache.set(key, { at: Date.now(), data: result });
  return result;
}

/** Close of the session before the live one, from a daily-bar chart. The live bar is the last
 *  bar; Yahoo sometimes leaves its close null (some NSE stocks), in which case the last valid
 *  close already belongs to the previous session. Compared by position, not calendar date:
 *  futures like GC=F open the evening before, so the live bar's exchange-local date can equal
 *  the previous bar's and a date compare skips a session. */
function previousClose(r: any): number | undefined {
  const closes: (number | null)[] = r.indicators?.quote?.[0]?.close ?? [];
  if (!closes.length) return undefined;
  const liveMissing = closes[closes.length - 1] == null;
  const valid = closes.filter((c): c is number => c != null);
  return liveMissing ? valid[valid.length - 1] : valid[valid.length - 2];
}

function stalePrice(r: any): number | undefined {
  const times: number[] = r.timestamp ?? [];
  const at: number | undefined = r.meta?.regularMarketTime;
  if (!at || !times.length || times[times.length - 1] - at < 7 * 86400) return undefined;
  const closes: (number | null)[] = r.indicators?.quote?.[0]?.close ?? [];
  const valid = closes.filter((c): c is number => c != null);
  return valid[valid.length - 1];
}

/** Instrument types whose previous close comes from the 1d chart's settlement, not daily bars. */
const SETTLEMENT_TYPES = new Set(['FUTURE', 'ALTSYMBOL', 'CURRENCY']);

/** symbols=^NSEI,GC=F -> latest price, change, volume */
export async function getQuotes(symbolsParam: string | null | undefined) {
  const symbols = String(symbolsParam ?? '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 200);
  return Promise.all(
    symbols.map(async (symbol) => {
      try {
        if (isOro(symbol)) return await oroQuote(symbol);
        // Daily bars, not the 1d/5m chart: for Indian indices Yahoo's 1d `chartPreviousClose`
        // can be two sessions old, which made the day's change far too large.
        const r = await yahooChart(symbol, '5d', '1d', 4_000);
        const m = r.meta;
        const barPrice = stalePrice(r);
        const stale = barPrice !== undefined;
        const price = barPrice ?? m.regularMarketPrice;
        // Futures and FX: Yahoo's daily bars often carry stale closes (Brent, NG, grains, JPYINR were
        // off by 2-10%), while the 1d chart's chartPreviousClose is the prior settlement. Indices and
        // stocks keep daily bars, since for Indian indices the 1d value can be two sessions old.
        let settle: number | undefined;
        if (!stale && SETTLEMENT_TYPES.has(m.instrumentType)) {
          settle = (await yahooChart(symbol, '1d', '1h', 60_000).catch(() => null))?.meta?.chartPreviousClose;
        }
        const prev = settle ?? previousClose(r) ?? m.chartPreviousClose ?? m.previousClose ?? price;
        return {
          symbol,
          price,
          change: price - prev,
          changePct: prev ? ((price - prev) / prev) * 100 : 0,
          volume: stale ? 0 : m.regularMarketVolume ?? 0,
          high52: stale ? 0 : m.fiftyTwoWeekHigh ?? 0,
          low52: stale ? 0 : m.fiftyTwoWeekLow ?? 0,
          currency: m.currency ?? '',
          time: (m.regularMarketTime ?? 0) * 1000,
        };
      } catch (e) {
        return { symbol, error: (e as Error).message };
      }
    }),
  );
}

/** symbol=^NSEI&range=1y&interval=1mo -> [{t, c}]; throws on upstream failure. */
export async function getHistory(symbolParam: unknown, rangeParam: unknown, intervalParam: unknown): Promise<{ t: number; c: number }[]> {
  const symbol = String(symbolParam ?? '');
  if (isOro(symbol)) return oroHistory(symbol, rangeParam, intervalParam);
  const range = /^(1d|5d|1mo|3mo|6mo|1y|2y|3y|5y|10y|max)$/.test(String(rangeParam)) ? String(rangeParam) : '1y';
  const interval = /^(5m|15m|30m|1h|1d|1wk|1mo)$/.test(String(intervalParam)) ? String(intervalParam) : '1mo';
  // Yahoo's 1d range starts at midnight exchange time, so futures (session opens the evening before)
  // show only a few minutes after midnight. Fetch 5d instead and keep just the current session.
  const intraday = range === '1d';
  const r = await yahooChart(symbol, intraday ? '5d' : range, interval, 10_000);
  const closes: (number | null)[] = r.indicators?.quote?.[0]?.close ?? [];
  const pts: { t: number; c: number }[] = (r.timestamp ?? [])
    .map((t: number, i: number) => ({ t: t * 1000, c: closes[i] }))
    .filter((p: { c: number | null }) => p.c != null);
  if (!intraday) return pts;
  // FX and crypto trade around the clock with sparse overnight ticks: show the last 24h instead.
  return ['CURRENCY', 'CRYPTOCURRENCY'].includes(r.meta?.instrumentType) ? lastDay(pts) : currentSession(pts);
}

/** OroPocket metal -> the Yahoo future whose INR value drives its chart. */
const ORO_PROXY: Record<string, string> = { GOLD: 'GC=F', SILVER: 'SI=F' };
const TROY_OZ_G = 31.1035;

/** OroPocket has no history: chart COMEX x USDINR per gram, scaled so it ends at the live OroPocket rate. */
async function oroHistory(symbol: string, range: unknown, interval: unknown) {
  const proxy = ORO_PROXY[symbol.slice(ORO_PREFIX.length)];
  if (!proxy) return [];
  const [metal, fx, live] = await Promise.all([
    getHistory(proxy, range, interval),
    getHistory('USDINR=X', range, interval),
    oroQuote(symbol).catch(() => null),
  ]);
  if (!metal.length || !fx.length) return [];
  let j = 0;
  const inr = metal.map((p) => {
    while (j + 1 < fx.length && fx[j + 1].t <= p.t) j++; // latest USDINR at or before this bar
    return { t: p.t, c: (p.c * fx[j].c) / TROY_OZ_G };
  });
  const k = live ? live.price / inr[inr.length - 1].c : 1;
  return inr.map((p) => ({ t: p.t, c: p.c * k }));
}

function lastDay(pts: { t: number; c: number }[]) {
  const end = pts.length ? pts[pts.length - 1].t : 0;
  return pts.filter((p) => end - p.t <= 24 * 3600_000);
}

/** A real break is the ~1h daily futures pause (60-90 min) or an overnight/weekend close (12h+).
 *  Gaps in between are Yahoo data holes (gold had a 4h one at midnight ET), not a new session. */
const isBreak = (gapMs: number) => (gapMs >= 60 * 60_000 && gapMs <= 90 * 60_000) || gapMs >= 12 * 3600_000;

/** Points since the last trading break, capped at 24h for markets that never close. */
function currentSession(pts: { t: number; c: number }[]) {
  if (!pts.length) return pts;
  const end = pts[pts.length - 1].t;
  let start = 0;
  for (let i = pts.length - 1; i > 0; i--) {
    if (isBreak(pts[i].t - pts[i - 1].t)) { start = i; break; }
  }
  return pts.slice(start).filter((p) => end - p.t <= 24 * 3600_000);
}
