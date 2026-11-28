import { getQuotes } from './yahoo.js';

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  return Response.json(await getQuotes(params.get('symbols')), {
    headers: { 'Cache-Control': 's-maxage=4, stale-while-revalidate=10' },
  });
}
