import { CandleState, Candle, Interval } from "../state/candleState";
import { OrderflowState } from "../state/orderflowState";
import { FundingState } from "../state/fundingState";
import { FuturesSymbol } from "../types";
import {
  check15mSetup,
  SetupDirection,
  SetupCheckResult,
} from "./setupDetector";
import {
  checkSessionFilter /*, checkFundingFilter, checkDominanceFilter */,
} from "./globalFilters";
import { ExecutionClient, Side } from "../execution/executionClient";

export interface TriggerSignal {
  id: string;
  symbol: FuturesSymbol;
  direction: SetupDirection;
  entryCandle5m: Candle;
  setupInfo: SetupCheckResult;
  createdAt: string;
}

/**
 * Setup bekleyen 15m mum bilgisi
 */
interface PendingSetup {
  symbol: FuturesSymbol;
  direction: SetupDirection;
  setupCandle15mOpenTime: number;
  setupInfo: SetupCheckResult;
}

/**
 * Dashboard için sembol bazlı özet durum
 */
export interface SymbolDashboardState {
  hasPendingSetup: boolean;
  lastSetupHasSweep: boolean | null;
  lastSetupHasDiv: boolean | null;
}

/**
 * TriggerEngine:
 *  - 15m mum kapanışlarında setup var mı diye bakar.
 *  - Varsa, o setup için bir "pending setup" kaydeder.
 *  - Sonraki 5m kapanışlarında:
 *      - LONG: yeşil mum (close > open) -> sinyal üret
 *      - SHORT: kırmızı mum (close < open) -> sinyal üret
 *  - Sinyali hem console.log ile gösterir hem de ExecutionClient'e emir atması için iletir.
 *
 * NOT (V1 KARARI):
 *  - Funding ve BTC Dominance filtreleri, REST tarafı stabil hale gelene kadar TRIGGER seviyesinde devre dışıdır.
 *  - GlobalFilters içindeki fonksiyonlar duruyor; ileride tekrar açmak çok kolay olacak.
 *
 * SL / TP (V1 KURAL):
 *  - LONG:
 *      entry = 5m close
 *      SL = entry * (1 - 0.01)  -> %1 aşağı
 *      TP = entry * (1 + 0.02)  -> %2 yukarı
 *  - SHORT:
 *      entry = 5m close
 *      SL = entry * (1 + 0.01)
 *      TP = entry * (1 - 0.02)
 */
export class TriggerEngine {
  private candleState: CandleState;
  private orderflowState: OrderflowState;
  private fundingState: FundingState;
  private executionClient: ExecutionClient;

  private pendingSetups: PendingSetup[] = [];

  private onSignalHandlers: Array<(signal: TriggerSignal) => void> = [];

  // Dashboard için sembol bazlı özet state
  private dashboardState: Record<FuturesSymbol, SymbolDashboardState> =
    {} as any;

  constructor(
    candleState: CandleState,
    orderflowState: OrderflowState,
    fundingState: FundingState,
    executionClient: ExecutionClient
  ) {
    this.candleState = candleState;
    this.orderflowState = orderflowState;
    this.fundingState = fundingState;
    this.executionClient = executionClient;
  }

  public onSignal(handler: (signal: TriggerSignal) => void) {
    this.onSignalHandlers.push(handler);
  }

  /**
   * Belirli bir sembol için dashboard özet state döner.
   */
  public getDashboardStateFor(symbol: FuturesSymbol): SymbolDashboardState {
    if (!this.dashboardState[symbol]) {
      this.dashboardState[symbol] = {
        hasPendingSetup: false,
        lastSetupHasSweep: null,
        lastSetupHasDiv: null,
      };
    }
    return this.dashboardState[symbol];
  }

  /**
   * 15m mum kapanışında çağrılmalı.
   * Tüm semboller için LONG ve SHORT setup'ları kontrol eder.
   */
  public handle15mClose(symbols: FuturesSymbol[]) {
    for (const symbol of symbols) {
      // LONG setup
      const longSetup = check15mSetup(
        "LONG",
        symbol,
        this.candleState,
        this.orderflowState,
        this.fundingState
      );

      if (longSetup && longSetup.passed) {
        this.addPendingSetup(symbol, "LONG", longSetup);
      }

      // SHORT setup
      const shortSetup = check15mSetup(
        "SHORT",
        symbol,
        this.candleState,
        this.orderflowState,
        this.fundingState
      );

      if (shortSetup && shortSetup.passed) {
        this.addPendingSetup(symbol, "SHORT", shortSetup);
      }
    }
  }

  /**
   * 5m mum kapanışında çağrılmalı.
   * Pending setup'lar için tetik (trigger) şartını kontrol eder ve gerekirse emir atar.
   */
  public async handle5mClose(symbols: FuturesSymbol[]) {
    // Session filtresi (global)
    const session = checkSessionFilter(new Date());
    if (!session.allowed) {
      return;
    }

    for (const symbol of symbols) {
      const candles5m = this.candleState
        .getCandles(symbol, "5m" as Interval, 10)
        .filter((c) => c.closed);
      if (candles5m.length === 0) continue;
      const last5m = candles5m[candles5m.length - 1];

      const relatedSetups = this.pendingSetups.filter(
        (ps) => ps.symbol === symbol
      );
      if (relatedSetups.length === 0) continue;

      for (const ps of relatedSetups) {
        const isGreen = last5m.close > last5m.open;
        const isRed = last5m.close < last5m.open;

        let triggered = false;
        if (ps.direction === "LONG" && isGreen) {
          triggered = true;
        } else if (ps.direction === "SHORT" && isRed) {
          triggered = true;
        }

        if (triggered) {
          const signal: TriggerSignal = {
            id: this.buildSignalId(symbol, ps.direction, last5m),
            symbol,
            direction: ps.direction,
            entryCandle5m: last5m,
            setupInfo: ps.setupInfo,
            createdAt: new Date().toISOString(),
          };

          console.log(
            `[TRIGGER] ${signal.direction} signal on ${signal.symbol} at 5m close=${signal.entryCandle5m.close}`,
            {
              setup: signal.setupInfo,
            }
          );

          // Emir motorunu çağır
          await this.executeSignal(signal);

          this.onSignalHandlers.forEach((h) => h(signal));
          this.removePending(ps);
        } else {
          // İleride: belirli sayıda 5m mum geçerse pending setup'ı iptal edebiliriz.
        }
      }
    }
  }

  /**
   * V1 SL/TP (%1 / %2) hesaplama + ExecutionClient.openPosition çağrısı.
   */
  private async executeSignal(signal: TriggerSignal) {
    const { symbol, direction, entryCandle5m } = signal;
    const entry = entryCandle5m.close;

    let sl: number;
    let tp: number;
    let side: Side;

    if (direction === "LONG") {
      side = "BUY";
      sl = entry * (1 - 0.01); // -1%
      tp = entry * (1 + 0.02); // +2%
    } else {
      side = "SELL";
      sl = entry * (1 + 0.01); // +1%
      tp = entry * (1 - 0.02); // -2%
    }

    console.log("[TriggerEngine] Executing signal with SL/TP:", {
      symbol,
      direction,
      entry,
      sl,
      tp,
    });

    const result = await this.executionClient.openPosition({
      symbol,
      side,
      quantity: 0, // Gerçek qty ExecutionClient içinde available balance'a göre hesaplanıyor
      entryPrice: entry,
      stopLossPrice: sl,
      takeProfitPrice: tp,
      leverage: 9,
      isolated: true,
    });

    if (!result.success) {
      console.error("[TriggerEngine] Order execution failed:", result.error);
    } else {
      console.log("[TriggerEngine] Order execution success:", result.details);
    }
  }

  private addPendingSetup(
    symbol: FuturesSymbol,
    direction: SetupDirection,
    setupInfo: SetupCheckResult
  ) {
    const setupCandle15mOpenTime = this.getLast15mOpenTime(symbol);
    if (setupCandle15mOpenTime === null) return;

    const existing = this.pendingSetups.find(
      (ps) =>
        ps.symbol === symbol &&
        ps.direction === direction &&
        ps.setupCandle15mOpenTime === setupCandle15mOpenTime
    );
    if (existing) {
      return;
    }

    const ps: PendingSetup = {
      symbol,
      direction,
      setupCandle15mOpenTime,
      setupInfo,
    };
    this.pendingSetups.push(ps);

    // Dashboard state: bu sembolde artık pending setup var
    const dash = this.getDashboardStateFor(symbol);
    dash.hasPendingSetup = true;
    dash.lastSetupHasSweep = setupInfo.hasSweep;
    dash.lastSetupHasDiv = setupInfo.hasCvdDivergence;

    console.log(
      `[SETUP] ${direction} setup detected on ${symbol} (15m openTime=${setupCandle15mOpenTime})`,
      setupInfo
    );
  }

  private removePending(ps: PendingSetup) {
    this.pendingSetups = this.pendingSetups.filter(
      (p) =>
        !(
          p.symbol === ps.symbol &&
          p.direction === ps.direction &&
          p.setupCandle15mOpenTime === ps.setupCandle15mOpenTime
        )
    );

    // Eğer bu sembol için hiç pending setup kalmadıysa dashboard state'i temizle
    const stillHas = this.pendingSetups.some((p) => p.symbol === ps.symbol);
    if (!stillHas) {
      const dash = this.getDashboardStateFor(ps.symbol);
      dash.hasPendingSetup = false;
      // lastSetupHasSweep / lastSetupHasDiv son setup bilgisini taşımaya devam ediyor
    }
  }

  private getLast15mOpenTime(symbol: FuturesSymbol): number | null {
    const candles15m = this.candleState
      .getCandles(symbol, "15m" as Interval, 10)
      .filter((c) => c.closed);
    if (candles15m.length === 0) return null;
    return candles15m[candles15m.length - 1].openTime;
  }

  private buildSignalId(
    symbol: FuturesSymbol,
    direction: SetupDirection,
    candle: Candle
  ): string {
    return `${symbol}_${direction}_${candle.openTime}`;
  }
}
