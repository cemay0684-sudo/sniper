import { CandleState, Candle, Interval } from "../state/candleState";
import { OrderflowState } from "../state/orderflowState";
import { FundingState } from "../state/fundingState";
import { FuturesSymbol } from "../types";
import {
  check15mSetup,
  SetupDirection,
  SetupCheckResult,
} from "./setupDetector";
import { ExecutionClient, Side } from "../execution/executionClient";
import { addSystemLog } from "../utils/systemLog";

export interface TriggerSignal {
  id: string;
  symbol: FuturesSymbol;
  direction: SetupDirection;
  entryCandle5m: Candle;
  setupInfo: SetupCheckResult;
  createdAt: string;
}

interface PendingSetup {
  symbol: FuturesSymbol;
  direction: SetupDirection;
  setupCandle15mOpenTime: number;
  setupInfo: SetupCheckResult;
}

export interface SymbolDashboardState {
  hasPendingSetup: boolean;
  lastSetupHasSweep: boolean | null;
  lastSetupHasDiv: boolean | null;
  statusString?: string;
}

export class TriggerEngine {
  private candleState: CandleState;
  private orderflowState: OrderflowState;
  private fundingState: FundingState;
  private executionClient: ExecutionClient;

  private pendingSetups: PendingSetup[] = [];

  private onSignalHandlers: Array<(signal: TriggerSignal) => void> = [];

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

  public getDashboardStateFor(symbol: FuturesSymbol): SymbolDashboardState {
    if (!this.dashboardState[symbol]) {
      this.dashboardState[symbol] = {
        hasPendingSetup: false,
        lastSetupHasSweep: null,
        lastSetupHasDiv: null,
        statusString: "IDLE",
      };
    }
    return this.dashboardState[symbol];
  }

  /**
   * 15m kapanışında: her sembol için LONG/SHORT setup'ı kontrol et, passed true ise pending'e ekle.
   */
  public handle15mClose(symbols: FuturesSymbol[]) {
    for (const symbol of symbols) {
      const longSetup = check15mSetup(
        "LONG",
        symbol,
        this.candleState,
        this.orderflowState,
        this.fundingState
      );
      if (longSetup?.passed) {
        this.addPendingSetup(symbol, "LONG", longSetup);
      }

      const shortSetup = check15mSetup(
        "SHORT",
        symbol,
        this.candleState,
        this.orderflowState,
        this.fundingState
      );
      if (shortSetup?.passed) {
        this.addPendingSetup(symbol, "SHORT", shortSetup);
      }
    }
  }

  /**
   * 5m kapanışında: pending varsa tetikle.
   */
  public async handle5mClose(symbols: FuturesSymbol[]) {
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
        const triggered = true;

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
            { setup: signal.setupInfo }
          );

          const dashBefore = this.getDashboardStateFor(symbol);
          dashBefore.statusString = "TRIGGER";
          addSystemLog({
            time: new Date().toISOString(),
            level: "INFO",
            source: "STRATEGY",
            message: `TRIGGER ${signal.direction} ${signal.symbol} @ ${signal.entryCandle5m.close}`,
            context: { symbol: signal.symbol, direction: signal.direction },
          });

          const result = await this.executeSignal(signal);

          const dashAfter = this.getDashboardStateFor(symbol);
          if (result && result.success) {
            dashAfter.statusString = "IN_TRADE";
            dashAfter.hasPendingSetup = false;
            addSystemLog({
              time: new Date().toISOString(),
              level: "INFO",
              source: "STRATEGY",
              message: `IN_TRADE ${signal.direction} ${signal.symbol}`,
              context: { symbol: signal.symbol, details: result },
            });
          } else {
            dashAfter.statusString = "IDLE";
            dashAfter.hasPendingSetup = false;
            addSystemLog({
              time: new Date().toISOString(),
              level: "WARN",
              source: "STRATEGY",
              message: `EXEC_FAIL ${signal.direction} ${signal.symbol}`,
              context: { symbol: signal.symbol, details: result },
            });
          }

          this.onSignalHandlers.forEach((h) => h(signal));
          this.removePending(ps);
        }
      }
    }
  }

  /**
   * V1 SL/TP (%1 / %2) hesaplama + ExecutionClient.openPosition çağrısı.
   */
  private async executeSignal(signal: TriggerSignal): Promise<any> {
    const { symbol, direction, entryCandle5m } = signal;
    const entry = entryCandle5m.close;

    let sl: number;
    let tp: number;
    let side: Side;

    if (direction === "LONG") {
      side = "BUY";
      sl = entry * (1 - 0.01);
      tp = entry * (1 + 0.02);
    } else {
      side = "SELL";
      sl = entry * (1 + 0.01);
      tp = entry * (1 - 0.02);
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
      quantity: 0, // qty sinyalden gelmiyor; minNotional/step’e göre ExecutionClient yukarı yuvarlar
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

    return result;
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
    if (existing) return;

    const ps: PendingSetup = {
      symbol,
      direction,
      setupCandle15mOpenTime,
      setupInfo,
    };
    this.pendingSetups.push(ps);

    const dash = this.getDashboardStateFor(symbol);
    dash.hasPendingSetup = true;
    dash.lastSetupHasSweep = setupInfo.hasSweep;
    dash.lastSetupHasDiv = setupInfo.hasCvdDivergence;
    dash.statusString = "PUSU";

    addSystemLog({
      time: new Date().toISOString(),
      level: "INFO",
      source: "STRATEGY",
      message: `SETUP_PASSED ${direction} ${symbol} (15m openTime=${setupCandle15mOpenTime})`,
      context: { symbol, direction, setupInfo },
    });

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

    const stillHas = this.pendingSetups.some((p) => p.symbol === ps.symbol);
    if (!stillHas) {
      const dash = this.getDashboardStateFor(ps.symbol);
      dash.hasPendingSetup = false;
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
