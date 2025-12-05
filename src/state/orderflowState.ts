import { FuturesSymbol } from "../types";

export interface ImbalanceBucket {
  timestamp: number;   // ms
  aggBuy: number;      // aggressive buy volume
  aggSell: number;     // aggressive sell volume
}

interface SymbolOrderflowState {
  cvd: number;
  buckets: ImbalanceBucket[];
  lastImbalanceScore: number | null;
}

export class OrderflowState {
  private states: Record<string, SymbolOrderflowState> = {};

  private ensureSymbol(symbol: FuturesSymbol): SymbolOrderflowState {
    if (!this.states[symbol]) {
      this.states[symbol] = {
        cvd: 0,
        buckets: [],
        lastImbalanceScore: null,
      };
    }
    return this.states[symbol];
  }

  public handleAggTrade(trade: {
    s: string;      // symbol
    T: number;      // trade time ms
    m: boolean;     // isBuyerMaker
    q: string;      // quantity
  }) {
    const symbol = trade.s.toUpperCase() as FuturesSymbol;
    const state = this.ensureSymbol(symbol);

    const qty = Number(trade.q) || 0;
    // Buyer maker ise trade sell tarafında agresif, değilse buy tarafında agresif.
    const isAggBuy = !trade.m;

    if (isAggBuy) {
      state.cvd += qty;
      this.pushBucket(symbol, trade.T, qty, 0);
    } else {
      state.cvd -= qty;
      this.pushBucket(symbol, trade.T, 0, qty);
    }
  }

  private pushBucket(
    symbol: FuturesSymbol,
    timestamp: number,
    aggBuy: number,
    aggSell: number
  ) {
    const state = this.ensureSymbol(symbol);
    state.buckets.push({ timestamp, aggBuy, aggSell });

    // Maksimum bucket sayısını sınırlayalım (performans için)
    const MAX_BUCKETS = 2000;
    if (state.buckets.length > MAX_BUCKETS) {
      state.buckets.splice(0, state.buckets.length - MAX_BUCKETS);
    }
  }

  public getSymbolState(symbol: FuturesSymbol): SymbolOrderflowState {
    return this.ensureSymbol(symbol);
  }

  public setLastImbalanceScore(symbol: FuturesSymbol, score: number | null) {
    const state = this.ensureSymbol(symbol);
    state.lastImbalanceScore = score;
  }

  /**
   * Son windowMs süredeki AggBuy/AggSell oranını hesaplar.
   * Dashboard'da IMB kolonu için kullanıyoruz.
   */
  public getImbalanceScore(symbol: FuturesSymbol, windowMs: number): number | null {
    const state = this.states[symbol];
    if (!state || !state.buckets) return null;

    const now = Date.now();
    const fromTime = now - windowMs;

    let totalBuy = 0;
    let totalSell = 0;

    for (const b of state.buckets) {
      if (!b || typeof b.timestamp !== "number") continue;
      if (b.timestamp < fromTime) continue;
      totalBuy += b.aggBuy || 0;
      totalSell += b.aggSell || 0;
    }

    if (totalBuy === 0 && totalSell === 0) return null;
    if (totalBuy === 0 || totalSell === 0) {
      // Tek taraflı akışta makul bir üst limit
      return 10;
    }

    const ratio = totalBuy / totalSell;
    return ratio;
  }
}
