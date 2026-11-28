import { getHistory } from './yahoo.js';

export async function GET(request: Request) {
  const p = new URL(request.url).searchParams;
  try {
    return Response.json(await getHistory(p.get('symbol'), p.get('range'), p.get('interval')), {
      headers: { 'Cache-Control': 's-maxage=10, stale-while-revalidate=30' },
    });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
