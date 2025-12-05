import { BinanceRestClient } from "../binanceRestClient";
import { CONFIG } from "../config";
import { FuturesSymbol } from "../types";
import { FundingRateInfo, OpenInterestInfo } from "../types";

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
   * Tüm semboller için funding ve OI güncelle
   */
  public async refreshAll(): Promise<void> {
    const symbols = CONFIG.symbols as FuturesSymbol[];

    for (const sym of symbols) {
      try {
        const [funding, oi] = await Promise.all([
          this.restClient.getFundingRate(sym),
          this.restClient.getOpenInterest(sym)
        ]);

        if (funding) {
          this.funding.set(sym, {
            symbol: sym,
            fundingRate: funding.fundingRate,
            fundingTime: funding.fundingTime
          });
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
}
