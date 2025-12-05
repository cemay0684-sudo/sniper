export type FuturesSymbol =
  | "ETHUSDT"
  | "1000PEPEUSDT"
  | "WIFUSDT"
  | "1000BONKUSDT"
  | "POPCATUSDT"
  | "BRETTUSDT"
  | "SUIUSDT"
  | "SOLUSDT";

export interface AggTradeEvent {
  e: "aggTrade";
  E: number;    // Event time
  s: string;    // Symbol
  a: number;    // Aggregate trade ID
  p: string;    // Price
  q: string;    // Quantity
  f: number;    // First trade ID
  l: number;    // Last trade ID
  T: number;    // Trade time
  m: boolean;   // Is the buyer the market maker?
  M: boolean;   // Ignore
}

export interface KlineEvent {
  e: "kline";
  E: number;
  s: string;
  k: {
    t: number;  // Kline start time
    T: number;  // Kline close time
    s: string;  // Symbol
    i: string;  // Interval
    f: number;  // First trade ID
    L: number;  // Last trade ID
    o: string;  // Open price
    c: string;  // Close price
    h: string;  // High price
    l: string;  // Low price
    v: string;  // Base asset volume
    n: number;  // Number of trades
    x: boolean; // Is this kline closed?
    q: string;  // Quote asset volume
    V: string;  // Taker buy base asset volume
    Q: string;  // Taker buy quote asset volume
    B: string;  // Ignore
  };
}

export interface MarkPriceEvent {
  e: "markPriceUpdate";
  E: number;
  s: string;    // Symbol
  p: string;    // Mark price
  P: string;    // Index price
  r: string;    // Funding rate
  T: number;    // Next funding time
}

export interface OpenInterestInfo {
  symbol: string;
  openInterest: number;
  time: number;
}

export interface FundingRateInfo {
  symbol: string;
  fundingRate: number;
  fundingTime: number;
}

// Basit health durumu
export interface DataFeedHealth {
  wsConnected: boolean;
  lastAggTradeTs?: number;
  lastKlineTs?: number;
  lastMarkPriceTs?: number;
}
