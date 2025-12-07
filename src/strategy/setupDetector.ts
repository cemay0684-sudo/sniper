import { CandleState, Candle, Interval } from "../state/candleState";
import { OrderflowState } from "../state/orderflowState";
import { FundingState } from "../state/fundingState";
import { FuturesSymbol } from "../types";
import { addSystemLog } from "../utils/systemLog";

/** Setup tipi (LONG veya SHORT) */
export type SetupDirection = "LONG" | "SHORT";

export interface SetupCheckResult {
  direction: SetupDirection;
  symbol: FuturesSymbol;
  has4hZone: boolean;
  in4hZone: boolean;
  hasSweep: boolean;
  hasImbalance: boolean;
  hasCvdDivergence: boolean;
  hasBarDeltaSign: boolean;
  hasOiDrop: boolean;
  hasRvol: boolean;
  passed: boolean;
  debug?: any;
}

/** 4H zone kontrolü */
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

/** 15m sweep kontrolü (rapor için, zorunlu değil) */
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

/** 15m setup kontrolü — passed: 4H swing bulunursa true, sweep zorunlu değil */
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
  const currentPrice = current15m.close;

  // 4h zone (zorunlu)
  const zone = check4hZone(candleState, symbol, direction, currentPrice);
  if (!zone.has4hZone) {
    return null; // swing yoksa setup üretme
  }

  // Sweep (sadece rapor, zorunlu değil)
  const hasSweep = checkSweep15m(
    current15m,
    zone.swingLow4h,
    zone.swingHigh4h,
    direction
  );

  // Şimdilik diğer filtreler yok; passed = 4h swing bulundu
  const passed = true;

  // Log
  try {
    if (hasSweep) {
      const msg = `SWEEP_DETECTED ${symbol} ${direction} price=${currentPrice} swingLow4h=${zone.swingLow4h} swingHigh4h=${zone.swingHigh4h}`;
      console.log(msg);
      addSystemLog({
        time: new Date().toISOString(),
        level: "INFO",
        source: "STRATEGY",
        message: msg,
        context: { symbol, direction, price: currentPrice, current15m },
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
            hasSweep,
          },
        },
      });
    }
  } catch (e) {
    console.error("setupDetector logging error", e);
  }

  return {
    direction,
    symbol,
    has4hZone: zone.has4hZone,
    in4hZone: zone.in4hZone,
    hasSweep,
    hasImbalance: false,
    hasCvdDivergence: false,
    hasBarDeltaSign: false,
    hasOiDrop: false,
    hasRvol: false,
    passed,
    debug: {
      swingLow4h: zone.swingLow4h,
      swingHigh4h: zone.swingHigh4h,
    },
  };
}
