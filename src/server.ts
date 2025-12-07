import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { CONFIG } from "./config";
import { BinanceWsClient } from "./binanceWsClient";
import { BinanceRestClient } from "./binanceRestClient";

import { OrderflowState } from "./state/orderflowState";
import { CandleState } from "./state/candleState";
import { FundingState } from "./state/fundingState";
import { FuturesSymbol, KlineEvent, MarkPriceEvent } from "./types";

import { TriggerEngine, TriggerSignal } from "./strategy/triggerEngine";
import { ExecutionClient } from "./execution/executionClient";

import { addSystemLog, getSystemLogs } from "./utils/systemLog";
import axios from "axios";

dotenv.config();

const app = express();

app.use(
  cors({
    origin: "http://52.69.165.88:5173",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  })
);

app.use(express.json());

// ---- Clients ----
const wsClient = new BinanceWsClient();
const restClient = new BinanceRestClient();
const orderflowState = new OrderflowState();
const candleState = new CandleState();
const fundingState = new FundingState(restClient);
const executionClient = new ExecutionClient();
const triggerEngine = new TriggerEngine(
  candleState,
  orderflowState,
  fundingState,
  executionClient
);

let restPingOk: boolean | null = null;
const SYMBOLS = CONFIG.symbols as FuturesSymbol[];
const lastMarkPrices: Record<string, number> = {};

// --- Güvenli OI numeric dönüşümü helper'ı ---
function toNumericOI(raw: any): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "object") {
    const oiField = (raw as any).openInterest;
    if (oiField === null || oiField === undefined) return null;
    const v = Number(oiField);
    return Number.isFinite(v) ? v : null;
  }
  const v = Number(raw);
  return Number.isFinite(v) ? v : null;
}

// ---- OI history cache (in-memory) ----
type OIEntry = { t: number; oi: number };
const oiHistory: Map<string, OIEntry[]> = new Map();

const OI_POLL_INTERVAL_MS = 30 * 1000;
const OI_HISTORY_KEEP_MS = 4 * 60 * 60 * 1000; // 4 hours
const FUNDING_REFRESH_MS = 30 * 1000;

function ingestOI(symbol: string, oi: number, ts = Date.now()) {
  const arr = oiHistory.get(symbol) ?? [];
  const exists = arr.find((e) => e.t === ts);
  if (!exists) {
    arr.push({ t: ts, oi });
    arr.sort((a, b) => a.t - b.t);
  }
  const cutoff = Date.now() - OI_HISTORY_KEEP_MS;
  oiHistory.set(
    symbol,
    arr.filter((x) => x.t >= cutoff)
  );
}

/**
 * targetTs'ten daha eski/eşit en yakın OI değerini getirir.
 * Eğer yoksa (ör. 15 dk öncesine ait sample yoksa) en yakın zamandaki değeri döner.
 */
function getOIAt(
  symbol: string,
  targetTs: number,
  allowNearestIfNone = true
): number | null {
  const arr = oiHistory.get(symbol);
  if (!arr || arr.length === 0) return null;

  // Önce targetTs'den eski/eşit en yakınını bul
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i].t <= targetTs) return arr[i].oi;
  }

  // Hiçbir kayıt targetTs'den eski/eşit değilse, en yakın kaydı döndür (isteğe bağlı)
  if (allowNearestIfNone) {
    let best = arr[0];
    let bestDiff = Math.abs(arr[0].t - targetTs);
    for (let i = 1; i < arr.length; i++) {
      const d = Math.abs(arr[i].t - targetTs);
      if (d < bestDiff) {
        best = arr[i];
        bestDiff = d;
      }
    }
    return best?.oi ?? null;
  }

  return null;
}

async function refreshFundingAndOI() {
  await fundingState.refreshAll();
  const ts = Date.now();
  for (const sym of SYMBOLS) {
    const oiRaw = fundingState.getOpenInterest(sym);
    const oiNum = toNumericOI(oiRaw);
    if (oiNum !== null) ingestOI(sym, oiNum, ts);
  }
}

// Periodik refresh + ingest
setInterval(async () => {
  try {
    await refreshFundingAndOI();
  } catch (err) {
    console.error("[FUNDING/OI REFRESH] error", err);
  }
}, FUNDING_REFRESH_MS);

// ---- Strategy signal -> logs ----
triggerEngine.onSignal((signal: TriggerSignal) => {
  addSystemLog({
    time: new Date().toISOString(),
    level: "INFO",
    source: "STRATEGY",
    message: `TRIGGER ${signal.direction} ${signal.symbol} @ ${signal.entryCandle5m.close}`,
    context: {
      symbol: signal.symbol,
      direction: signal.direction,
      entry: signal.entryCandle5m.close,
    },
  });
});

// ---- WS handlers ----
wsClient.onConnected(() => {
  console.log("[WS] Connected to Binance WS.");
  addSystemLog({
    time: new Date().toISOString(),
    level: "INFO",
    source: "WS",
    message: "Connected to Binance WS",
  });
});

wsClient.onDisconnected(() => {
  console.log("[WS] Disconnected from Binance WS.");
  addSystemLog({
    time: new Date().toISOString(),
    level: "WARN",
    source: "WS",
    message: "Disconnected from Binance WS",
  });
});

wsClient.onAggTrade((trade) => {
  orderflowState.handleAggTrade(trade);
});

wsClient.onKline((kline: KlineEvent) => {
  candleState.handleKline(kline);

  if (!kline.k.x) return;
  const interval = kline.k.i;

  console.log(
    `[kline] ${kline.s} ${kline.k.i} close=${kline.k.c} high=${kline.k.h} low=${kline.k.l} volume=${kline.k.v}`
  );

  if (interval === "15m") {
    triggerEngine.handle15mClose([kline.s as FuturesSymbol]);
  } else if (interval === "5m") {
    triggerEngine.handle5mClose([kline.s as FuturesSymbol]);
  }
});

wsClient.onMarkPrice((mark: MarkPriceEvent) => {
  const symbol = mark.s.toUpperCase();
  const price = Number(mark.p);
  if (Number.isFinite(price)) {
    lastMarkPrices[symbol] = price;
  }
});

// ---- Zone hesaplama ----
function getZoneLabelFromSwingAndPrice(
  price: number | null,
  swingHigh4h: number | null,
  swingLow4h: number | null
): "DEMAND" | "SUPPLY" | "OUT" | null {
  if (price === null || !Number.isFinite(price)) return "OUT";
  if (
    swingHigh4h === null ||
    swingLow4h === null ||
    !Number.isFinite(swingHigh4h) ||
    !Number.isFinite(swingLow4h) ||
    swingHigh4h <= swingLow4h
  ) {
    return "OUT";
  }
  const range = swingHigh4h - swingLow4h;
  const lowerZoneEnd = swingLow4h + range * 0.25;
  const upperZoneStart = swingHigh4h - range * 0.25;
  if (price <= lowerZoneEnd) return "DEMAND";
  if (price >= upperZoneStart) return "SUPPLY";
  return "OUT";
}

// ---- Health ----
app.get("/health", (_req, res) => {
  const wsHealth = wsClient.getHealth();
  const exampleSymbol = SYMBOLS[0];
  const ofState = orderflowState.getSymbolState(exampleSymbol);
  const rvol15m = candleState.getRVOL15m(exampleSymbol);
  const swing = candleState.getSwingHighLow4h(exampleSymbol);
  const funding = fundingState.getFunding(exampleSymbol);
  const oi = toNumericOI(fundingState.getOpenInterest(exampleSymbol));
  const btcDom = fundingState.getBtcDominance();

  res.json({
    status: "ok",
    serverTime: new Date().toISOString(),
    ws: wsHealth,
    restPingOk,
    exampleSymbol,
    metrics: {
      orderflow: {
        cvd: ofState.cvd,
        lastBucketsCount: ofState.buckets.length,
        lastBuckets: ofState.buckets.slice(-5),
      },
      candles: {
        rvol15m,
        swingHigh4h: swing.swingHigh4h,
        swingLow4h: swing.swingLow4h,
      },
      funding,
      openInterest: oi,
      btcDominance: btcDom,
    },
  });
});

app.get("/", (_req, res) => {
  res.send("Smart Sniper Bot API is running. Strategy + Execution + Web API initialized.");
});

// ---- DEBUG ZONE ----
app.get("/debug/zone/:symbol", (req, res) => {
  const sym = (req.params.symbol || "").toUpperCase() as FuturesSymbol;
  if (!CONFIG.symbols.includes(sym)) {
    return res.status(400).json({ error: "Symbol not found in config" });
  }
  const price = lastMarkPrices[sym] ?? null;
  const swing = candleState.getSwingHighLow4h(sym);
  const zone = getZoneLabelFromSwingAndPrice(
    price,
    swing.swingHigh4h,
    swing.swingLow4h
  );

  const candles4h = candleState
    .getCandles(sym, "4h", 25)
    .filter((c) => c.closed);

  res.json({
    symbol: sym,
    price,
    swingHigh4h: swing.swingHigh4h,
    swingLow4h: swing.swingLow4h,
    calculatedZone: zone,
    candles4h: candles4h.map((c) => ({
      openTime: c.openTime,
      closeTime: c.closeTime,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    })),
  });
});

// DEBUG: OI history + current funding state
app.get("/debug/oi", (_req, res) => {
  try {
    const data: any[] = [];
    const now = Date.now();
    for (const sym of SYMBOLS) {
      const hist = oiHistory.get(sym) ?? [];
      const first = hist.length > 0 ? hist[0] : null;
      const last = hist.length > 0 ? hist[hist.length - 1] : null;
      const oiRaw = (fundingState as any).getOpenInterest(sym);
      const oiNow = toNumericOI(oiRaw);
      data.push({
        symbol: sym,
        historyLength: hist.length,
        earliest: first ? { t: first.t, oi: first.oi, agoMs: now - first.t } : null,
        latest: last ? { t: last.t, oi: last.oi, agoMs: now - last.t } : null,
        oiNowRaw: oiRaw,
        oiNowNumeric: oiNow,
      });
    }
    return res.json({ ok: true, ts: new Date().toISOString(), data });
  } catch (err: any) {
    console.error("[DEBUG] /debug/oi error", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

// DEBUG: fundingState raw getter
app.get("/debug/funding/:symbol", (req, res) => {
  try {
    const symRaw = ((req.params.symbol || "") as string).toUpperCase();
    const sym = symRaw as any;
    if (!CONFIG.symbols.includes(sym)) {
      return res.status(400).json({ error: "Symbol not in config" });
    }
    const oiRaw = (fundingState as any).getOpenInterest(sym);
    const funding = (fundingState as any).getFunding(sym);
    return res.json({
      ok: true,
      symbol: sym,
      oiRaw,
      oiNumeric: toNumericOI(oiRaw),
      funding,
    });
  } catch (err: any) {
    console.error("[DEBUG] /debug/funding error", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

// ---- DASHBOARD API ----
app.get("/api/dashboard", (_req, res) => {
  const rows = SYMBOLS.map((sym) => {
    const of = orderflowState.getSymbolState(sym);
    const rvol15m = candleState.getRVOL15m(sym);
    const price = lastMarkPrices[sym] ?? null;
    const swing = candleState.getSwingHighLow4h(sym);
    const funding = fundingState.getFunding(sym);
    const engineState = triggerEngine.getDashboardStateFor(sym);

    const imbalanceScore = orderflowState.getImbalanceScore(
      sym,
      15 * 60 * 1000
    );

    const zone = getZoneLabelFromSwingAndPrice(
      price,
      swing.swingHigh4h,
      swing.swingLow4h
    );

    let bias4h: "LONG" | "SHORT" | "FLAT" | null = null;
    if (
      swing.swingHigh4h !== null &&
      swing.swingLow4h !== null &&
      price !== null
    ) {
      const mid4h = (swing.swingHigh4h + swing.swingLow4h) / 2;
      if (price > mid4h) bias4h = "LONG";
      else if (price < mid4h) bias4h = "SHORT";
      else bias4h = "FLAT";
    }

    let bias15m: "LONG" | "SHORT" | "FLAT" | null = null;
    if (of.cvd !== null && of.cvd !== undefined) {
      if (of.cvd > 0) bias15m = "LONG";
      else if (of.cvd < 0) bias15m = "SHORT";
      else bias15m = "FLAT";
    }

    const oiRawNow = fundingState.getOpenInterest(sym);
    let oiNow = toNumericOI(oiRawNow);
    const tsNow = Date.now();

    if (oiNow === null) {
      const historyArr = oiHistory.get(sym);
      if (historyArr && historyArr.length > 0) {
        oiNow = historyArr[historyArr.length - 1].oi;
      }
    }

    // 15m ve 1h referansları; eğer tam 15m öncesi yoksa en yakınını al.
    const oi15m = getOIAt(sym, tsNow - 15 * 60 * 1000, true);
    const oi1h = getOIAt(sym, tsNow - 60 * 60 * 1000, true);

    function computePct(now: number | null, prev: number | null): number | null {
      if (
        now === null ||
        prev === null ||
        !Number.isFinite(now) ||
        !Number.isFinite(prev) ||
        prev === 0
      )
        return null;
      return ((now - prev) / prev) * 100;
    }

    const oiChangePct15m = computePct(oiNow, oi15m);
    const oiChangePct1h = computePct(oiNow, oi1h);

    return {
      symbol: sym,
      price,
      cvd15m: of.cvd,
      openInterest: oiNow ?? null,
      oiChangePct15m,
      oiChangePct1h,
      rvol15m,
      fundingRate: funding.fundingRate ?? null,
      imbalanceScore,
      zone,
      sweep: engineState.lastSetupHasSweep ?? null,
      divergence: engineState.lastSetupHasDiv ?? null,
      status: (engineState.statusString as any) || "IDLE",
      bias4h,
      bias15m,
    };
  });

  res.json({
    lastUpdate: new Date().toISOString(),
    data: rows,
  });
});

// ---- WALLET API ----
app.get("/api/wallet", async (_req, res) => {
  const available = await executionClient.getAvailableUSDT();
  res.json({
    availableUSDT: available,
  });
});

// ---- LOGS API ----
app.get("/api/logs", (req, res) => {
  const limit = req.query.limit ? Number(req.query.limit) : 30;
  const logs = getSystemLogs(
    Number.isFinite(limit) && limit > 0 ? limit : 30
  );
  res.json({ logs });
});

// --- API: Funding overview (for UI) ---
app.get("/api/funding", (req, res) => {
  try {
    const all =
      (fundingState as any).getAllForUi?.() ??
      (fundingState as any).getAll?.() ??
      [];
    return res.json({ ok: true, data: all });
  } catch (err: any) {
    console.error("[API] /api/funding error", err);
    return res.status(500).json({
      ok: false,
      error: "internal_error",
      detail: String(err),
    });
  }
});

// --- API: Open Interest (instant from Binance REST) ---
app.get("/api/open-interest", async (req, res) => {
  try {
    const symbol = (req.query.symbol as string) || "ETHUSDT";
    const url = `https://fapi.binance.com/fapi/v1/openInterest?symbol=${encodeURIComponent(symbol)}`;
    const response = await axios.get(url, { timeout: 5000 });

    const data = response.data;
    return res.json({
      ok: true,
      data: {
        symbol: data.symbol,
        openInterest: Number(data.openInterest),
        time: data.time,
      },
    });
  } catch (err: any) {
    console.error("[API] /api/open-interest error", err?.response?.data || err);
    return res.status(500).json({
      ok: false,
      error: "internal_error",
      detail: err?.response?.data || String(err),
    });
  }
});

// ---- Global error handler ----
app.use(
  (
    err: any,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    console.error("Unhandled error:", err);
    addSystemLog({
      time: new Date().toISOString(),
      level: "ERROR",
      source: "SERVER",
      message: "Unhandled error",
      context: String(err),
    });
    res.status(500).json({ error: "Internal Server Error" });
  }
);

const PORT = CONFIG.server.port;

// ---- Historical preload ----
async function preloadHistoricalCandles() {
  console.log("[PRELOAD] Fetching historical klines for all symbols...");
  for (const sym of SYMBOLS) {
    try {
      console.log("[PRELOAD] 4h klines for", sym);
      const klines4h = await restClient.getKlines(sym, "4h", 100);
      candleState.ingestHistoricalCandles(sym, "4h", klines4h);

      console.log("[PRELOAD] 15m klines for", sym);
      const klines15m = await restClient.getKlines(sym, "15m", 200);
      candleState.ingestHistoricalCandles(sym, "15m", klines15m);
    } catch (err) {
      console.error("[PRELOAD] error for symbol", sym, err);
    }
  }
  console.log("[PRELOAD] Candles done.");
}

// ---- NEW: OI Historical Preload (FIXED URL) ----
async function preloadOIHistory() {
  console.log("[PRELOAD] Fetching historical Open Interest (Last 1 Hour) for all symbols...");

  for (const sym of SYMBOLS) {
    try {
      const url = `https://fapi.binance.com/futures/data/openInterestHist?symbol=${sym}&period=5m&limit=30`;
      const resp = await axios.get(url, { timeout: 5000 });
      const data = resp.data;

      if (Array.isArray(data)) {
        for (const item of data) {
          const t = Number(item.timestamp);
          const oi = Number(item.sumOpenInterest);
          if (Number.isFinite(t) && Number.isFinite(oi)) {
            ingestOI(sym, oi, t);
          }
        }
      }
      await new Promise((r) => setTimeout(r, 200));
    } catch (err) {
      console.error(`[PRELOAD] OI history failed for ${sym}`, String(err));
    }
  }
  console.log("[PRELOAD] OI History done. Dashboard should show OI change now.");
}

app.listen(PORT, async () => {
  console.log(`Smart Sniper Bot server listening on port ${PORT}`);

  wsClient.connect();

  restPingOk = await restClient.ping();
  console.log("Binance REST ping:", restPingOk ? "OK" : "FAILED");

  // İlk funding/OI çekimi ve ingest
  try {
    await refreshFundingAndOI();
  } catch (err) {
    console.error("[INIT] funding/OI refresh failed", err);
  }

  if (restPingOk) {
    await preloadHistoricalCandles();
    await preloadOIHistory();
  }
});

// --- API: Market Funding + OI (UI için) ---
app.get("/api/market-funding", async (_req, res) => {
  try {
    const symbols = CONFIG.symbols as FuturesSymbol[];
    const rows: {
      symbol: FuturesSymbol;
      fundingRate: number | null;
      fundingTime: number | null;
      openInterest: number | null;
      oiTime: number | null;
    }[] = [];

    const axios = (await import("axios")).default;

    for (const sym of symbols) {
      let fundingRate: number | null = null;
      let fundingTime: number | null = null;
      let openInterest: number | null = null;
      let oiTime: number | null = null;

      try {
        const frRes = await axios.get(
          "https://fapi.binance.com/fapi/v1/fundingRate",
          {
            params: { symbol: sym, limit: 1 },
            timeout: 5000,
          }
        );
        if (Array.isArray(frRes.data) && frRes.data.length > 0) {
          const item = frRes.data[0] as any;
          const frNum = Number(item.fundingRate);
          const ftNum = Number(item.fundingTime);
          if (Number.isFinite(frNum)) fundingRate = frNum;
          if (Number.isFinite(ftNum)) fundingTime = ftNum;
        }
      } catch (e) {
        console.error("[API] /api/market-funding funding error", sym, e);
      }

      try {
        const oiRes = await axios.get(
          "https://fapi.binance.com/fapi/v1/openInterest",
          {
            params: { symbol: sym },
            timeout: 5000,
          }
        );
        if (oiRes.data && typeof oiRes.data === "object") {
          const oiNum = Number((oiRes.data as any).openInterest);
          const tNum = Number((oiRes.data as any).time);
          if (Number.isFinite(oiNum)) openInterest = oiNum;
          if (Number.isFinite(tNum)) oiTime = tNum;
        }
      } catch (e) {
        console.error("[API] /api/market-funding oi error", sym, e);
      }

      rows.push({
        symbol: sym,
        fundingRate,
        fundingTime,
        openInterest,
        oiTime,
      });
    }

    return res.json({ ok: true, data: rows });
  } catch (err: any) {
    console.error("[API] /api/market-funding error", err);
    return res.status(500).json({
      ok: false,
      error: "internal_error",
      detail: String(err),
    });
  }
});
