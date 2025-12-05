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

/**
 * Testnet USDT-M Futures üzerinde:
 * - Bakiyeyi okur
 * - Pozisyon açar
 * - Pozisyon kapatır
 *
 * Veri (fiyat vs.) hala mainnet'ten geliyor; trade tarafı testnet'te.
 */
export class ExecutionClient {
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly baseUrl: string = "https://testnet.binancefuture.com";

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

  public roundPrice(_symbol: FuturesSymbol, price: number): number {
    if (!Number.isFinite(price)) return price;
    return Number(price.toFixed(2));
  }

  public roundQuantity(_symbol: FuturesSymbol, qty: number): number {
    if (!Number.isFinite(qty) || qty <= 0) return 0;
    return Number(qty.toFixed(3));
  }

  /**
   * TESTNET USDT-M Futures bakiyesini okur.
   * Endpoint: GET /fapi/v2/balance
   */
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

  /**
   * Testnet USDT-M'de pozisyon aç.
   * - Leverage ayarla
   * - Margin type ayarla
   * - MARKET entry
   * - STOP_MARKET SL
   * - TAKE_PROFIT_MARKET TP
   */
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
      const qtyRounded = this.roundQuantity(symbol, quantity);
      if (!Number.isFinite(qtyRounded) || qtyRounded <= 0) {
        return { success: false, error: "Invalid quantity after rounding" };
      }

      // 1) Leverage
      try {
        await this.signedRequest("POST", "/fapi/v1/leverage", {
          symbol,
          leverage
        });
      } catch (err: any) {
        console.error("[ExecutionClient] leverage ayarlanamadı:", err.response?.data || err);
      }

      // 2) Margin type
      try {
        await this.signedRequest("POST", "/fapi/v1/marginType", {
          symbol,
          marginType: isolated ? "ISOLATED" : "CROSSED"
        });
      } catch (err: any) {
        // -4046 => Already isolated/crossed; önemli değil
        if (err.response?.data?.code !== -4046) {
          console.error("[ExecutionClient] marginType ayarlanamadı:", err.response?.data || err);
        }
      }

      // 3) Ana MARKET order (entry)
      const mainOrder = await this.signedRequest<any>("POST", "/fapi/v1/order", {
        symbol,
        side,
        type: "MARKET",
        quantity: qtyRounded
      });

      const entry = this.roundPrice(symbol, entryPrice);
      const sl = this.roundPrice(symbol, stopLossPrice);
      const tp = this.roundPrice(symbol, takeProfitPrice);
      const oppositeSide: Side = side === "BUY" ? "SELL" : "BUY";

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
        "[ExecutionClient] openPosition error:",
        err.response?.data || err
      );
      return {
        success: false,
        error: err.response?.data?.msg || String(err)
      };
    }
  }

  /**
   * Testnet USDT-M'de pozisyon kapat.
   * - Karşı taraf MARKET closePosition=true
   */
  public async closePosition(
    symbol: FuturesSymbol,
    side: Side
  ): Promise<{ success: boolean; error?: string; details?: any }> {
    if (!this.apiKey || !this.apiSecret) {
      return { success: false, error: "Binance API key/secret boş" };
    }

    try {
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
