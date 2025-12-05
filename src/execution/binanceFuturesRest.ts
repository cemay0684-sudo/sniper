import axios, { AxiosInstance } from "axios";
import crypto from "crypto";
import { CONFIG } from "../config";
import { FuturesSymbol } from "../types";
import { Side } from "./executionClient";

interface BinanceOrderParams {
  symbol: string;
  side: "BUY" | "SELL";
  type: string;
  quantity?: string;
  price?: string;
  timeInForce?: string;
  stopPrice?: string;
  reduceOnly?: "true" | "false";
  closePosition?: "true" | "false";
}

export interface BinancePositionRisk {
  symbol: string;
  positionAmt: string;
  entryPrice: string;
  unRealizedProfit: string;
  positionSide: string;
}

export interface BinanceBalance {
  asset: string;
  balance: string;
  availableBalance: string;
}

export interface BinanceFuturesOrder {
  symbol: string;
  orderId: number;
  clientOrderId: string;
  status: string;
  type: string;
  side: "BUY" | "SELL";
  origQty: string;
  executedQty: string;
  reduceOnly: boolean;
  closePosition: boolean;
  stopPrice: string;
}

export class BinanceFuturesRest {
  private client: AxiosInstance;
  private apiKey: string;
  private apiSecret: string;

  constructor() {
    const baseURL = CONFIG.binance.testnetRestBase || "https://testnet.binancefuture.com";

    this.apiKey = CONFIG.binance.apiKey;
    this.apiSecret = CONFIG.binance.apiSecret;

    this.client = axios.create({
      baseURL,
      timeout: 10_000
    });
  }

  private sign(params: Record<string, any>): string {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      query.append(key, String(value));
    }
    const qs = query.toString();
    const signature = crypto
      .createHmac("sha256", this.apiSecret)
      .update(qs)
      .digest("hex");
    return qs + "&signature=" + signature;
  }

  private async signedGet<T>(path: string, params: Record<string, any> = {}): Promise<T> {
    const timestamp = Date.now();
    const fullParams = { ...params, timestamp };
    const qs = this.sign(fullParams);

    const res = await this.client.get<T>(`${path}?${qs}`, {
      headers: {
        "X-MBX-APIKEY": this.apiKey
      }
    });
    return res.data;
  }

  private async signedPost<T>(path: string, params: Record<string, any> = {}): Promise<T> {
    const timestamp = Date.now();
    const fullParams = { ...params, timestamp };
    const qs = this.sign(fullParams);

    const res = await this.client.post<T>(`${path}?${qs}`, null, {
      headers: {
        "X-MBX-APIKEY": this.apiKey
      }
    });
    return res.data;
  }

  private async signedDelete<T>(path: string, params: Record<string, any> = {}): Promise<T> {
    const timestamp = Date.now();
    const fullParams = { ...params, timestamp };
    const qs = this.sign(fullParams);

    const res = await this.client.delete<T>(`${path}?${qs}`, {
      headers: {
        "X-MBX-APIKEY": this.apiKey
      }
    });
    return res.data;
  }

  public async getAvailableUSDT(): Promise<number> {
    try {
      const data = await this.signedGet<BinanceBalance[]>("/fapi/v2/balance");
      const usdt = data.find((b) => b.asset === "USDT");
      if (!usdt) return 0;
      return Number(usdt.availableBalance);
    } catch (err) {
      console.error("[BinanceFuturesRest] getAvailableUSDT error:", err);
      return 0;
    }
  }

  public async getOpenPositions(): Promise<BinancePositionRisk[]> {
    try {
      const data = await this.signedGet<BinancePositionRisk[]>("/fapi/v2/positionRisk");
      return data.filter((p) => Number(p.positionAmt) !== 0);
    } catch (err) {
      console.error("[BinanceFuturesRest] getOpenPositions error:", err);
      return [];
    }
  }

  public async getOpenOrders(symbol: FuturesSymbol): Promise<BinanceFuturesOrder[]> {
    try {
      const data = await this.signedGet<BinanceFuturesOrder[]>("/fapi/v1/openOrders", {
        symbol
      });
      return data;
    } catch (err) {
      console.error("[BinanceFuturesRest] getOpenOrders error:", err);
      return [];
    }
  }

  public async cancelAllOpenOrders(symbol: FuturesSymbol): Promise<void> {
    try {
      const data = await this.signedDelete<any>("/fapi/v1/allOpenOrders", {
        symbol
      });
      console.log("[BinanceFuturesRest] cancelAllOpenOrders response:", data);
    } catch (err: any) {
      console.error(
        "[BinanceFuturesRest] cancelAllOpenOrders error:",
        err?.response?.data || err
      );
    }
  }

  public async setIsolatedMargin(symbol: FuturesSymbol): Promise<void> {
    try {
      await this.signedPost("/fapi/v1/marginType", {
        symbol,
        marginType: "ISOLATED"
      });
      console.log(`[BinanceFuturesRest] Margin type set to ISOLATED for ${symbol}`);
    } catch (err: any) {
      const msg = err?.response?.data?.msg || "";
      if (msg.includes("No need to change margin type")) {
        console.log(`[BinanceFuturesRest] Margin type already ISOLATED for ${symbol}`);
        return;
      }
      console.error("[BinanceFuturesRest] setIsolatedMargin error:", err?.response?.data || err);
    }
  }

  public async setLeverage(symbol: FuturesSymbol, leverage: number): Promise<void> {
    try {
      await this.signedPost("/fapi/v1/leverage", {
        symbol,
        leverage
      });
      console.log(`[BinanceFuturesRest] Leverage set to ${leverage}x for ${symbol}`);
    } catch (err) {
      console.error("[BinanceFuturesRest] setLeverage error:", err);
    }
  }

  public async placeOrder(params: BinanceOrderParams): Promise<any> {
    try {
      const payload: Record<string, any> = {
        symbol: params.symbol,
        side: params.side,
        type: params.type,
        quantity: params.quantity,
        price: params.price,
        timeInForce: params.timeInForce,
        stopPrice: params.stopPrice,
        reduceOnly: params.reduceOnly,
        closePosition: params.closePosition
      };

      const data = await this.signedPost("/fapi/v1/order", payload);
      console.log("[BinanceFuturesRest] placeOrder response:", data);
      return data;
    } catch (err: any) {
      console.error("[BinanceFuturesRest] placeOrder error:", err?.response?.data || err);
      throw err;
    }
  }

  public async openMarketPosition(
    symbol: FuturesSymbol,
    side: Side,
    quantity: number
  ): Promise<any> {
    const qtyStr = quantity.toFixed(3); // TODO: stepSize
    return this.placeOrder({
      symbol,
      side,
      type: "MARKET",
      quantity: qtyStr
    });
  }

  public async placeStopLoss(
    symbol: FuturesSymbol,
    side: Side,
    stopPrice: number
  ): Promise<any> {
    const opSide: Side = side === "BUY" ? "SELL" : "BUY";
    const stopStr = stopPrice.toFixed(2); // 2 decimal

    return this.placeOrder({
      symbol,
      side: opSide,
      type: "STOP_MARKET",
      stopPrice: stopStr,
      closePosition: "true"
    });
  }

  public async placeTakeProfit(
    symbol: FuturesSymbol,
    side: Side,
    tpPrice: number
  ): Promise<any> {
    const opSide: Side = side === "BUY" ? "SELL" : "BUY";
    const tpStr = tpPrice.toFixed(2); // 2 decimal

    return this.placeOrder({
      symbol,
      side: opSide,
      type: "TAKE_PROFIT_MARKET",
      stopPrice: tpStr,
      closePosition: "true"
    });
  }

  /**
   * Pozisyonu reduceOnly MARKET ile kapat:
   *  - quantity: kapatılacak miktar (string)
   */
  public async closePositionMarket(
    symbol: FuturesSymbol,
    side: Side,
    quantity: number
  ): Promise<any> {
    const qtyStr = quantity.toFixed(3); // TODO: stepSize
    return this.placeOrder({
      symbol,
      side,
      type: "MARKET",
      quantity: qtyStr,
      reduceOnly: "true"
    });
  }
}
