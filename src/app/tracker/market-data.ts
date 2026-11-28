import { Injectable, PLATFORM_ID, inject, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

export interface Quote {
  symbol: string;
  price: number;
  change: number;
  changePct: number;
  volume: number;
  high52?: number;
  low52?: number;
  currency: string;
  time: number;
  error?: string;
}

export interface Point { t: number; c: number; }

/** Live market data via the /api proxy in server.ts (Yahoo Finance). */
@Injectable({ providedIn: 'root' })
export class MarketData {
  private http = inject(HttpClient);
  private timer?: ReturnType<typeof setInterval>;
  private isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  readonly quotes = signal<Record<string, Quote>>({});
  /** Quotes from the previous poll, used to highlight ticks. */
  readonly prevQuotes = signal<Record<string, Quote>>({});
  readonly updatedAt = signal<number | null>(null);
  readonly error = signal<string | null>(null);
  readonly loading = signal(false);

  /** Start polling quotes for the given Yahoo symbols. */
  start(symbols: string[], everyMs = 5_000) {
    this.stop();
    // Never poll during prerender/SSR: the timer keeps the build busy and floods the log.
    if (!this.isBrowser) return;
    const load = () => this.refresh(symbols);
    load();
    this.timer = setInterval(load, everyMs);
  }

  stop() { if (this.timer) clearInterval(this.timer); }

  async refresh(symbols: string[]) {
    this.loading.set(true);
    try {
      const list = await firstValueFrom(this.http.get<Quote[]>('/api/quotes', { params: { symbols: symbols.join(',') } }));
      const map = { ...this.quotes() };
      for (const q of list) if (!q.error) map[q.symbol] = q;
      this.prevQuotes.set(this.quotes());
      this.quotes.set(map);
      this.updatedAt.set(Date.now());
      this.error.set(list.every((q) => q.error) ? 'No quotes returned' : null);
    } catch {
      this.error.set('Could not reach market data');
    } finally {
      this.loading.set(false);
    }
  }

  history(symbol: string, range = '1y', interval = '1mo') {
    return firstValueFrom(this.http.get<Point[]>('/api/history', { params: { symbol, range, interval, _: String(Date.now()) } }));
  }
}
