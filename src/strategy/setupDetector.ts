import { CandleState, Candle, Interval } from "../state/candleState";
import { OrderflowState, ImbalanceBucket } from "../state/orderflowState";
import { FundingState } from "../state/fundingState";
import { FuturesSymbol } from "../types";
import { addSystemLog } from "../utils/systemLog"; // <-- ekledim

/**
 * Setup tipi (LONG veya SHORT)
 */
export type SetupDirection = "LONG" | "SHORT";

export interface SetupCheckResult {
  direction: SetupDirection;
  symbol: FuturesSymbol;
  has4hZone: boolean;
  in4hZone: boolean;
  hasSweep: boolean;
  hasImbalance: boolean;
  hasCvdDivergence: boolean;
  hasBarDeltaSign: boolean; // LONG için pozitif, SHORT için negatif
  hasOiDrop: boolean;
  hasRvol: boolean;
  passed: boolean;
  debug?: any;
}

/**
 * 4H bölge kontrolü:
 *  - LONG: Fiyat, SwingLow_4h ile SwingLow_4h * 1.008 arasında mı?
 *  - SHORT: Fiyat, SwingHigh_4h * 0.992 ile SwingHigh_4h arasında mı?
 */
function check4hZone(
  candleState: CandleState,
  symbol: FuturesSymbol,
  direction: SetupDirection,
  currentPrice: number
): {
  has4hZone: boolean;
  in4hZone: boolean;
  swingLow4h: number | null;
  swingHigh4h: number | null;
} {
  const swing = candleState.getSwingHighLow4h(symbol);
  const swingLow4h = swing.swingLow4h;
  const swingHigh4h = swing.swingHigh4h;

  if (swingLow4h === null || swingHigh4h === null) {
    return { has4hZone: false, in4hZone: false, swingLow4h, swingHigh4h };
  }

  if (direction === "LONG") {
    const lower = swingLow4h;
    const upper = swingLow4h * 1.008;
    const inZone = currentPrice >= lower && currentPrice <= upper;
    return { has4hZone: true, in4hZone: inZone, swingLow4h, swingHigh4h };
  } else {
    const upper = swingHigh4h;
    const lower = swingHigh4h * 0.992;
    const inZone = currentPrice >= lower && currentPrice <= upper;
    return { has4hZone: true, in4hZone: inZone, swingLow4h, swingHigh4h };
  }
}

/**
 * 15m sweep kontrolü:
 *  - LONG:
 *      Low < SwingLow_4h
 *      Close > SwingLow_4h
 *  - SHORT:
 *      High > SwingHigh_4h
 *      Close < SwingHigh_4h
 */
function checkSweep15m(
  candle: Candle,
  swingLow4h: number | null,
  swingHigh4h: number | null,
  direction: SetupDirection
): boolean {
  if (direction === "LONG") {
    if (swingLow4h === null) return false;
    return candle.low < swingLow4h && candle.close > swingLow4h;
  } else {
    if (swingHigh4h === null) return false;
    return candle.high > swingHigh4h && candle.close < swingHigh4h;
  }
}

/**
 * Imbalance kontrolü:
 *  - LONG: 15m süresince, (AggressiveBuy / AggressiveSell) >= 2.8 oranı
 *          en az 3 kez gerçekleşmeli.
 *  - SHORT: 15m süresince, (AggressiveSell / AggressiveBuy) >= 2.8 oranı
 *           en az 3 kez gerçekleşmeli.
 *
 * Biz 1s bucket'ları kullanıyoruz: her bucket için oran hesaplanır, şart sağlayan
 * bucket sayısı >= 3 ise "hasImbalance=true".
 */
function checkImbalance15m(
  buckets: ImbalanceBucket[],
  startMs: number,
  endMs: number,
  direction: SetupDirection
): boolean {
  const inRange = buckets.filter(
    (b) => b.timestamp >= startMs && b.timestamp <= endMs
  );
  if (inRange.length === 0) return false;

  const threshold = 2.8;
  let count = 0;

  for (const b of inRange) {
    const buy = b.aggBuy;
    const sell = b.aggSell;

    if (direction === "LONG") {
      if (sell <= 0) continue;
      const ratio = buy / sell;
      if (ratio >= threshold) count++;
    } else {
      if (buy <= 0) continue;
      const ratio = sell / buy;
      if (ratio >= threshold) count++;
    }

    if (count >= 3) {
      return true;
    }
  }

  return false;
}

/**
 * CVD Divergence (Absorption / Twitter kuralı) – basit versiyon
 */
function checkCvdDivergence(
  symbol: FuturesSymbol,
  direction: SetupDirection,
  _candleState: CandleState,
  orderflowState: OrderflowState,
  current15m: Candle,
  prev15m: Candle | null
): boolean {
  if (!prev15m) return false;

  const ofState = orderflowState.getSymbolState(symbol);
  const cvdNow = ofState.cvd;

  if (direction === "LONG") {
    const priceLL = current15m.low < prev15m.low;
    if (!priceLL) return false;
    // Çok kabaca: CVD pozitif tarafta ise pozitif uyumsuzluk varsayalım
    return cvdNow > 0;
  } else {
    const priceHH = current15m.high > prev15m.high;
    if (!priceHH) return false;
    return cvdNow < 0;
  }
}

/**
 * 15m bar delta:
 *  - LONG: NetDelta > 0
 *  - SHORT: NetDelta < 0
 */
function checkBarDeltaSign(
  buckets: ImbalanceBucket[],
  startMs: number,
  endMs: number,
  direction: SetupDirection
): boolean {
  const inRange = buckets.filter(
    (b) => b.timestamp >= startMs && b.timestamp <= endMs
  );
  if (inRange.length === 0) return false;

  let netDelta = 0;
  for (const b of inRange) {
    netDelta += (b.aggBuy || 0) - (b.aggSell || 0);
  }

  if (direction === "LONG") {
    return netDelta > 0;
  } else {
    return netDelta < 0;
  }
}

/**
 * OI Değişimi – şimdilik dummy (her zaman false)
 */
function checkOiDrop(
  fundingState: FundingState,
  symbol: FuturesSymbol,
  _current15m: Candle,
  _prev15m: Candle | null
): boolean {
  const oiInfo = fundingState.getOpenInterest(symbol);
  // safe erişim: farklı tipler olabilir
  if (!oiInfo || (oiInfo as any).openInterest === null || (oiInfo as any).openInterest === undefined) {
    return false;
  }
  return false;
}

/**
 * RVOL kontrolü:
 *  - O 15m mumun hacmi, 24 saatlik ortalamanın 2.5 katından büyük olmalı.
 */
function checkRvol(
  candleState: CandleState,
  symbol: FuturesSymbol
): { hasRvol: boolean; rvol: number | null } {
  const rvol = candleState.getRVOL15m(symbol);
  if (rvol === null) {
    return { hasRvol: false, rvol: null };
  }
  return {
    hasRvol: rvol >= 2.5,
    rvol,
  };
}

/**
 * 15m setup kontrolü.
 */
export function check15mSetup(
  direction: SetupDirection,
  symbol: FuturesSymbol,
  candleState: CandleState,
  orderflowState: OrderflowState,
  fundingState: FundingState
): SetupCheckResult | null {
  const candles15m = candleState
    .getCandles(symbol, "15m" as Interval, 200)
    .filter((c) => c.closed);
  if (candles15m.length < 2) {
    return null;
  }

  const current15m = candles15m[candles15m.length - 1];
  const prev15m = candles15m[candles15m.length - 2];

  const currentPrice = current15m.close;

  // 4h zone
  const zone = check4hZone(candleState, symbol, direction, currentPrice);

  // Sweep
  const hasSweep = checkSweep15m(
    current15m,
    zone.swingLow4h,
    zone.swingHigh4h,
    direction
  );

  // Imbalance & Bar delta (aggTrade bucket'ları)
  const ofState = orderflowState.getSymbolState(symbol);
  const startMs = current15m.openTime;
  const endMs = current15m.closeTime;

  const hasImbalance = checkImbalance15m(
    ofState.buckets,
    startMs,
    endMs,
    direction
  );
  const hasBarDeltaSign = checkBarDeltaSign(
    ofState.buckets,
    startMs,
    endMs,
    direction
  );

  // CVD divergence (basit)
  const hasCvdDivergence = checkCvdDivergence(
    symbol,
    direction,
    candleState,
    orderflowState,
    current15m,
    prev15m
  );

  // OI drop
  const hasOiDrop = checkOiDrop(fundingState, symbol, current15m, prev15m);

  // RVOL
  const rvolInfo = checkRvol(candleState, symbol);

  const passed =
    zone.has4hZone &&
    zone.in4hZone &&
    hasSweep &&
    hasImbalance &&
    hasCvdDivergence &&
    hasBarDeltaSign &&
    // hasOiDrop (şimdilik zorunlu değil) &&
    rvolInfo.hasRvol;

  // LOGGING: sweep veya passed durumlarında sistem logu at
  try {
    if (hasSweep) {
      const msg = `SWEEP_DETECTED ${symbol} ${direction} price=${currentPrice} swingLow4h=${zone.swingLow4h} swingHigh4h=${zone.swingHigh4h}`;
      console.log(msg);
      addSystemLog({
        time: new Date().toISOString(),
        level: "INFO",
        source: "STRATEGY",
        message: msg,
        context: {
          symbol,
          direction,
          price: currentPrice,
          swingLow4h: zone.swingLow4h,
          swingHigh4h: zone.swingHigh4h,
          current15m,
        },
      });
    }

    if (passed) {
      const msg = `SETUP_PASSED ${symbol} ${direction} price=${currentPrice}`;
      console.log(msg);
      addSystemLog({
        time: new Date().toISOString(),
        level: "INFO",
        source: "STRATEGY",
        message: msg,
        context: {
          symbol,
          direction,
          price: currentPrice,
          debug: {
            swingLow4h: zone.swingLow4h,
            swingHigh4h: zone.swingHigh4h,
            rvol: rvolInfo.rvol,
            hasImbalance,
            hasCvdDivergence,
            hasBarDeltaSign,
          },
        },
      });
    }
  } catch (e) {
    // logging should never break flow
    console.error("setupDetector logging error", e);
  }

  return {
    direction,
    symbol,
    has4hZone: zone.has4hZone,
    in4hZone: zone.in4hZone,
    hasSweep,
    hasImbalance,
    hasCvdDivergence,
    hasBarDeltaSign,
    hasOiDrop,
    hasRvol: rvolInfo.hasRvol,
    passed,
    debug: {
      swingLow4h: zone.swingLow4h,
      swingHigh4h: zone.swingHigh4h,
      rvol: rvolInfo.rvol,
    },
  };
}
