import { BinanceRestClient } from "../binanceRestClient";
import { CONFIG } from "../config";
import { FuturesSymbol } from "../types";
import axios from "axios";

export interface SymbolFundingState {
  symbol: FuturesSymbol;
  fundingRate: number | null;
  fundingTime: number | null;
}

export interface SymbolOpenInterestState {
  symbol: FuturesSymbol;
  openInterest: number | null;
  time: number | null;
}

export interface BtcDominanceState {
  price: number | null;
  lastUpdate: number | null;
}

export class FundingState {
  private restClient: BinanceRestClient;

  private funding: Map<FuturesSymbol, SymbolFundingState> = new Map();
  private oi: Map<FuturesSymbol, SymbolOpenInterestState> = new Map();
  private btcDom: BtcDominanceState = { price: null, lastUpdate: null };

  constructor(restClient: BinanceRestClient) {
    this.restClient = restClient;
  }

  public getFunding(symbol: FuturesSymbol): SymbolFundingState {
    let f = this.funding.get(symbol);
    if (!f) {
      f = {
        symbol,
        fundingRate: null,
        fundingTime: null
      };
      this.funding.set(symbol, f);
    }
    return { ...f };
  }

  public getOpenInterest(symbol: FuturesSymbol): SymbolOpenInterestState {
    let s = this.oi.get(symbol);
    if (!s) {
      s = {
        symbol,
        openInterest: null,
        time: null
      };
      this.oi.set(symbol, s);
    }
    return { ...s };
  }

  public getBtcDominance(): BtcDominanceState {
    return { ...this.btcDom };
  }

  /**
   * Tüm semboller için funding ve OI güncelle.
   * Funding için: önce restClient, null ise HTTP fallback (fapi/v1/fundingRate).
   */
  public async refreshAll(): Promise<void> {
    const symbols = CONFIG.symbols as FuturesSymbol[];

    for (const sym of symbols) {
      try {
        // Funding: binance-api-node -> fallback HTTP
        let fundingInfo: SymbolFundingState | null = null;

        const fr = await this.restClient.getFundingRate(sym);
        if (fr) {
          fundingInfo = {
            symbol: sym,
            fundingRate: fr.fundingRate,
            fundingTime: fr.fundingTime
          };
        }

        if (!fundingInfo) {
          try {
            const frRes = await axios.get(
              "https://fapi.binance.com/fapi/v1/fundingRate",
              { params: { symbol: sym, limit: 1 }, timeout: 5000 }
            );
            if (Array.isArray(frRes.data) && frRes.data.length > 0) {
              const item = frRes.data[0] as any;
              const frNum = Number(item.fundingRate);
              const ftNum = Number(item.fundingTime);
              if (Number.isFinite(frNum)) {
                fundingInfo = {
                  symbol: sym,
                  fundingRate: frNum,
                  fundingTime: Number.isFinite(ftNum) ? ftNum : null
                };
              }
            }
          } catch (e) {
            console.error("FundingState: HTTP fallback funding error", sym, e);
          }
        }

        const oi = await this.restClient.getOpenInterest(sym);

        if (fundingInfo) {
          this.funding.set(sym, fundingInfo);
        }

        if (oi) {
          this.oi.set(sym, {
            symbol: sym,
            openInterest: oi.openInterest,
            time: oi.time
          });
        }
      } catch (err) {
        console.error("FundingState: refreshAll error for", sym, err);
      }
    }

    // BTC Dominance da güncelle
    try {
      const price = await this.restClient.getBtcDominancePrice();
      if (price !== null) {
        this.btcDom = {
          price,
          lastUpdate: Date.now()
        };
      }
    } catch (err) {
      console.error("FundingState: BTC Dominance refresh error", err);
    }
  }

  /**
   * UI için toplu funding + OI listesi
   */
  public getAllForUi() {
    const result: {
      symbol: FuturesSymbol;
      fundingRate: number | null;
      fundingTime: number | null;
      openInterest: number | null;
      oiTime: number | null;
    }[] = [];

    const symbols = CONFIG.symbols as FuturesSymbol[];

    for (const sym of symbols) {
      const f = this.getFunding(sym);
      const oi = this.getOpenInterest(sym);
      result.push({
        symbol: sym,
        fundingRate: f.fundingRate,
        fundingTime: f.fundingTime,
        openInterest: oi.openInterest,
        oiTime: oi.time
      });
    }

    return result;
  }
}
