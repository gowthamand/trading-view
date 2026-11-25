/** OroPocket gold/silver buy rates (INR per gram), exposed as pseudo-symbols OROPOCKET:GOLD / OROPOCKET:SILVER. */
const ORO_URL = 'https://api.oropocket.com/public/prices';
export const ORO_PREFIX = 'OROPOCKET:';

// The feed allows 10 requests/min per IP and refreshes every ~2 min, so one shared fetch per minute is plenty.
const TTL = 60_000;
let cache: { at: number; data: any } | null = null;
let inflight: Promise<any> | null = null;

async function prices() {
  if (cache && Date.now() - cache.at < TTL) return cache.data;
  inflight ??= fetch(ORO_URL)
    .then(async (res) => {
      if (!res.ok) throw new Error(`OroPocket: HTTP ${res.status}`);
      const json: any = await res.json();
      if (!json?.data) throw new Error('OroPocket: no data');
      cache = { at: Date.now(), data: json.data };
      return json.data;
    })
    .catch((e) => {
      if (cache) { cache.at = Date.now(); return cache.data; } // serve the last good quote on a 429 or outage, retry after TTL
      throw e;
    })
    .finally(() => { inflight = null; });
  return inflight;
}

export const isOro = (symbol: string) => symbol.startsWith(ORO_PREFIX);

/** OROPOCKET:GOLD -> quote in the same shape as getQuotes. */
export async function oroQuote(symbol: string) {
  const metal = symbol.slice(ORO_PREFIX.length).toLowerCase();
  const data = await prices();
  const m = data?.[metal];
  if (!m) throw new Error(`${symbol}: no data`);
  const price: number = m.buy;
  const changePct: number = m.change24h?.buy ?? 0;
  const prev = price / (1 + changePct / 100);
  return {
    symbol,
    price,
    change: price - prev,
    changePct,
    volume: 0,
    high52: 0,
    low52: 0,
    currency: m.currency ?? 'INR',
    time: Date.parse(data.timestamp) || Date.now(),
  };
}
