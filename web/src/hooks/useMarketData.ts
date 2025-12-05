import { useEffect, useState } from "react";

export interface FundingItem {
  symbol: string;
  fundingRate: number | null;
  nextFundingTime: number | null;
  // varsa ek alanlar da gelir (openInterest vs) ama şu an sadece bunlar lazım
}

export interface OpenInterestItem {
  symbol: string;
  openInterest: number;
  time: number;
}

interface MarketRow {
  symbol: string;
  price?: number;
  cvd15m?: number;
  oi?: number;
  rvol?: number;
  fundingRate?: number | null;
}

export function useMarketData(symbols: string[]) {
  const [funding, setFunding] = useState<Record<string, FundingItem>>({});
  const [oi, setOi] = useState<Record<string, OpenInterestItem>>({});
  const [rows, setRows] = useState<MarketRow[]>([]);
  const [loading, setLoading] = useState(false);

  // Funding'i periyodik çek
  useEffect(() => {
    let cancelled = false;

    async function fetchFunding() {
      try {
        const res = await fetch("/api/funding");
        const json = await res.json();
        if (!json.ok) return;

        const map: Record<string, FundingItem> = {};
        for (const item of json.data as FundingItem[]) {
          map[item.symbol] = item;
        }
        if (!cancelled) {
          setFunding(map);
        }
      } catch (e) {
        console.error("fetchFunding error", e);
      }
    }

    fetchFunding();
    const id = setInterval(fetchFunding, 60_000); // 60s

    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // OI'yi periyodik çek (her sembol için)
  useEffect(() => {
    let cancelled = false;

    async function fetchOiForSymbol(symbol: string) {
      try {
        const res = await fetch(`/api/open-interest?symbol=${encodeURIComponent(symbol)}`);
        const json = await res.json();
        if (!json.ok) return;

        const data = json.data as OpenInterestItem;
        if (!cancelled) {
          setOi((prev) => ({ ...prev, [symbol]: data }));
        }
      } catch (e) {
        console.error("fetchOiForSymbol error", symbol, e);
      }
    }

    if (!symbols.length) return;

    setLoading(true);
    Promise.all(symbols.map((s) => fetchOiForSymbol(s))).finally(() => {
      if (!cancelled) setLoading(false);
    });

    const id = setInterval(() => {
      symbols.forEach((s) => fetchOiForSymbol(s));
    }, 60_000); // 60s

    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [symbols]);

  // Tabloda kullanacağımız satırları birleştir
  useEffect(() => {
    const newRows: MarketRow[] = symbols.map((symbol) => {
      const f = funding[symbol];
      const o = oi[symbol];
      return {
        symbol,
        // price, cvd15m, rvol şu an placeholder; sen mevcut state'inden set edebilirsin
        price: undefined,
        cvd15m: undefined,
        rvol: undefined,
        oi: o?.openInterest,
        fundingRate: f?.fundingRate ?? null
      };
    });
    setRows(newRows);
  }, [symbols, funding, oi]);

  return { rows, funding, oi, loading };
}
