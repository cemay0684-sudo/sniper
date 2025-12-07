import "dotenv/config";
import crypto from "crypto";
import axios from "axios";
import { CONFIG } from "../config";
import { FuturesSymbol } from "../types";

export type Side = "BUY" | "SELL";

interface OpenPositionParams {
  symbol: FuturesSymbol;
  side: Side;
  quantity: number;
  entryPrice: number;
  stopLossPrice: number;
  takeProfitPrice: number;
  leverage: number;
  isolated: boolean;
}

type SymbolFilters = {
  tickSize: number;
  stepSize: number;
  minQty: number;
  minNotional: number;
};

export class ExecutionClient {
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly baseUrl: string = "https://testnet.binancefuture.com";

  private symbolFilters: Record<string, SymbolFilters> = {};
  private exchangeInfoLoaded = false;

  constructor() {
    this.apiKey = CONFIG.binance.apiKey;
    this.apiSecret = CONFIG.binance.apiSecret;

    if (!this.apiKey || !this.apiSecret) {
      console.warn(
        "[ExecutionClient] Binance API key/secret boş; trade fonksiyonları çalışmayacak."
      );
    }
  }

  private sign(query: string): string {
    return crypto.createHmac("sha256", this.apiSecret).update(query).digest("hex");
  }

  private async signedRequest<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    params: Record<string, any> = {}
  ): Promise<T> {
    const timestamp = Date.now();
    const recvWindow = 5000;

    const search = new URLSearchParams();
    search.append("timestamp", String(timestamp));
    search.append("recvWindow", String(recvWindow));

    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      search.append(k, String(v));
    }

    const query = search.toString();
    const signature = this.sign(query);
    search.append("signature", signature);

    const url = `${this.baseUrl}${path}?${search.toString()}`;

    const res = await axios.request<T>({
      method,
      url,
      headers: { "X-MBX-APIKEY": this.apiKey },
      timeout: 10000
    });

    return res.data;
  }

  /** exchangeInfo yükle ve tick/step/minNotional bilgilerini sakla */
  private async ensureExchangeInfo() {
    if (this.exchangeInfoLoaded) return;
    const url = `${this.baseUrl}/fapi/v1/exchangeInfo`;
    const res = await axios.get<any>(url, { timeout: 10000 });
    if (!res.data?.symbols) return;

    for (const s of res.data.symbols) {
      const name = s.symbol as string;
      const priceFilter = s.filters.find((f: any) => f.filterType === "PRICE_FILTER");
      const lotFilter = s.filters.find((f: any) => f.filterType === "LOT_SIZE");
      const notionalFilter = s.filters.find((f: any) => f.filterType === "MIN_NOTIONAL");

      const tickSize = Number(priceFilter?.tickSize ?? 0.0001);
      const stepSize = Number(lotFilter?.stepSize ?? 0.001);
      const minQty = Number(lotFilter?.minQty ?? 0);
      const minNotional = Number(notionalFilter?.notional ?? notionalFilter?.minNotional ?? 0);

      this.symbolFilters[name] = { tickSize, stepSize, minQty, minNotional };
    }
    this.exchangeInfoLoaded = true;
  }

  private quantize(value: number, step: number, mode: "floor" | "round" | "ceil" = "floor") {
    if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) return value;
    const n = value / step;
    let q: number;
    if (mode === "round") q = Math.round(n);
    else if (mode === "ceil") q = Math.ceil(n);
    else q = Math.floor(n);
    return Number((q * step).toFixed(12));
  }

  private roundPrice(symbol: FuturesSymbol, price: number): number {
    const tick = this.symbolFilters[symbol]?.tickSize ?? 0.0001;
    return this.quantize(price, tick, "round");
  }

  private roundQuantity(
    symbol: FuturesSymbol,
    qty: number,
    mode: "floor" | "round" | "ceil" = "floor"
  ): number {
    const step = this.symbolFilters[symbol]?.stepSize ?? 0.001;
    const minQty = this.symbolFilters[symbol]?.minQty ?? 0;
    const q = this.quantize(qty, step, mode);
    if (q < minQty) return minQty;
    return q;
  }

  /** TESTNET USDT-M Futures bakiyesini okur. */
  public async getAvailableUSDT(): Promise<number> {
    try {
      if (!this.apiKey || !this.apiSecret) {
        console.error("[ExecutionClient] getAvailableUSDT: key/secret boş.");
        return 0;
      }

      const data = await this.signedRequest<any[]>("GET", "/fapi/v2/balance");

      if (!Array.isArray(data)) {
        console.error("[ExecutionClient] Beklenmeyen balance formatı:", data);
        return 0;
      }

      const usdt = data.find((x) => x.asset === "USDT");
      if (!usdt) {
        console.error("[ExecutionClient] USDT kaydı bulunamadı:", data);
        return 0;
      }

      const available = Number(usdt.availableBalance);
      if (!Number.isFinite(available)) {
        console.error(
          "[ExecutionClient] availableBalance sayıya çevrilemedi:",
          usdt
        );
        return 0;
      }

      console.log(
        `[ExecutionClient] TESTNET USDT availableBalance: ${available}`
      );
      return available;
    } catch (err: any) {
      if (err.response) {
        console.error(
          "[ExecutionClient] getAvailableUSDT Binance cevap:",
          err.response.status,
          err.response.data
        );
      } else {
        console.error(
          "[ExecutionClient] getAvailableUSDT istek hatası:",
          err.message || err
        );
      }
      return 0;
    }
  }

  /** Testnet USDT-M'de pozisyon aç. */
  public async openPosition(params: OpenPositionParams): Promise<{
    success: boolean;
    error?: string;
    details?: any;
  }> {
    const {
      symbol,
      side,
      quantity,
      entryPrice,
      stopLossPrice,
      takeProfitPrice,
      leverage,
      isolated
    } = params;

    if (!this.apiKey || !this.apiSecret) {
      return { success: false, error: "Binance API key/secret boş" };
    }

    try {
      await this.ensureExchangeInfo();
      const filters = this.symbolFilters[symbol] || {
        tickSize: 0.0001,
        stepSize: 0.001,
        minQty: 0,
        minNotional: 0
      };

      // fiyatlar
      const entry = this.roundPrice(symbol, entryPrice);
      const sl = this.roundPrice(symbol, stopLossPrice);
      const tp = this.roundPrice(symbol, takeProfitPrice);

      // miktar (girişte verilen quantity)
      let qtyRounded = this.roundQuantity(symbol, quantity);

      // min notional kontrolü: notional yetersizse yukarı yuvarla
      if (filters.minNotional) {
        const notional = entry * qtyRounded;
        if (notional < filters.minNotional) {
          const required = filters.minNotional / Math.max(entry, 1e-9);
          qtyRounded = this.roundQuantity(symbol, required, "ceil");
        }
      }

      if (!Number.isFinite(qtyRounded) || qtyRounded <= 0) {
        return { success: false, error: "Invalid quantity after rounding" };
      }

      const oppositeSide: Side = side === "BUY" ? "SELL" : "BUY";

      console.log("[ExecutionClient] openPosition placing", {
        symbol,
        side,
        qtyRounded,
        entry,
        sl,
        tp,
        filters
      });

      // 1) Leverage
      try {
        await this.signedRequest("POST", "/fapi/v1/leverage", {
          symbol,
          leverage
        });
      } catch (err: any) {
        console.error(
          "[ExecutionClient] leverage ayarlanamadı:",
          err.response?.data || err
        );
      }

      // 2) Margin type
      try {
        await this.signedRequest("POST", "/fapi/v1/marginType", {
          symbol,
          marginType: isolated ? "ISOLATED" : "CROSSED"
        });
      } catch (err: any) {
        if (err.response?.data?.code !== -4046) {
          console.error(
            "[ExecutionClient] marginType ayarlanamadı:",
            err.response?.data || err
          );
        }
      }

      // 3) Ana MARKET order (entry)
      const mainOrder = await this.signedRequest<any>("POST", "/fapi/v1/order", {
        symbol,
        side,
        type: "MARKET",
        quantity: qtyRounded
      });

      // 4) Stop Loss - STOP_MARKET closePosition=true
      const slOrder = await this.signedRequest<any>("POST", "/fapi/v1/order", {
        symbol,
        side: oppositeSide,
        type: "STOP_MARKET",
        stopPrice: sl,
        closePosition: true,
        workingType: "MARK_PRICE"
      });

      // 5) Take Profit - TAKE_PROFIT_MARKET closePosition=true
      const tpOrder = await this.signedRequest<any>("POST", "/fapi/v1/order", {
        symbol,
        side: oppositeSide,
        type: "TAKE_PROFIT_MARKET",
        stopPrice: tp,
        closePosition: true,
        workingType: "MARK_PRICE"
      });

      console.log("[ExecutionClient] openPosition OK", {
        symbol,
        side,
        qtyRounded,
        entry,
        sl,
        tp
      });

      return {
        success: true,
        details: { mainOrder, slOrder, tpOrder, qtyRounded, entry, sl, tp }
      };
    } catch (err: any) {
      console.error(
        "[ExecutionClient] openPosition error raw:",
        JSON.stringify(err?.response?.data ?? err, null, 2)
      );
      return {
        success: false,
        error: err?.response?.data?.msg || String(err)
      };
    }
  }

  /** Testnet USDT-M'de pozisyon kapat. */
  public async closePosition(
    symbol: FuturesSymbol,
    side: Side
  ): Promise<{ success: boolean; error?: string; details?: any }> {
    if (!this.apiKey || !this.apiSecret) {
      return { success: false, error: "Binance API key/secret boş" };
    }

    try {
      await this.ensureExchangeInfo();

      const oppositeSide: Side = side === "BUY" ? "SELL" : "BUY";

      const res = await this.signedRequest<any>("POST", "/fapi/v1/order", {
        symbol,
        side: oppositeSide,
        type: "MARKET",
        closePosition: true
      });

      console.log("[ExecutionClient] closePosition OK", { symbol, side });

      return { success: true, details: res };
    } catch (err: any) {
      console.error(
        "[ExecutionClient] closePosition error:",
        err.response?.data || err
      );
      return {
        success: false,
        error: err.response?.data?.msg || String(err)
      };
    }
  }
}
