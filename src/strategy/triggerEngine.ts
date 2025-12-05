import { CandleState } from "../state/candleState";
import { OrderflowState } from "../state/orderflowState";
import { FundingState } from "../state/fundingState";
import { FuturesSymbol } from "../types";
import {
  checkSessionFilter,
  // checkFundingFilter,
  // checkDominanceFilter,
} from "./globalFilters";
import { ExecutionClient, Side } from "../execution/executionClient";
import { addSystemLog } from "../utils/systemLog";

export interface TriggerSignal {
  symbol: FuturesSymbol;
  direction: Side;
  entryCandle5m: {
    openTime: number;
    closeTime: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  };
}

interface PendingSetup {
  symbol: FuturesSymbol;
  direction: Side;
  createdAt: number;
  entryWindowMs: number;
}

export class TriggerEngine {
  private readonly candleState: CandleState;
  private readonly orderflowState: OrderflowState;
  private readonly fundingState: FundingState;
  private readonly executionClient: ExecutionClient;

  private readonly pendingSetups: Map<string, PendingSetup> = new Map();
  private signalCallbacks: ((signal: TriggerSignal) => void)[] = [];

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

  public onSignal(cb: (signal: TriggerSignal) => void) {
    this.signalCallbacks.push(cb);
  }

  private emitSignal(signal: TriggerSignal) {
    for (const cb of this.signalCallbacks) {
      try {
        cb(signal);
      } catch (err) {
        console.error("[TriggerEngine] onSignal callback error:", err);
      }
    }
  }

  private keyFor(symbol: FuturesSymbol, direction: Side) {
    return `${symbol}:${direction}`;
  }

  private addPending(setup: PendingSetup) {
    const key = this.keyFor(setup.symbol, setup.direction);
    this.pendingSetups.set(key, setup);
  }

  private removePendingByKey(key: string) {
    this.pendingSetups.delete(key);
  }

  private removePending(ps: PendingSetup) {
    const key = this.keyFor(ps.symbol, ps.direction);
    this.pendingSetups.delete(key);
  }

  private getPendingFor(symbol: FuturesSymbol, direction: Side) {
    const key = this.keyFor(symbol, direction);
    return this.pendingSetups.get(key);
  }

  /**
   * 15m kapanışında setup oluşumunu takip eder.
   * Buradaki asıl strateji kurallarını eski dosyandan tekrar taşıyabilirsin.
   * Şimdilik sadece placeholder var ki derleme hatası olmasın.
   */
  public handle15mClose(symbols: FuturesSymbol[]) {
    console.log("[TriggerEngine] handle15mClose - symbols:", symbols);
  }

  /**
   * 5m kapanışında pending setup'ları TRIGGER eder (emir açmayı dener).
   */
  public async handle5mClose(symbols: FuturesSymbol[]) {
    const now = Date.now();

    for (const symbol of symbols) {
      const pendings = [this.getPendingFor(symbol, "BUY"), this.getPendingFor(symbol, "SELL")].filter(
        Boolean
      ) as PendingSetup[];

      if (!pendings.length) continue;

      const candles5m = this.candleState.getCandles(symbol, "5m", 2).filter((c) => c.closed);
      if (candles5m.length === 0) continue;

      const last5m = candles5m[candles5m.length - 1];

      for (const ps of pendings) {
        if (now - ps.createdAt > ps.entryWindowMs) {
          console.log("[TriggerEngine] Pending setup expired", ps);
          this.removePending(ps);
          continue;
        }

        // Session filtresi: fonksiyon Date bekliyorsa 5m closeTime'dan Date üretelim
        const sessionTime = new Date(last5m.closeTime);
        const sessionFilter = checkSessionFilter(sessionTime);
        if (!sessionFilter.allowed) {
          console.log("[TriggerEngine] Session filter blocked trigger", {
            symbol,
            direction: ps.direction,
            reason: sessionFilter.reason,
          });
          this.removePending(ps);
          continue;
        }

        // Funding ve BTC.D filtreleri şimdilik devre dışı:
        // const fundingData = this.fundingState.getFunding(symbol);
        // const fundingFilter = checkFundingFilter(ps.direction, fundingData.fundingRate);
        // if (!fundingFilter.allowed) { this.removePending(ps); continue; }

        // const domData = this.fundingState.getBtcDominance();
        // const domFilter = checkDominanceFilter(domData);
        // if (!domFilter.allowed) { this.removePending(ps); continue; }

        const direction: Side = ps.direction;
        const price = last5m.close;

        const entryCandle5m = {
          openTime: last5m.openTime,
          closeTime: last5m.closeTime,
          open: last5m.open,
          high: last5m.high,
          low: last5m.low,
          close: last5m.close,
          volume: last5m.volume,
        };

        // Basit SL/TP (eski strateji mantığına göre sonra güncelleyebilirsin)
        const stopLossPrice =
          direction === "BUY" ? last5m.low * 0.995 : last5m.high * 1.005;
        const takeProfitPrice =
          direction === "BUY" ? last5m.close * 1.02 : last5m.close * 0.98;

        const availableUSDT = await this.executionClient.getAvailableUSDT();
        const riskPct = 0.01; // Şimdilik sabit %1 risk
        const riskAmount = availableUSDT * riskPct;
        let quantity = 0;

        if (direction === "BUY") {
          const denom = price - stopLossPrice || price;
          quantity = denom !== 0 ? riskAmount / denom : 0;
        } else {
          const denom = stopLossPrice - price || price;
          quantity = denom !== 0 ? riskAmount / denom : 0;
        }

        const qtyRounded = this.executionClient.roundQuantity(symbol, quantity);
        if (!Number.isFinite(qtyRounded) || qtyRounded <= 0) {
          console.log("[TriggerEngine] Quantity invalid, skipping execution", {
            symbol,
            direction,
            quantity,
            qtyRounded,
          });
          this.removePending(ps);
          continue;
        }

        console.log("[TRIGGER] EXECUTION START", {
          symbol,
          direction,
          qtyRounded,
          entryPrice: price,
          stopLossPrice,
          takeProfitPrice,
          availableUSDT,
        });

        try {
          const result = await this.executionClient.openPosition({
            symbol,
            side: direction,
            quantity: qtyRounded,
            entryPrice: price,
            stopLossPrice,
            takeProfitPrice,
            leverage: 3, // Şimdilik sabit 3x
            isolated: true,
          });

          console.log("[TRIGGER] EXECUTION RESULT", {
            symbol,
            direction,
            success: result?.success,
            error: result?.error,
            hasDetails: !!result?.details,
          });

          addSystemLog({
            time: new Date().toISOString(),
            level: result?.success ? "INFO" : "ERROR",
            source: "EXECUTION",
            message: result?.success
              ? `Position opened on ${symbol} ${direction}`
              : `Failed to open position on ${symbol} ${direction}`,
            context: {
              symbol,
              direction,
              success: result?.success,
              error: result?.error,
            },
          });

          if (result?.success) {
            const signal: TriggerSignal = {
              symbol,
              direction,
              entryCandle5m,
            };
            this.emitSignal(signal);
          }

          this.removePending(ps);
        } catch (err: any) {
          console.error("[TRIGGER] EXECUTION THROWN ERROR", {
            symbol,
            direction,
            error: err?.response?.data || String(err),
          });

          addSystemLog({
            time: new Date().toISOString(),
            level: "ERROR",
            source: "EXECUTION",
            message: `Execution threw error on ${symbol} ${direction}`,
            context: err?.response?.data || String(err),
          });

          this.removePending(ps);
        }
      }
    }
  }
}
