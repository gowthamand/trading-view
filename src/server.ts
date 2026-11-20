import {
  AngularNodeAppEngine,
  createNodeRequestHandler,
  isMainModule,
  writeResponseToNodeResponse,
} from '@angular/ssr/node';
import express from 'express';
import { join } from 'node:path';

const browserDistFolder = join(import.meta.dirname, '../browser');

const app = express();
const angularApp = new AngularNodeAppEngine();

/**
 * Example Express Rest API endpoints can be defined here.
 * Uncomment and define endpoints as necessary.
 *
 * Example:
 * ```ts
 * app.get('/api/{*splat}', (req, res) => {
 *   // Handle API request
 * });
 * ```
 */

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

/** GET /api/quotes?symbols=^NSEI,GC=F  -> latest price, change, volume */
app.get('/api/quotes', async (req, res) => {
  const symbols = String(req.query['symbols'] ?? '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 50);
  const out = await Promise.all(
    symbols.map(async (symbol) => {
      try {
        const r = await yahooChart(symbol, '1d', '5m', 4_000);
        const m = r.meta;
        const price = m.regularMarketPrice;
        const prev = m.chartPreviousClose ?? m.previousClose ?? price;
        return {
          symbol,
          price,
          change: price - prev,
          changePct: prev ? ((price - prev) / prev) * 100 : 0,
          volume: m.regularMarketVolume ?? 0,
          currency: m.currency ?? '',
          time: (m.regularMarketTime ?? 0) * 1000,
        };
      } catch (e) {
        return { symbol, error: (e as Error).message };
      }
    }),
  );
  res.json(out);
});

/** GET /api/history?symbol=^NSEI&range=1y&interval=1mo -> [{t, c}] */
app.get('/api/history', async (req, res) => {
  const symbol = String(req.query['symbol'] ?? '');
  const range = /^(1d|5d|1mo|3mo|6mo|1y|2y|3y|5y|10y|max)$/.test(String(req.query['range'])) ? String(req.query['range']) : '1y';
  const interval = /^(5m|15m|30m|1h|1d|1wk|1mo)$/.test(String(req.query['interval'])) ? String(req.query['interval']) : '1mo';
  try {
    const r = await yahooChart(symbol, range, interval, 60_000);
    const closes: (number | null)[] = r.indicators?.quote?.[0]?.close ?? [];
    const points = (r.timestamp ?? [])
      .map((t: number, i: number) => ({ t: t * 1000, c: closes[i] }))
      .filter((p: { c: number | null }) => p.c != null);
    res.json(points);
  } catch (e) {
    res.status(502).json({ error: (e as Error).message });
  }
});


/**
 * Serve static files from /browser
 */
app.use(
  express.static(browserDistFolder, {
    maxAge: '1y',
    index: false,
    redirect: false,
  }),
);

/**
 * Handle all other requests by rendering the Angular application.
 */
app.use((req, res, next) => {
  angularApp
    .handle(req)
    .then((response) =>
      response ? writeResponseToNodeResponse(response, res) : next(),
    )
    .catch(next);
});

/**
 * Start the server if this module is the main entry point, or it is ran via PM2.
 * The server listens on the port defined by the `PORT` environment variable, or defaults to 4000.
 */
if (isMainModule(import.meta.url) || process.env['pm_id']) {
  const port = process.env['PORT'] || 4000;
  app.listen(port, (error) => {
    if (error) {
      throw error;
    }

    console.log(`Node Express server listening on http://localhost:${port}`);
  });
}

/**
 * Request handler used by the Angular CLI (for dev-server and during build) or Firebase Cloud Functions.
 */
export const reqHandler = createNodeRequestHandler(app);
