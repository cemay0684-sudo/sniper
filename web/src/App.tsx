import { useEffect, useState } from "react";
import {
  fetchDashboard,
  fetchWallet,
  fetchLogs,
  fetchMarketFunding
} from "./api";
import "./App.css";

interface DashboardRow {
  symbol: string;
  price: number | null;
  cvd15m: number | null;
  oiChangePct15m?: number | null;
  oiChangePct1h?: number | null;
  openInterest?: number | null;
  rvol15m: number | null;
  fundingRate: number | null;
  imbalanceScore: number | null;
  zone: string | null;
  sweep: string | null;
  divergence: boolean | null;
  status: string;
  bias4h?: "LONG" | "SHORT" | "FLAT" | null;
  bias15m?: "LONG" | "SHORT" | "FLAT" | null;
}

interface MarketFundingRow {
  symbol: string;
  fundingRate: number | null;
  fundingTime: number | null;
  openInterest: number | null;
  oiTime: number | null;
}

interface SystemLog {
  time: string;
  level: "INFO" | "WARN" | "ERROR";
  source: "STRATEGY" | "EXECUTION" | "WS" | "SERVER";
  message: string;
  context?: any;
}

function formatNumber(value: number | null | undefined, decimals = 2): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return value.toFixed(decimals);
}

function App() {
  const [dashboard, setDashboard] = useState<DashboardRow[]>([]);
  const [marketFunding, setMarketFunding] = useState<MarketFundingRow[]>([]);
  const [lastUpdate, setLastUpdate] = useState<string>("");
  const [wallet, setWallet] = useState<number | null>(null);
  const [logs, setLogs] = useState<SystemLog[]>([]);
  const [loading, setLoading] = useState(true);

  async function loadAll() {
    try {
      setLoading(true);
      const [d, w, l, mf] = await Promise.all([
        fetchDashboard(),
        fetchWallet(),
        fetchLogs(30),
        fetchMarketFunding()
      ]);

      // API contract:
      // - d.data is an array of dashboard rows (may already include oiChangePct15m/1h)
      // - mf.data is market funding rows (openInterest)
      setDashboard(d.data || []);
      setLastUpdate(d.lastUpdate || "");
      setWallet(w.availableUSDT ?? null);
      setLogs((l.logs || []).slice().reverse());
      setMarketFunding(mf.data || []);
    } catch (err) {
      console.error("Load error:", err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAll();
    const id = setInterval(loadAll, 5000);
    return () => clearInterval(id);
  }, []);

  // Merge marketFunding into dashboard rows (openInterest & fundingRate fallback)
  const mergedDashboard: DashboardRow[] = dashboard.map((row) => {
    const mf = marketFunding.find((m) => m.symbol === row.symbol);
    return {
      ...row,
      fundingRate:
        mf && mf.fundingRate !== null && mf.fundingRate !== undefined
          ? mf.fundingRate
          : row.fundingRate,
      openInterest:
        mf && mf.openInterest !== null && mf.openInterest !== undefined
          ? mf.openInterest
          : row.openInterest ?? null,
      // Ensure oiChange fields exist (they usually come from server dashboard)
      oiChangePct15m: (row as any).oiChangePct15m ?? null,
      oiChangePct1h: (row as any).oiChangePct1h ?? null
    };
  });

  return (
    <div className="app-root">
      <header className="app-header">
        <h1>CANLI PİYASA TARAYICISI</h1>
        <div className="header-right">
          <span>
            SON VERİ:{" "}
            {lastUpdate ? new Date(lastUpdate).toLocaleTimeString() : "-"}
          </span>
        </div>
      </header>

      <main className="app-main">
        {/* Sol: Market Scanner */}
        <section className="panel panel-large">
          <div className="panel-header">Canlı Piyasa Tarayıcısı</div>
          <div className="table-wrapper">
            {loading && mergedDashboard.length === 0 ? (
              <div className="loading">Yükleniyor...</div>
            ) : (
              <table className="market-table">
                <thead>
                  <tr>
                    <th>COIN</th>
                    <th>FİYAT</th>
                    <th>CVD (15M)</th>
                    <th>OI</th>
                    <th>OI Δ(15m)</th>
                    <th>OI Δ(1h)</th>
                    <th>RVOL</th>
                    <th>FUNDING</th>
                    <th>IMB</th>
                    <th>BIAS</th>
                    <th>ZONE</th>
                    <th>SWEEP</th>
                    <th>DİV</th>
                    <th>DURUM</th>
                  </tr>
                </thead>
                <tbody>
                  {mergedDashboard.map((row) => {
                    const oiValue = row.openInterest ?? null;
                    return (
                      <tr key={row.symbol}>
                        <td className="cell-symbol">{row.symbol}</td>
                        <td>{formatNumber(row.price, 6)}</td>
                        <td
                          className={
                            (row.cvd15m ?? 0) > 0 ? "pos" : (row.cvd15m ?? 0) < 0 ? "neg" : ""
                          }
                        >
                          {formatNumber(row.cvd15m, 2)}
                        </td>

                        {/* OI */}
                        <td className="oi-cell">
                          {oiValue !== null && oiValue !== undefined
                            ? Number(oiValue).toLocaleString("en-US", {
                                maximumFractionDigits: 2
                              })
                            : "-"}
                        </td>

                        {/* OI Delta 15m */}
                        <td
                          className={
                            row.oiChangePct15m != null
                              ? row.oiChangePct15m > 0
                                ? "pos"
                                : "neg"
                              : ""
                          }
                        >
                          {row.oiChangePct15m != null
                            ? `${row.oiChangePct15m.toFixed(2)}%`
                            : "-"}
                        </td>

                        {/* OI Delta 1h */}
                        <td
                          className={
                            row.oiChangePct1h != null
                              ? row.oiChangePct1h > 0
                                ? "pos"
                                : "neg"
                              : ""
                          }
                        >
                          {row.oiChangePct1h != null
                            ? `${row.oiChangePct1h.toFixed(2)}%`
                            : "-"}
                        </td>

                        <td>{formatNumber(row.rvol15m, 2)}</td>
                        <td
                          className={
                            row.fundingRate != null
                              ? row.fundingRate < 0
                                ? "neg"
                                : "pos"
                              : ""
                          }
                        >
                          {row.fundingRate !== null &&
                          row.fundingRate !== undefined
                            ? `${(row.fundingRate * 100).toFixed(4)}%`
                            : "-"}
                        </td>
                        <td>{formatNumber(row.imbalanceScore, 2)}</td>
                        <td>
                          {row.bias4h || row.bias15m ? (
                            <span className="bias-pill">
                              {row.bias4h && (
                                <span
                                  className={
                                    row.bias4h === "LONG"
                                      ? "badge badge-green"
                                      : row.bias4h === "SHORT"
                                      ? "badge badge-red"
                                      : "badge badge-gray"
                                  }
                                >
                                  4H {row.bias4h}
                                </span>
                              )}
                              {row.bias15m && (
                                <span
                                  className={
                                    row.bias15m === "LONG"
                                      ? "badge badge-green"
                                      : row.bias15m === "SHORT"
                                      ? "badge badge-red"
                                      : "badge badge-gray"
                                  }
                                >
                                  15M {row.bias15m}
                                </span>
                              )}
                            </span>
                          ) : (
                            "-"
                          )}
                        </td>
                        <td>
                          {row.zone ? (
                            <span
                              className={
                                row.zone === "DEMAND"
                                  ? "badge badge-green"
                                  : row.zone === "SUPPLY"
                                  ? "badge badge-red"
                                  : "badge badge-gray"
                              }
                            >
                              {row.zone}
                            </span>
                          ) : (
                            "-"
                          )}
                        </td>
                        <td>
                          {row.sweep ? (
                            <span className="badge badge-yellow">
                              {row.sweep}
                            </span>
                          ) : (
                            "-"
                          )}
                        </td>
                        <td>{row.divergence ? "YES" : "-"}</td>
                        <td>
                          <span
                            className={
                              row.status === "PUSU"
                                ? "badge badge-yellow"
                                : row.status === "TRIGGER"
                                ? "badge badge-orange"
                                : row.status === "IN_TRADE"
                                ? "badge badge-green"
                                : "badge badge-gray"
                            }
                          >
                            {row.status}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </section>

        {/* Sağ: Cüzdan + Loglar */}
        <section className="right-column">
          <div className="panel">
            <div className="panel-header">CÜZDAN</div>
            <div className="wallet-body">
              <div className="wallet-label">TOPLAM BAKİYE</div>
              <div className="wallet-balance">
                {wallet !== null ? wallet.toFixed(2) : "-"} <span>USDT</span>
              </div>
            </div>
          </div>

          <div className="panel">
            <div className="panel-header">SİSTEM LOGLARI</div>
            <div className="logs-body">
              {logs.length === 0 ? (
                <div className="log-item">Log yok</div>
              ) : (
                logs.map((log, idx) => (
                  <div
                    key={idx}
                    className={`log-item log-${log.level.toLowerCase()}`}
                  >
                    <span className="log-time">
                      {new Date(log.time).toLocaleTimeString()}
                    </span>
                    <span className="log-source">[{log.source}]</span>
                    <span className="log-message">{log.message}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

export default App;
