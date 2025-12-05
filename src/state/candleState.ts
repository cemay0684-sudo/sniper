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
  // key: "ETHUSDT_15m" gibi, value: Candle[]
  private candles: Map<string, Candle[]> = new Map();

  // Hafızada tutacağımız maksimum mum sayısı (ör: 2000)
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

  /**
   * Binance WS kline event'lerini işler.
   */
  public handleKline(event: KlineEvent) {
    const symbol = event.s.toUpperCase() as FuturesSymbol;
    const interval = event.k.i as Interval;
    if (interval !== "5m" && interval !== "15m" && interval !== "4h") {
      return;
    }

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

  /**
   * REST'ten alınmış historical klines'i state'e yükler.
   *  - klines: { openTime, closeTime, open, high, low, close, volume }
   *  - Tümü closed kabul edilir.
   */
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
      // Aynı openTime varsa overwrite et
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

    // Zaman sırasına göre sırala ve trim et
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
   * (Son 15m mumun hacmi) / (Son 96 adet 15m mumun hacim ortalaması)
   */
  public getRVOL15m(symbol: FuturesSymbol): number | null {
    const list = this.ensureSeries(symbol, "15m");
    if (list.length < 96 + 1) {
      return null; // Yeterli veri yok
    }

    const last = list[list.length - 1];
    if (!last.closed) {
      const closedCandles = list.filter((c) => c.closed);
      if (closedCandles.length < 96 + 1) return null;
      const lastClosed = closedCandles[closedCandles.length - 1];
      const prevForAvg = closedCandles.slice(
        closedCandles.length - 1 - 96,
        closedCandles.length - 1
      );
      const avgVol =
        prevForAvg.reduce((sum, c) => sum + c.volume, 0) / prevForAvg.length;
      if (avgVol === 0) return null;
      return lastClosed.volume / avgVol;
    } else {
      const prev = list.slice(list.length - 1 - 96, list.length - 1);
      const avgVol = prev.reduce((sum, c) => sum + c.volume, 0) / prev.length;
      if (avgVol === 0) return null;
      return last.volume / avgVol;
    }
  }

  /**
   * 4h SwingHigh_4h ve SwingLow_4h:
   * Son 20 adet 4h kapalı mumun en yüksek high / en düşük low
   */
  public getSwingHighLow4h(symbol: FuturesSymbol): {
    swingHigh4h: number | null;
    swingLow4h: number | null;
  } {
    const list = this.ensureSeries(symbol, "4h").filter((c) => c.closed);
    if (list.length < 20) {
      return { swingHigh4h: null, swingLow4h: null };
    }

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
