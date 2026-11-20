import { getQuotes } from './_yahoo.mjs';

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  return Response.json(await getQuotes(params.get('symbols')), {
    headers: { 'Cache-Control': 's-maxage=4, stale-while-revalidate=10' },
  });
}
