import { KlineEvent } from "../types";
import { FuturesSymbol } from "../types";

export type Interval = "5m" | "15m" | "4h";

export interface Candle {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closed: boolean;
}

function keyOf(symbol: FuturesSymbol, interval: Interval): string {
  return `${symbol}_${interval}`;
}

export class CandleState {
  private candles: Map<string, Candle[]> = new Map();
  private readonly maxCandlesPerSeries: number;

  constructor(maxCandlesPerSeries = 2000) {
    this.maxCandlesPerSeries = maxCandlesPerSeries;
  }

  private ensureSeries(symbol: FuturesSymbol, interval: Interval): Candle[] {
    const k = keyOf(symbol, interval);
    let list = this.candles.get(k);
    if (!list) {
      list = [];
      this.candles.set(k, list);
    }
    return list;
  }

  public handleKline(event: KlineEvent) {
    const symbol = event.s.toUpperCase() as FuturesSymbol;
    const interval = event.k.i as Interval;
    if (interval !== "5m" && interval !== "15m" && interval !== "4h") return;

    const list = this.ensureSeries(symbol, interval);

    const openTime = event.k.t;
    const closeTime = event.k.T;
    const open = Number(event.k.o);
    const high = Number(event.k.h);
    const low = Number(event.k.l);
    const close = Number(event.k.c);
    const volume = Number(event.k.v);
    const closed = event.k.x;

    const last = list[list.length - 1];
    if (last && last.openTime === openTime) {
      last.closeTime = closeTime;
      last.open = open;
      last.high = high;
      last.low = low;
      last.close = close;
      last.volume = volume;
      last.closed = closed;
    } else {
      const candle: Candle = {
        openTime,
        closeTime,
        open,
        high,
        low,
        close,
        volume,
        closed
      };
      list.push(candle);
      if (list.length > this.maxCandlesPerSeries) {
        list.splice(0, list.length - this.maxCandlesPerSeries);
      }
    }
  }

  public ingestHistoricalCandles(
    symbol: FuturesSymbol,
    interval: Interval,
    klines: Array<{
      openTime: number;
      closeTime: number;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
    }>
  ) {
    const list = this.ensureSeries(symbol, interval);

    for (const k of klines) {
      const existingIndex = list.findIndex((c) => c.openTime === k.openTime);
      const candle: Candle = {
        openTime: k.openTime,
        closeTime: k.closeTime,
        open: k.open,
        high: k.high,
        low: k.low,
        close: k.close,
        volume: k.volume,
        closed: true
      };

      if (existingIndex >= 0) {
        list[existingIndex] = candle;
      } else {
        list.push(candle);
      }
    }

    list.sort((a, b) => a.openTime - b.openTime);
    if (list.length > this.maxCandlesPerSeries) {
      list.splice(0, list.length - this.maxCandlesPerSeries);
    }
  }

  public getCandles(
    symbol: FuturesSymbol,
    interval: Interval,
    limit?: number
  ): Candle[] {
    const list = this.ensureSeries(symbol, interval);
    if (!limit || list.length <= limit) return [...list];
    return list.slice(list.length - limit);
  }

  /**
   * RVOL:
   * Son kapalı 15m mum hacmi / son 96 kapalı 15m mumun hacim ortalaması.
   * Yeterli kapalı mum (<97) yoksa null döner.
   */
  public getRVOL15m(symbol: FuturesSymbol): number | null {
    const closed = this.ensureSeries(symbol, "15m").filter((c) => c.closed);
    if (closed.length < 97) return null; // 1 hedef + 96 geçmiş
    const lastClosed = closed[closed.length - 1];
    const prev = closed.slice(closed.length - 1 - 96, closed.length - 1);
    const avgVol = prev.reduce((sum, c) => sum + c.volume, 0) / prev.length;
    if (avgVol === 0) return null;
    return lastClosed.volume / avgVol;
  }

  public getSwingHighLow4h(symbol: FuturesSymbol): {
    swingHigh4h: number | null;
    swingLow4h: number | null;
  } {
    const list = this.ensureSeries(symbol, "4h").filter((c) => c.closed);
    if (list.length < 20) return { swingHigh4h: null, swingLow4h: null };

    const last20 = list.slice(list.length - 20);
    let maxHigh = -Infinity;
    let minLow = Infinity;
    for (const c of last20) {
      if (c.high > maxHigh) maxHigh = c.high;
      if (c.low < minLow) minLow = c.low;
    }
    return {
      swingHigh4h: isFinite(maxHigh) ? maxHigh : null,
      swingLow4h: isFinite(minLow) ? minLow : null
    };
  }
}
