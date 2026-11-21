import { Component, DestroyRef, ElementRef, afterNextRender, computed, effect, inject, signal, untracked } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { MarketData, Point } from './market-data';

const POLL_MS = 5_000;
const POLL_SECS = POLL_MS / 1000;

const CURRENCY_SIGNS: Record<string, string> = {
  USD: '$', INR: '\u20b9', EUR: '\u20ac', GBP: '\u00a3', JPY: '\u00a5', CNY: '\u00a5',
  AUD: 'A$', CAD: 'C$', HKD: 'HK$', SGD: 'S$', CHF: 'CHF\u00a0', KRW: '\u20a9', BRL: 'R$',
};

/** Static definition; live numbers come from MarketData. `yahoo` is the feed ticker. */
interface Def { symbol: string; yahoo: string; name: string; group: string; }

export interface Instrument extends Def {
  last: number;
  change: number;
  changePct: number;
  volume: number;
  high52: number;
  low52: number;
  currency: string;
  live: boolean;
}

type Tab = 'indices' | 'futures' | 'commodities' | 'stocks' | 'currencies';
type SortKey = 'symbol' | 'group' | 'last' | 'changePct' | 'volume' | 'high52' | 'low52';
type Range = '1D' | '1W' | '1M' | '3M' | '6M' | '1Y' | '3Y' | '5Y' | '10Y' | 'ALL';

/** Button -> Yahoo range, bar interval and axis date format. */
const RANGES: Record<Range, { range: string; interval: string; axis: string; tip: string }> = {
  '1D': { range: '1d', interval: '5m', axis: 'HH:mm', tip: 'MMM d, HH:mm' },
  '1W': { range: '5d', interval: '30m', axis: 'EEE d', tip: 'EEE MMM d, HH:mm' },
  '1M': { range: '1mo', interval: '1d', axis: 'MMM d', tip: 'MMM d, y' },
  '3M': { range: '3mo', interval: '1d', axis: 'MMM d', tip: 'MMM d, y' },
  '6M': { range: '6mo', interval: '1d', axis: 'MMM d', tip: 'MMM d, y' },
  '1Y': { range: '1y', interval: '1d', axis: 'MMM yy', tip: 'MMM d, y' },
  '3Y': { range: '3y', interval: '1wk', axis: 'MMM yy', tip: 'MMM d, y' },
  '5Y': { range: '5y', interval: '1wk', axis: 'MMM yy', tip: 'MMM d, y' },
  '10Y': { range: '10y', interval: '1mo', axis: 'y', tip: 'MMM y' },
  'ALL': { range: 'max', interval: '1mo', axis: 'y', tip: 'MMM y' },
};

/** Company websites, used to fetch each stock's logo (favicon). Stocks whose site has
 *  no favicon on Google's service are left out and show coloured initials instead. */
const STOCK_DOMAINS: Record<string, string> = {
  RELIANCE: 'ril.com', TCS: 'www.tcs.com', HDFCBANK: 'hdfcbank.com', ICICIBANK: 'icicibank.com', INFY: 'infosys.com',
  SBIN: 'onlinesbi.sbi', BHARTIARTL: 'airtel.in', LT: 'larsentoubro.com', TMCV: 'tatamotors.com',
  SOUTHBANK: 'southindianbank.com', TATASTEEL: 'tatasteel.com', TMB: 'tmb.in',
  TATACHEM: 'tatachemicals.com', MANAPPURAM: 'manappuram.com', KTKBANK: 'karnatakabank.com',
  DRREDDY: 'drreddys.com', SENCO: 'sencogoldanddiamonds.com',
  NATCOPHARM: 'natcopharma.co.in', WIPRO: 'wipro.com', ZYDUSLIFE: 'zyduslife.com',
  TMPV: 'tatamotors.com', ITCHOTELS: 'itchotels.com', IDFCFIRSTB: 'idfcfirstbank.com', SPANDANA: 'spandanasphoorty.com',
  INDUSINDBK: 'indusind.com', AAPL: 'apple.com', MSFT: 'microsoft.com', NVDA: 'nvidia.com', AMZN: 'amazon.com',
  GOOGL: 'google.com', META: 'meta.com', TSLA: 'tesla.com',
};

/** Logo URL for a stock symbol, or '' when unknown. */
export function logoUrl(symbol: string) {
  const d = STOCK_DOMAINS[symbol];
  return d ? `https://www.google.com/s2/favicons?domain=${d}&sz=64` : '';
}

/** Stable, distinct colour per symbol for the initials fallback. */
function symbolColor(symbol: string) {
  let h = 0;
  for (const c of symbol) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 62% 42%)`;
}

/** sessionStorage key for the current tab, group filter and chart. */
const VIEW_KEY = 'tracker.view';
// Theme outlives the tab, so it goes in localStorage rather than sessionStorage.
const THEME_KEY = 'tracker.theme';

@Component({
  selector: 'app-tracker',
  imports: [DecimalPipe, DatePipe],
  templateUrl: './tracker.html',
  styleUrl: './tracker.scss',
})
export class Tracker {
  readonly md = inject(MarketData);
  private readonly destroyRef = inject(DestroyRef);

  readonly tabs: { key: Tab; label: string }[] = [
    { key: 'indices', label: 'Indices' },
    { key: 'futures', label: 'Futures' },
    { key: 'commodities', label: 'Commodities' },
    { key: 'stocks', label: 'Stocks' },
    { key: 'currencies', label: 'Currencies' },
  ];

  readonly defs: Record<Tab, Def[]> = {
    indices: [
      { symbol: 'NIFTY', yahoo: '^NSEI', name: 'Nifty 50', group: 'India' },
      { symbol: 'SENSEX', yahoo: '^BSESN', name: 'BSE Sensex', group: 'India' },
      { symbol: 'BANKNIFTY', yahoo: '^NSEBANK', name: 'Nifty Bank', group: 'India' },
      { symbol: 'MIDCPNIFTY', yahoo: 'NIFTY_MID_SELECT.NS', name: 'Nifty Midcap Select', group: 'India' },
      { symbol: 'FINNIFTY', yahoo: 'NIFTY_FIN_SERVICE.NS', name: 'Nifty Financial Services', group: 'India' },
      { symbol: 'NIFTYNXT50', yahoo: '^NSMIDCP', name: 'Nifty Next 50', group: 'India' },
      { symbol: 'NIFTYMID100', yahoo: 'NIFTY_MIDCAP_100.NS', name: 'Nifty Midcap 100', group: 'India' },
      { symbol: 'CNXIT', yahoo: '^CNXIT', name: 'Nifty IT', group: 'India' },
      { symbol: 'CNXPHARMA', yahoo: '^CNXPHARMA', name: 'Nifty Pharma', group: 'India' },
      { symbol: 'CNXAUTO', yahoo: '^CNXAUTO', name: 'Nifty Auto', group: 'India' },
      { symbol: 'CNXFMCG', yahoo: '^CNXFMCG', name: 'Nifty FMCG', group: 'India' },
      { symbol: 'CNXMETAL', yahoo: '^CNXMETAL', name: 'Nifty Metal', group: 'India' },
      { symbol: 'INDIAVIX', yahoo: '^INDIAVIX', name: 'India VIX', group: 'India' },
      { symbol: 'SPX', yahoo: '^GSPC', name: 'S&P 500', group: 'US' },
      { symbol: 'DJI', yahoo: '^DJI', name: 'Dow Jones', group: 'US' },
      { symbol: 'BANK', yahoo: '^BKX', name: 'KBW Nasdaq Bank', group: 'US' },
      { symbol: 'IXIC', yahoo: '^IXIC', name: 'Nasdaq Composite', group: 'US' },
      { symbol: 'NDX', yahoo: '^NDX', name: 'Nasdaq 100', group: 'US' },
      { symbol: 'RUT', yahoo: '^RUT', name: 'Russell 2000', group: 'US' },
      { symbol: 'VIX', yahoo: '^VIX', name: 'CBOE Volatility Index', group: 'US' },
      { symbol: 'RUI', yahoo: '^RUI', name: 'Russell 1000', group: 'US' },
      { symbol: 'RUA', yahoo: '^RUA', name: 'Russell 3000', group: 'US' },
      { symbol: 'SP400', yahoo: '^SP400', name: 'S&P MidCap 400', group: 'US' },
      { symbol: 'SP600', yahoo: '^SP600', name: 'S&P SmallCap 600', group: 'US' },
      { symbol: 'SPXEW', yahoo: '^SPXEW', name: 'S&P 500 Equal Weight', group: 'US' },
      { symbol: 'NDXE', yahoo: '^NDXE', name: 'Nasdaq 100 Equal Weight', group: 'US' },
      { symbol: 'W5000', yahoo: '^W5000', name: 'Wilshire 5000', group: 'US' },
      { symbol: 'NYA', yahoo: '^NYA', name: 'NYSE Composite', group: 'US' },
      { symbol: 'XAX', yahoo: '^XAX', name: 'NYSE American Composite', group: 'US' },
      { symbol: 'DJT', yahoo: '^DJT', name: 'Dow Jones Transportation', group: 'US' },
      { symbol: 'DJU', yahoo: '^DJU', name: 'Dow Jones Utilities', group: 'US' },
      { symbol: 'SOX', yahoo: '^SOX', name: 'PHLX Semiconductor', group: 'US' },
      { symbol: 'NBI', yahoo: '^NBI', name: 'Nasdaq Biotechnology', group: 'US' },
      { symbol: 'HUI', yahoo: '^HUI', name: 'NYSE Arca Gold Bugs', group: 'US' },
      { symbol: 'XOI', yahoo: '^XOI', name: 'NYSE Arca Oil', group: 'US' },
      { symbol: 'NI225', yahoo: '^N225', name: 'Nikkei 225', group: 'Asia' },
      { symbol: 'HSI', yahoo: '^HSI', name: 'Hang Seng', group: 'Asia' },
      { symbol: 'STI', yahoo: '^STI', name: 'Straits Times', group: 'Asia' },
      { symbol: 'KOSPI', yahoo: '^KS11', name: 'KOSPI Composite', group: 'Asia' },
      { symbol: 'SSE', yahoo: '000001.SS', name: 'Shanghai Composite', group: 'Asia' },
      { symbol: 'ASX200', yahoo: '^AXJO', name: 'S&P/ASX 200', group: 'Asia' },
      { symbol: 'TAIEX', yahoo: '^TWII', name: 'Taiwan Weighted', group: 'Asia' },
      { symbol: 'SMI', yahoo: '^SSMI', name: 'Swiss Market Index', group: 'Europe' },
      { symbol: 'FTSE', yahoo: '^FTSE', name: 'FTSE 100', group: 'Europe' },
      { symbol: 'DAX', yahoo: '^GDAXI', name: 'DAX', group: 'Europe' },
      { symbol: 'FRA40', yahoo: '^FCHI', name: 'CAC 40', group: 'Europe' },
      { symbol: 'IBEX35', yahoo: '^IBEX', name: 'IBEX 35', group: 'Europe' },
      { symbol: 'SX5E', yahoo: '^STOXX50E', name: 'Euro Stoxx 50', group: 'Europe' },
      { symbol: 'AEX', yahoo: '^AEX', name: 'AEX', group: 'Europe' },
    ],
    futures: [
      { symbol: 'NKD1!', yahoo: 'NKD=F', name: 'Nikkei 225 (USD)', group: 'Global Index' },
      { symbol: 'NIY1!', yahoo: 'NIY=F', name: 'Nikkei 225 (Yen)', group: 'Global Index' },
      { symbol: 'MNI1!', yahoo: 'MNI=F', name: 'Micro Nikkei (Yen)', group: 'Global Index' },
      { symbol: 'ZN1!', yahoo: 'ZN=F', name: '10-Year T-Note', group: 'Rates' },
      { symbol: 'ZT1!', yahoo: 'ZT=F', name: '2-Year T-Note', group: 'Rates' },
      { symbol: 'ZF1!', yahoo: 'ZF=F', name: '5-Year T-Note', group: 'Rates' },
      { symbol: 'ZB1!', yahoo: 'ZB=F', name: '30-Year T-Bond', group: 'Rates' },
      { symbol: 'MGC1!', yahoo: 'MGC=F', name: 'Micro Gold', group: 'Metals' },
      { symbol: 'BTC1!', yahoo: 'BTC=F', name: 'Bitcoin Futures', group: 'Crypto' },
      { symbol: 'ETH1!', yahoo: 'ETH=F', name: 'Ether Futures', group: 'Crypto' },
    ],
    commodities: [
      { symbol: 'GC1!', yahoo: 'GC=F', name: 'Gold', group: 'Metals' },
      { symbol: 'SI1!', yahoo: 'SI=F', name: 'Silver', group: 'Metals' },
      { symbol: 'HG1!', yahoo: 'HG=F', name: 'Copper', group: 'Metals' },
      { symbol: 'PL1!', yahoo: 'PL=F', name: 'Platinum', group: 'Metals' },
      { symbol: 'PA1!', yahoo: 'PA=F', name: 'Palladium', group: 'Metals' },
      { symbol: 'ALI1!', yahoo: 'ALI=F', name: 'Aluminum', group: 'Metals' },
      { symbol: 'BRENT', yahoo: 'BZ=F', name: 'Brent Crude', group: 'Energy' },
      { symbol: 'CL1!', yahoo: 'CL=F', name: 'WTI Crude', group: 'Energy' },
      { symbol: 'NG1!', yahoo: 'NG=F', name: 'Natural Gas', group: 'Energy' },
      { symbol: 'HO1!', yahoo: 'HO=F', name: 'Heating Oil', group: 'Energy' },
      { symbol: 'RB1!', yahoo: 'RB=F', name: 'RBOB Gasoline', group: 'Energy' },
      { symbol: 'ZW1!', yahoo: 'ZW=F', name: 'Wheat', group: 'Agriculture' },
      { symbol: 'ZC1!', yahoo: 'ZC=F', name: 'Corn', group: 'Agriculture' },
      { symbol: 'ZS1!', yahoo: 'ZS=F', name: 'Soybeans', group: 'Agriculture' },
      { symbol: 'ZO1!', yahoo: 'ZO=F', name: 'Oats', group: 'Agriculture' },
      { symbol: 'ZR1!', yahoo: 'ZR=F', name: 'Rough Rice', group: 'Agriculture' },
      { symbol: 'KC1!', yahoo: 'KC=F', name: 'Coffee', group: 'Agriculture' },
      { symbol: 'SB1!', yahoo: 'SB=F', name: 'Sugar', group: 'Agriculture' },
      { symbol: 'CT1!', yahoo: 'CT=F', name: 'Cotton', group: 'Agriculture' },
      { symbol: 'CC1!', yahoo: 'CC=F', name: 'Cocoa', group: 'Agriculture' },
      { symbol: 'LE1!', yahoo: 'LE=F', name: 'Live Cattle', group: 'Livestock' },
    ],
    stocks: [
      { symbol: 'RELIANCE', yahoo: 'RELIANCE.NS', name: 'Reliance Industries', group: 'India' },
      { symbol: 'TCS', yahoo: 'TCS.NS', name: 'Tata Consultancy Services', group: 'India' },
      { symbol: 'HDFCBANK', yahoo: 'HDFCBANK.NS', name: 'HDFC Bank', group: 'India' },
      { symbol: 'ICICIBANK', yahoo: 'ICICIBANK.NS', name: 'ICICI Bank', group: 'India' },
      { symbol: 'INFY', yahoo: 'INFY.NS', name: 'Infosys', group: 'India' },
      { symbol: 'SBIN', yahoo: 'SBIN.NS', name: 'State Bank of India', group: 'India' },
      { symbol: 'BHARTIARTL', yahoo: 'BHARTIARTL.NS', name: 'Bharti Airtel', group: 'India' },
      { symbol: 'ITC', yahoo: 'ITC.NS', name: 'ITC', group: 'India' },
      { symbol: 'LT', yahoo: 'LT.NS', name: 'Larsen & Toubro', group: 'India' },
      { symbol: 'TMCV', yahoo: 'TMCV.NS', name: 'Tata Motors', group: 'India' },
      { symbol: 'SOUTHBANK', yahoo: 'SOUTHBANK.NS', name: 'South Indian Bank', group: 'India' },
      { symbol: 'FUSION', yahoo: 'FUSION.NS', name: 'Fusion Finance', group: 'India' },
      { symbol: 'TATASTEEL', yahoo: 'TATASTEEL.NS', name: 'Tata Steel', group: 'India' },
      { symbol: 'TMB', yahoo: 'TMB.NS', name: 'Tamilnad Mercantile Bank', group: 'India' },
      { symbol: 'ARE&M', yahoo: 'ARE&M.NS', name: 'Amara Raja Energy & Mobility', group: 'India' },
      { symbol: 'TATACHEM', yahoo: 'TATACHEM.NS', name: 'Tata Chemicals', group: 'India' },
      { symbol: 'MANAPPURAM', yahoo: 'MANAPPURAM.NS', name: 'Manappuram Finance', group: 'India' },
      { symbol: 'KTKBANK', yahoo: 'KTKBANK.NS', name: 'Karnataka Bank', group: 'India' },
      { symbol: 'PETRONET', yahoo: 'PETRONET.NS', name: 'Petronet LNG', group: 'India' },
      { symbol: 'DRREDDY', yahoo: 'DRREDDY.NS', name: "Dr. Reddy's Laboratories", group: 'India' },
      { symbol: 'SENCO', yahoo: 'SENCO.NS', name: 'Senco Gold', group: 'India' },
      { symbol: 'JYOTHYLAB', yahoo: 'JYOTHYLAB.NS', name: 'Jyothy Labs', group: 'India' },
      { symbol: 'NATCOPHARM', yahoo: 'NATCOPHARM.NS', name: 'NATCO Pharma', group: 'India' },
      { symbol: 'WIPRO', yahoo: 'WIPRO.NS', name: 'Wipro', group: 'India' },
      { symbol: 'ZYDUSLIFE', yahoo: 'ZYDUSLIFE.NS', name: 'Zydus Lifesciences', group: 'India' },
      { symbol: 'BIOCON', yahoo: 'BIOCON.NS', name: 'Biocon', group: 'India' },
      { symbol: 'TMPV', yahoo: 'TMPV.NS', name: 'Tata Motors Passenger Vehicles', group: 'India' },
      { symbol: 'ITCHOTELS', yahoo: 'ITCHOTELS.NS', name: 'ITC Hotels', group: 'India' },
      { symbol: 'IDFCFIRSTB', yahoo: 'IDFCFIRSTB.NS', name: 'IDFC First Bank', group: 'India' },
      { symbol: 'SPANDANA', yahoo: 'SPANDANA.NS', name: 'Spandana Sphoorty Financial', group: 'India' },
      { symbol: 'INDUSINDBK', yahoo: 'INDUSINDBK.NS', name: 'IndusInd Bank', group: 'India' },
      { symbol: 'AAPL', yahoo: 'AAPL', name: 'Apple', group: 'US' },
      { symbol: 'MSFT', yahoo: 'MSFT', name: 'Microsoft', group: 'US' },
      { symbol: 'NVDA', yahoo: 'NVDA', name: 'NVIDIA', group: 'US' },
      { symbol: 'AMZN', yahoo: 'AMZN', name: 'Amazon', group: 'US' },
      { symbol: 'GOOGL', yahoo: 'GOOGL', name: 'Alphabet', group: 'US' },
      { symbol: 'META', yahoo: 'META', name: 'Meta Platforms', group: 'US' },
      { symbol: 'TSLA', yahoo: 'TSLA', name: 'Tesla', group: 'US' },
    ],
    currencies: [
      { symbol: 'USDINR', yahoo: 'USDINR=X', name: 'US Dollar / Rupee', group: 'INR' },
      { symbol: 'EURINR', yahoo: 'EURINR=X', name: 'Euro / Rupee', group: 'INR' },
      { symbol: 'GBPINR', yahoo: 'GBPINR=X', name: 'British Pound / Rupee', group: 'INR' },
      { symbol: 'JPYINR', yahoo: 'JPYINR=X', name: 'Japanese Yen / Rupee', group: 'INR' },
      { symbol: 'SGDINR', yahoo: 'SGDINR=X', name: 'Singapore Dollar / Rupee', group: 'INR' },
      { symbol: 'AEDINR', yahoo: 'AEDINR=X', name: 'UAE Dirham / Rupee', group: 'INR' },
      { symbol: 'AUDINR', yahoo: 'AUDINR=X', name: 'Australian Dollar / Rupee', group: 'INR' },
      { symbol: 'CADINR', yahoo: 'CADINR=X', name: 'Canadian Dollar / Rupee', group: 'INR' },
      { symbol: 'CHFINR', yahoo: 'CHFINR=X', name: 'Swiss Franc / Rupee', group: 'INR' },
      { symbol: 'CNYINR', yahoo: 'CNYINR=X', name: 'Chinese Yuan / Rupee', group: 'INR' },
      { symbol: 'EURUSD', yahoo: 'EURUSD=X', name: 'Euro / US Dollar', group: 'Majors' },
      { symbol: 'GBPUSD', yahoo: 'GBPUSD=X', name: 'British Pound / US Dollar', group: 'Majors' },
      { symbol: 'USDJPY', yahoo: 'USDJPY=X', name: 'US Dollar / Yen', group: 'Majors' },
      { symbol: 'AUDUSD', yahoo: 'AUDUSD=X', name: 'Australian Dollar / US Dollar', group: 'Majors' },
      { symbol: 'USDCAD', yahoo: 'USDCAD=X', name: 'US Dollar / Canadian Dollar', group: 'Majors' },
      { symbol: 'USDCHF', yahoo: 'USDCHF=X', name: 'US Dollar / Swiss Franc', group: 'Majors' },
      { symbol: 'NZDUSD', yahoo: 'NZDUSD=X', name: 'New Zealand Dollar / US Dollar', group: 'Majors' },
      { symbol: 'USDCNY', yahoo: 'USDCNY=X', name: 'US Dollar / Yuan', group: 'Majors' },
      { symbol: 'USDSGD', yahoo: 'USDSGD=X', name: 'US Dollar / Singapore Dollar', group: 'Majors' },
      { symbol: 'USDHKD', yahoo: 'USDHKD=X', name: 'US Dollar / Hong Kong Dollar', group: 'Majors' },
      { symbol: 'DXY', yahoo: 'DX-Y.NYB', name: 'US Dollar Index', group: 'Majors' },
      { symbol: 'BTCUSD', yahoo: 'BTC-USD', name: 'Bitcoin / US Dollar', group: 'Crypto' },
      { symbol: 'ETHUSD', yahoo: 'ETH-USD', name: 'Ether / US Dollar', group: 'Crypto' },
      { symbol: 'SOLUSD', yahoo: 'SOL-USD', name: 'Solana / US Dollar', group: 'Crypto' },
      { symbol: 'XRPUSD', yahoo: 'XRP-USD', name: 'XRP / US Dollar', group: 'Crypto' },
    ],
  };

  /** Grouped watchlist (right panel). */
  readonly watchDefs: { name: string; items: (Def & { icon: string; color: string })[] }[] = [
    { name: 'INDIA INDEX', items: [
      { symbol: 'NIFTY', yahoo: '^NSEI', name: 'Nifty 50', group: 'India', icon: '50', color: '#2a2e7a' },
      { symbol: 'SENSEX', yahoo: '^BSESN', name: 'BSE Sensex', group: 'India', icon: 'BSE', color: '#2f8ae0' },
      { symbol: 'BANKNIFTY', yahoo: '^NSEBANK', name: 'Nifty Bank', group: 'India', icon: 'BN', color: '#2a2e7a' },
      { symbol: 'MIDCPNIFTY', yahoo: 'NIFTY_MID_SELECT.NS', name: 'Nifty Midcap Select', group: 'India', icon: 'MID', color: '#5b3cc4' },
      { symbol: 'FINNIFTY', yahoo: 'NIFTY_FIN_SERVICE.NS', name: 'Nifty Financial Services', group: 'India', icon: 'FIN', color: '#0f8a5f' },
    ]},
    { name: 'COMMODITIES', items: [
      { symbol: 'GC1!', yahoo: 'GC=F', name: 'Gold', group: 'Metals', icon: 'Au', color: '#e0a526' },
      { symbol: 'SILVER1!', yahoo: 'SI=F', name: 'Silver', group: 'Metals', icon: 'Ag', color: '#a5a8b8' },
      { symbol: 'BRENT', yahoo: 'BZ=F', name: 'Brent Crude', group: 'Energy', icon: '●', color: '#131722' },
    ]},
    { name: 'FOREX', items: [
      { symbol: 'USDINR', yahoo: 'USDINR=X', name: 'US Dollar / Rupee', group: 'Forex', icon: '$', color: '#3c6bd8' },
      { symbol: 'SGDINR', yahoo: 'SGDINR=X', name: 'Singapore Dollar / Rupee', group: 'Forex', icon: 'S$', color: '#e04646' },
      { symbol: 'BTCUSD', yahoo: 'BTC-USD', name: 'Bitcoin / US Dollar', group: 'Crypto', icon: '₿', color: '#f7931a' },
      { symbol: 'USDCNY', yahoo: 'USDCNY=X', name: 'US Dollar / Yuan', group: 'Forex', icon: '¥', color: '#d93b3b' },
      { symbol: 'DXY', yahoo: 'DX-Y.NYB', name: 'US Dollar Index', group: 'Forex', icon: '$', color: '#0f8a5f' },
    ]},
    { name: 'US INDEX', items: [
      { symbol: 'SPX', yahoo: '^GSPC', name: 'S&P 500', group: 'US', icon: '500', color: '#d9262f' },
      { symbol: 'DJI', yahoo: '^DJI', name: 'Dow Jones', group: 'US', icon: '30', color: '#1e9bd7' },
      { symbol: 'BANK', yahoo: '^BKX', name: 'KBW Nasdaq Bank', group: 'US', icon: 'B', color: '#9aa0ae' },
      { symbol: 'IXIC', yahoo: '^IXIC', name: 'Nasdaq Composite', group: 'US', icon: 'IX', color: '#2f7fb8' },
      { symbol: 'NDX', yahoo: '^NDX', name: 'Nasdaq 100', group: 'US', icon: '100', color: '#2f7fb8' },
    ]},
    { name: 'ASIA INDEX', items: [
      { symbol: 'NI225', yahoo: '^N225', name: 'Nikkei 225', group: 'Asia', icon: '225', color: '#2a3f7a' },
      { symbol: 'HSI', yahoo: '^HSI', name: 'Hang Seng', group: 'Asia', icon: 'HS', color: '#c8102e' },
      { symbol: 'STI', yahoo: '^STI', name: 'Straits Times', group: 'Asia', icon: 'STI', color: '#1d2a5c' },
      { symbol: 'KOSPI', yahoo: '^KS11', name: 'KOSPI Composite', group: 'Asia', icon: 'KS', color: '#4aa3d8' },
    ]},
    { name: 'EUROPE INDEX', items: [
      { symbol: 'SMI', yahoo: '^SSMI', name: 'Swiss Market Index', group: 'Europe', icon: 'SMI', color: '#c0392b' },
      { symbol: 'FTSE', yahoo: '^FTSE', name: 'FTSE 100', group: 'Europe', icon: '100', color: '#3d5a80' },
      { symbol: 'DAX', yahoo: '^GDAXI', name: 'DAX', group: 'Europe', icon: 'DAX', color: '#3c5fb0' },
      { symbol: 'FRA40', yahoo: '^FCHI', name: 'CAC 40', group: 'Europe', icon: '40', color: '#2f7d6d' },
      { symbol: 'IBEX35', yahoo: '^IBEX', name: 'IBEX 35', group: 'Europe', icon: '35', color: '#1d2a5c' },
    ]},
  ];
  /** Right panel shows either the mixed watchlist or the stock list (India / US). */
  readonly listMode = signal<'watch' | 'stocks'>('watch');
  readonly listMenuOpen = signal(false);
  setListMode(m: 'watch' | 'stocks') { this.listMode.set(m); this.listMenuOpen.set(false); }

  /** Stocklist groups, built from the Stocks tab so both stay in sync. */
  private readonly stockDefs = [
    { name: 'INDIAN STOCKS', group: 'India', color: '#0f8a5f' },
    { name: 'US STOCKS', group: 'US', color: '#3c6bd8' },
  ].map((g) => ({
    name: g.name,
    items: this.defs.stocks.filter((d) => d.group === g.group).map((d) => ({ ...d, icon: d.symbol.slice(0, 2), color: symbolColor(d.symbol) })),
  }));

  readonly watchCollapsed = signal<Set<string>>(new Set());

  readonly logoUrl = logoUrl;
  readonly symbolColor = symbolColor;
  /** Symbols whose logo failed to load; they fall back to coloured initials. */
  readonly brokenLogos = signal<Set<string>>(new Set());
  logoFailed(symbol: string) { this.brokenLogos.update((s) => new Set(s).add(symbol)); }

  readonly tab = signal<Tab>('indices');
  readonly query = signal('');
  readonly sortKey = signal<SortKey>('changePct'); // biggest fallers first
  readonly sortAsc = signal(true);

  /** Merge static defs with the latest quotes. */
  private withQuotes(list: Def[]): Instrument[] {
    const q = this.md.quotes();
    return list.map((d) => {
      const x = q[d.yahoo];
      return { ...d, last: x?.price ?? 0, change: x?.change ?? 0, changePct: x?.changePct ?? 0, volume: x?.volume ?? 0, high52: x?.high52 ?? 0, low52: x?.low52 ?? 0, currency: x?.currency ?? '', live: !!x };
    });
  }

  readonly data = computed(() => ({
    indices: this.withQuotes(this.defs.indices),
    futures: this.withQuotes(this.defs.futures),
    commodities: this.withQuotes(this.defs.commodities),
    stocks: this.withQuotes(this.defs.stocks),
    currencies: this.withQuotes(this.defs.currencies),
  }));
  readonly all = computed(() => [...this.data().indices, ...this.data().futures, ...this.data().commodities, ...this.data().stocks, ...this.data().currencies]);
  readonly liveAll = computed(() => this.all().filter((r) => r.live));
  readonly gainers = computed(() => this.liveAll().filter((r) => r.changePct > 0).length);
  readonly best = computed(() => this.liveAll().reduce<Instrument | null>((a, b) => (!a || b.changePct > a.changePct ? b : a), null));
  readonly watchGroups = computed(() =>
    (this.listMode() === 'stocks' ? this.stockDefs : this.watchDefs).map((g) => ({
      name: g.name,
      rows: this.withQuotes(g.items).map((r) => ({ ...r, icon: (r as any).icon as string, color: (r as any).color as string, ...this.tick(r.yahoo, r.last) })),
    })),
  );
  /** Every instrument shown anywhere, for chart lookups. */
  readonly everything = computed(() => [...this.all(), ...this.watchGroups().flatMap((g) => g.rows)]);

  /**
   * The headline price split into characters. Each carries a `key`: unchanged characters keep
   * a stable one, changed characters get a fresh one so Angular recreates the node and the
   * roll animation replays. `dir` is the direction of the move.
   */
  readonly priceChars = signal<{ ch: string; key: string; dir: number }[]>([]);
  private charSeq = 0;

  /** Rebuild the headline characters whenever the charted price changes. */
  private watchDigits() {
    effect(() => {
      const d = this.chartDef();
      const text = d?.live ? this.cur(d.currency) + this.fmtPrice(d.last) : '\u2014';
      const prev = untracked(this.priceChars);
      const prevText = prev.map((c) => c.ch).join('');
      if (text === prevText) return;
      const before = this.md.prevQuotes()[d?.yahoo ?? '']?.price;
      const dir = before === undefined || !d?.last ? 0 : d.last > before ? 1 : d.last < before ? -1 : 0;
      this.charSeq++;
      this.priceChars.set([...text].map((ch, i) => ({
        ch,
        key: ch === prevText[i] ? `k${i}` : `k${i}-${this.charSeq}`,
        dir: ch === prevText[i] ? 0 : dir,
      })));
    });
  }

  /** The chosen mode. 'auto' follows the OS and keeps following it as it changes. */
  readonly themeMode = signal<'light' | 'dark' | 'auto'>('auto');
  /** What the OS currently asks for; kept current by a media-query listener. */
  private readonly systemDark = signal(false);
  /** The mode actually rendered, once 'auto' is resolved. */
  readonly theme = computed<'light' | 'dark'>(() =>
    this.themeMode() === 'auto' ? (this.systemDark() ? 'dark' : 'light') : (this.themeMode() as 'light' | 'dark'),
  );

  /** Cycle light -> dark -> auto. */
  toggleTheme() {
    const order = ['light', 'dark', 'auto'] as const;
    const next = order[(order.indexOf(this.themeMode()) + 1) % order.length];
    this.themeMode.set(next);
    this.applyTheme();
    try { localStorage.setItem(THEME_KEY, next); } catch { /* storage unavailable */ }
  }

  /** Restore the saved mode and keep the document class in step with the resolved theme. */
  private restoreTheme() {
    let saved: string | null = null;
    try { saved = localStorage.getItem(THEME_KEY); } catch { /* storage unavailable */ }
    this.themeMode.set(saved === 'dark' || saved === 'light' || saved === 'auto' ? saved : 'auto');

    if (typeof matchMedia !== 'undefined') {
      const mq = matchMedia('(prefers-color-scheme: dark)');
      this.systemDark.set(mq.matches);
      // Follow the OS live, so 'auto' flips at sunset without a reload.
      const onChange = (e: MediaQueryListEvent) => { this.systemDark.set(e.matches); this.applyTheme(); };
      mq.addEventListener('change', onChange);
      this.destroyRef.onDestroy(() => mq.removeEventListener('change', onChange));
    }

    this.applyTheme();
  }

  /** The class lives on <html> so the page backdrop changes too, not just the component. */
  private applyTheme() {
    document.documentElement.classList.toggle('dark', this.theme() === 'dark');
  }

  /** Decimals for a price: two, but none once the number runs past four digits. */
  dp(n: number) { return Math.abs(n) >= 10_000 ? '1.0-0' : '1.2-2'; }

  /** Format a price the same way the templates do. */
  private fmtPrice(n: number) {
    const d = Math.abs(n) >= 10_000 ? 0 : 2;
    return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  /** Short symbol for a currency code; unknown codes fall back to the code itself. */
  cur(code: string) { return code ? (CURRENCY_SIGNS[code] ?? code + '\u00a0') : ''; }

  /** Split the price into an unchanged prefix and a changed suffix, plus tick direction. */
  private tick(yahoo: string, last: number) {
    const fmt = (n: number) => this.fmtPrice(n);
    const now = last ? fmt(last) : '—';
    const prev = this.md.prevQuotes()[yahoo]?.price;
    if (!prev || prev === last) return { head: now, tail: '', dir: 0 };
    const p = fmt(prev);
    let i = 0;
    while (i < now.length && now[i] === p[i]) i++;
    return { head: now.slice(0, i), tail: now.slice(i), dir: last > prev ? 1 : -1 };
  }

  toggleWatchGroup(name: string) {
    const s = new Set(this.watchCollapsed());
    s.has(name) ? s.delete(name) : s.add(name);
    this.watchCollapsed.set(s);
  }

  readonly groups = computed(() => {
    const map = new Map<string, Instrument[]>();
    for (const r of this.data()[this.tab()]) map.set(r.group, [...(map.get(r.group) ?? []), r]);
    return [...map].map(([name, list], i) => {
      const live = list.filter((r) => r.live);
      return {
        name,
        count: list.length,
        avg: live.length ? live.reduce((s, r) => s + r.changePct, 0) / live.length : 0,
        color: ['#ff6b3d', '#3b5bfd', '#1fb6e8', '#8b3dff'][i % 4],
      };
    });
  });

  /** Group card selected to filter the table (e.g. India / US); null shows all. */
  readonly groupFilter = signal<string | null>(null);
  toggleGroup(name: string) { this.groupFilter.set(this.groupFilter() === name ? null : name); }

  readonly rows = computed(() => {
    const q = this.query().trim().toLowerCase();
    const key = this.sortKey();
    const dir = this.sortAsc() ? 1 : -1;
    const g = this.groupFilter();
    return this.data()[this.tab()]
      .filter((r) => !g || r.group === g)
      .filter((r) => !q || `${r.symbol} ${r.name} ${r.group}`.toLowerCase().includes(q))
      .sort((a, b) => (a[key] > b[key] ? 1 : a[key] < b[key] ? -1 : 0) * dir);
  });

  // ---- Chart (history for the selected instrument) ----
  readonly ranges = Object.keys(RANGES) as Range[];
  readonly rangeCfg = computed(() => RANGES[this.range()]);
  readonly chartSymbol = signal('NIFTY');
  readonly range = signal<Range>('1D');
  readonly series = signal<Point[]>([]);
  readonly chartLoading = signal(false);
  readonly hover = signal(-1);
  readonly W = 800; readonly H = 220;

  readonly chartDef = computed(() => this.everything().find((r) => r.symbol === this.chartSymbol())!);
  /** Watchlist icons by Yahoo ticker, so every table and the chart reuse them. */
  private readonly watchIcons = new Map(this.watchDefs.flatMap((g) => g.items).map((i) => [i.yahoo, { icon: i.icon, color: i.color }]));
  /** Badge for any instrument: its watchlist icon if there is one, otherwise coloured initials. */
  badge(symbol: string, yahoo?: string) {
    const w = (yahoo && this.watchIcons.get(yahoo)) || this.watchDefs.flatMap((g) => g.items).find((i) => i.symbol === symbol);
    return w ? { icon: w.icon, color: w.color } : { icon: symbol.replace(/[^A-Z0-9&]/gi, '').slice(0, 2), color: symbolColor(symbol) };
  }
  readonly chartBadge = computed(() => this.badge(this.chartSymbol(), this.chartDef()?.yahoo));
  readonly bounds = computed(() => {
    const v = this.series().map((p) => p.c);
    if (!v.length) return { lo: 0, hi: 1 };
    const lo = Math.min(...v), hi = Math.max(...v), pad = (hi - lo) * 0.1 || hi * 0.01;
    return { lo: lo - pad, hi: hi + pad };
  });
  readonly yTicks = computed(() => {
    const { lo, hi } = this.bounds();
    return [0, 1, 2, 3].map((i) => hi - ((hi - lo) * i) / 3);
  });
  readonly path = computed(() => {
    const s = this.series();
    const line = s.map((p, i) => `${i ? 'L' : 'M'}${this.px(i).toFixed(1)},${this.py(p.c).toFixed(1)}`).join('');
    return { line, area: s.length ? `${line}L${this.W},${this.H}L0,${this.H}Z` : '' };
  });
  readonly hoverIdx = computed(() => (this.hover() >= 0 ? this.hover() : this.series().length - 1));
  readonly hoverPoint = computed(() => this.series()[this.hoverIdx()]);
  readonly xLabels = computed(() => {
    const s = this.series();
    const n = Math.min(8, s.length);
    return Array.from({ length: n }, (_, i) => s[Math.round((i * (s.length - 1)) / Math.max(1, n - 1))]);
  });
  readonly periodChange = computed(() => {
    const s = this.series();
    if (s.length < 2) return null;
    const d = this.chartDef();
    const b = s[s.length - 1].c;
    // 1D: measure from previous close (like "Today"), not the first intraday bar
    const a = this.range() === '1D' && d.live && d.last - d.change ? d.last - d.change : s[0].c;
    return { abs: b - a, pct: ((b - a) / a) * 100 };
  });

  /** Green when the selected period is up, red when down. */
  readonly trendColor = computed(() => ((this.periodChange()?.pct ?? 0) >= 0 ? '#16a34a' : '#e11d48'));

  px = (i: number) => (i / Math.max(1, this.series().length - 1)) * this.W;
  py = (v: number) => { const { lo, hi } = this.bounds(); return this.H - ((v - lo) / (hi - lo)) * this.H; };

  constructor() {
    // Only fetch in the browser (not during server-side rendering)
    const host = inject(ElementRef<HTMLElement>).nativeElement as HTMLElement;
    afterNextRender(() => {
      this.restoreView();
      this.restoreTheme();
      // Sticky table bar and column headers sit below the sticky top bar; heights vary by screen width.
      const topbar = host.querySelector<HTMLElement>('.topbar');
      if (topbar && typeof ResizeObserver !== 'undefined') {
        const tablebar = host.querySelector<HTMLElement>('.table-bar');
        const ro = new ResizeObserver(() => {
          host.style.setProperty('--topbar-h', `${topbar.offsetHeight}px`);
          if (tablebar) host.style.setProperty('--tablebar-h', `${tablebar.offsetHeight}px`);
        });
        ro.observe(topbar);
        if (tablebar) ro.observe(tablebar);
        this.destroyRef.onDestroy(() => ro.disconnect());
      }
      this.md.start([...new Set(this.everything().map((r) => r.yahoo))]);
      // Seconds until the next quote poll, shown beside the Live tag.
      const tick = setInterval(() => {
        const at = this.md.updatedAt();
        const left = at ? Math.ceil((at + POLL_MS - Date.now()) / 1000) : POLL_SECS;
        this.countdown.set(Math.min(POLL_SECS, Math.max(0, left)));
      }, 250);
      this.destroyRef.onDestroy(() => clearInterval(tick));
      this.loadHistory();
    });
    this.destroyRef.onDestroy(() => this.md.stop());
    this.watchDigits();
    // Remember the view for this browser tab so a refresh doesn't reset it.
    effect(() => {
      const view = { tab: this.tab(), group: this.groupFilter(), symbol: this.chartSymbol(), range: this.range(), list: this.listMode() };
      if (!this.restored) return;
      try { sessionStorage.setItem(VIEW_KEY, JSON.stringify(view)); } catch { /* storage unavailable */ }
    });
  }

  readonly countdown = signal(POLL_SECS);

  private restored = false;

  /** Re-apply the tab, group filter and chart saved in sessionStorage, ignoring stale values. */
  private restoreView() {
    try {
      const v = JSON.parse(sessionStorage.getItem(VIEW_KEY) ?? 'null');
      if (v && v.tab in this.defs) {
        this.tab.set(v.tab);
        if (typeof v.group === 'string' && this.defs[v.tab as Tab].some((d) => d.group === v.group)) this.groupFilter.set(v.group);
      }
      if (v && this.everything().some((r) => r.symbol === v.symbol)) this.chartSymbol.set(v.symbol);
      if (v && v.range in RANGES) this.range.set(v.range);
      if (v && (v.list === 'watch' || v.list === 'stocks')) this.listMode.set(v.list);
    } catch { /* storage unavailable or bad JSON: keep defaults */ }
    this.restored = true;
  }

  async loadHistory() {
    this.chartLoading.set(true);
    this.hover.set(-1);
    try {
      this.series.set(await this.md.history(this.chartDef().yahoo, this.rangeCfg().range, this.rangeCfg().interval));
    } catch {
      this.series.set([]);
    } finally {
      this.chartLoading.set(false);
    }
  }

  selectChart(symbol: string) { this.chartSymbol.set(symbol); this.loadHistory(); }
  setRange(r: Range) { this.range.set(r); this.loadHistory(); }
  setTab(t: Tab) { this.tab.set(t); this.query.set(''); this.groupFilter.set(null); }
  sort(k: SortKey) {
    if (this.sortKey() === k) this.sortAsc.update((v) => !v);
    else { this.sortKey.set(k); this.sortAsc.set(true); }
  }
  onSearch(e: Event) { this.query.set((e.target as HTMLInputElement).value); }
  onChartMove(e: MouseEvent) {
    const el = e.currentTarget as HTMLElement;
    const n = this.series().length - 1;
    const ratio = (e.clientX - el.getBoundingClientRect().left) / el.clientWidth;
    this.hover.set(Math.max(0, Math.min(n, Math.round(ratio * n))));
  }
  /** Price-scale label with just enough decimals to keep ticks distinct. */
  tickLabel(v: number) {
    const { lo, hi } = this.bounds();
    const step = (hi - lo) / 3;
    const d = step >= 10 ? 0 : step >= 1 ? 1 : step >= 0.1 ? 2 : 4;
    return v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  compact(n: number) {
    return n ? new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n) : '—';
  }
  abs(n: number) { return Math.abs(n); }
}
