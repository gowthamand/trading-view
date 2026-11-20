import { getHistory } from './_yahoo.js';

export async function GET(request: Request) {
  const p = new URL(request.url).searchParams;
  try {
    return Response.json(await getHistory(p.get('symbol'), p.get('range'), p.get('interval')), {
      headers: { 'Cache-Control': 's-maxage=60, stale-while-revalidate=300' },
    });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
