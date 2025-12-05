import React from "react";
import { useMarketData } from "../hooks/useMarketData";

const SYMBOLS = [
  "ETHUSDT",
  "1000PEPEUSDT",
  "WIFUSDT",
  "1000BONKUSDT",
  "POPCATUSDT",
  "BRETTUSDT",
  "SUIUSDT",
  "SOLUSDT"
];

export const MarketTable: React.FC = () => {
  const { rows, loading } = useMarketData(SYMBOLS);

  return (
    <div className="market-table">
      <div className="header-row">
        <span>COIN</span>
        <span>FİYAT</span>
        <span>CVD (15M)</span>
        <span>OI %</span>
        <span>RVOL</span>
        <span>FUNDING</span>
        <span>DURUM</span>
      </div>
      {loading && <div style={{ padding: 8 }}>Yükleniyor...</div>}
      {rows.map((row) => (
        <div key={row.symbol} className="data-row">
          <span>{row.symbol}</span>
          <span>{row.price?.toFixed(6) ?? "-"}</span>
          <span>{row.cvd15m?.toFixed(2) ?? "-"}</span>
          <span>{row.oi != null ? row.oi.toFixed(2) : "-"}</span>
          <span>{row.rvol != null ? row.rvol.toFixed(2) : "-"}</span>
          <span>
            {row.fundingRate != null
              ? (row.fundingRate * 100).toFixed(4) + " %"
              : "-"}
          </span>
          <span>-</span>
        </div>
      ))}
    </div>
  );
};
