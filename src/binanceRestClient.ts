import Binance from "binance-api-node";
import axios from "axios";
import { CONFIG } from "./config";
import { FundingRateInfo, OpenInterestInfo } from "./types";

/**
 * binance-api-node: REST client (Futures için basic kullanım).
 * Klines için ise doğrudan HTTP endpoint kullanıyoruz.
 */
export class BinanceRestClient {
  private client: any;

  constructor() {
    this.client = Binance({
      apiKey: CONFIG.binance.apiKey,
      apiSecret: CONFIG.binance.apiSecret
    });
  }

  /**
   * Basit ping - server time ile kontrol.
   */
  public async ping(): Promise<boolean> {
    try {
      await this.client.time();
      return true;
    } catch (err) {
      console.error("BinanceRestClient: ping error", err);
      return false;
    }
  }

  /**
   * Hesap bilgisi (availableBalance vs. için ileride kullanacağız)
   */
  public async getAccountInfo(): Promise<any | null> {
    try {
      if (!this.client.futures || !this.client.futures.accountInfo) {
        return null;
      }
      const res = await this.client.futures.accountInfo();
      return res;
    } catch (err) {
      console.error("BinanceRestClient: getAccountInfo error", err);
      return null;
    }
  }

  /**
   * Open Interest - sembol bazlı
   */
  public async getOpenInterest(
    symbol: string
  ): Promise<OpenInterestInfo | null> {
    try {
      if (!this.client.futures || !this.client.futures.openInterest) {
        return null;
      }

      const res: any = await this.client.futures.openInterest({ symbol });

      if (!res || typeof res !== "object") {
        return null;
      }

      const oiStr = (res as any).openInterest;
      if (typeof oiStr !== "string") {
        return null;
      }

      const oiNum = Number(oiStr);
      if (!Number.isFinite(oiNum)) {
        return null;
      }

      return {
        symbol,
        openInterest: oiNum,
        time: Date.now()
      };
    } catch (err) {
      console.error("BinanceRestClient: getOpenInterest error", err);
      return null;
    }
  }

  /**
   * Funding Rate - sembol bazlı, son kayıt
   */
  public async getFundingRate(
    symbol: string
  ): Promise<FundingRateInfo | null> {
    try {
      if (!this.client.futures || !this.client.futures.fundingRate) {
        return null;
      }

      const res: any = await this.client.futures.fundingRate({
        symbol,
        limit: 1
      });

      if (!Array.isArray(res) || res.length === 0) {
        return null;
      }

      const item = res[0] as any;
      if (!item || typeof item !== "object") {
        return null;
      }

      const frStr = item.fundingRate;
      const ft = item.fundingTime;

      if (typeof frStr !== "string" || typeof ft !== "number") {
        return null;
      }

      const frNum = Number(frStr);
      if (!Number.isFinite(frNum)) {
        return null;
      }

      return {
        symbol,
        fundingRate: frNum,
        fundingTime: ft
      };
    } catch (err) {
      console.error("BinanceRestClient: getFundingRate error", err);
      return null;
    }
  }

  /**
   * BTC Dominance: Binance tarafında BTCDOMUSDT sembolü varsa günlük istatistiklerden okuruz.
   */
  public async getBtcDominancePrice(): Promise<number | null> {
    try {
      if (!this.client.futures || !this.client.futures.dailyStats) {
        return null;
      }

      const res: any = await this.client.futures.dailyStats({
        symbol: CONFIG.btcDomSymbol
      });

      if (!res || typeof res !== "object") {
        return null;
      }

      const lastPriceStr = (res as any).lastPrice;
      if (typeof lastPriceStr !== "string") {
        return null;
      }

      const priceNum = Number(lastPriceStr);
      if (!Number.isFinite(priceNum)) {
        return null;
      }

      return priceNum;
    } catch (err) {
      console.error("BinanceRestClient: getBtcDominancePrice error", err);
      return null;
    }
  }

  /**
   * Genel kline (mum) endpoint'i:
   *  - interval: "4h", "15m" vb.
   *  - limit: maksimum mum sayısı
   *
   * Binance Futures HTTP endpoint:
   *  GET https://fapi.binance.com/fapi/v1/klines?symbol=ETHUSDT&interval=4h&limit=100
   */
  public async getKlines(
    symbol: string,
    interval: string,
    limit: number
  ): Promise<
    Array<{
      openTime: number;
      closeTime: number;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
    }>
  > {
    try {
      const url = "https://fapi.binance.com/fapi/v1/klines";
      const params = {
        symbol,
        interval,
        limit
      };

      const res = await axios.get(url, { params, timeout: 10_000 });

      if (!Array.isArray(res.data)) {
        console.error(
          "BinanceRestClient: getKlines unexpected response",
          res.data
        );
        return [];
      }

      return res.data.map((k: any) => ({
        openTime: k[0],
        open: Number(k[1]),
        high: Number(k[2]),
        low: Number(k[3]),
        close: Number(k[4]),
        volume: Number(k[5]),
        closeTime: k[6]
      }));
    } catch (err: any) {
      console.error(
        "BinanceRestClient: getKlines HTTP error",
        symbol,
        interval,
        err?.response?.status,
        err?.response?.data || err.message || err
      );
      return [];
    }
  }
}
