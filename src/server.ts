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

dotenv.config();

const app = express();

app.use(
  cors({
    origin: "http://52.69.165.88:5173",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"]
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
      entry: signal.entryCandle5m.close
    }
  });
});

// ---- WS handlers ----
wsClient.onConnected(() => {
  console.log("[WS] Connected to Binance WS.");
  addSystemLog({
    time: new Date().toISOString(),
    level: "INFO",
    source: "WS",
    message: "Connected to Binance WS"
  });
});

wsClient.onDisconnected(() => {
  console.log("[WS] Disconnected from Binance WS.");
  addSystemLog({
    time: new Date().toISOString(),
    level: "WARN",
    source: "WS",
    message: "Disconnected from Binance WS"
  });
});

wsClient.onAggTrade((trade) => {
  orderflowState.handleAggTrade(trade);
});

wsClient.onKline((kline: KlineEvent) => {
  candleState.handleKline(kline);

  if (!kline.k.x) return;

  const symbol = kline.s.toUpperCase() as FuturesSymbol;
  const interval = kline.k.i;

  console.log(
    `[kline] ${kline.s} ${kline.k.i} close=${kline.k.c} high=${kline.k.h} low=${kline.k.l} volume=${kline.k.v}`
  );

  if (interval === "15m") {
    triggerEngine.handle15mClose(SYMBOLS);
  } else if (interval === "5m") {
    triggerEngine.handle5mClose(SYMBOLS);
  }
});

wsClient.onMarkPrice((mark: MarkPriceEvent) => {
  const symbol = mark.s.toUpperCase();
  const price = Number(mark.p);
  if (Number.isFinite(price)) {
    lastMarkPrices[symbol] = price;
  }
  console.log(
    `[markPrice] ${mark.s} mark=${mark.p} fundingRate=${mark.r} nextFundingTs=${mark.T}`
  );
});

// ---- Zone hesaplama ----
function getZoneLabelFromSwingAndPrice(
  price: number | null,
  swingHigh4h: number | null,
  swingLow4h: number | null
): "DEMAND" | "SUPPLY" | "OUT" | null {
  if (price === null || !Number.isFinite(price)) {
    return "OUT";
  }
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
  const oi = fundingState.getOpenInterest(exampleSymbol);
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
        lastBuckets: ofState.buckets.slice(-5)
      },
      candles: {
        rvol15m,
        swingHigh4h: swing.swingHigh4h,
        swingLow4h: swing.swingLow4h
      },
      funding,
      openInterest: oi,
      btcDominance: btcDom
    }
  });
});

app.get("/", (_req, res) => {
  res.send(
    "Smart Sniper Bot API is running. Strategy + Execution + Web API initialized."
  );
});

// ---- DEBUG ZONE ----
app.get("/debug/zone/:symbol", (req, res) => {
  const sym = (req.params.symbol || "").toUpperCase() as FuturesSymbol;

  if (!CONFIG.symbols.includes(sym)) {
    return res.status(400).json({
      error: `Symbol ${sym} CONFIG.symbols içinde yok. Mevcut: ${CONFIG.symbols.join(
        ", "
      )}`
    });
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
      volume: c.volume
    }))
  });
});

// ---- DASHBOARD API ----
app.get("/api/dashboard", (_req, res) => {
  const rows = SYMBOLS.map((sym) => {
    const of = orderflowState.getSymbolState(sym);
    const rvol15m = candleState.getRVOL15m(sym);
    const price = lastMarkPrices[sym] ?? null;
    const swing = candleState.getSwingHighLow4h(sym);
    const funding = fundingState.getFunding(sym);

    const imbalanceScore = orderflowState.getImbalanceScore(
      sym,
      15 * 60 * 1000
    );

    const zone = getZoneLabelFromSwingAndPrice(
      price,
      swing.swingHigh4h,
      swing.swingLow4h
    );

    // 4H bias: swing high/low ortalamasına göre
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

    // 15M bias: cvd15m işaretine göre (örnek mantık)
    let bias15m: "LONG" | "SHORT" | "FLAT" | null = null;
    if (of.cvd !== null && of.cvd !== undefined) {
      if (of.cvd > 0) bias15m = "LONG";
      else if (of.cvd < 0) bias15m = "SHORT";
      else bias15m = "FLAT";
    }

    return {
      symbol: sym,
      price,
      cvd15m: of.cvd,
      oiChangePct: null,
      rvol15m,
      fundingRate: funding.fundingRate ?? null,
      imbalanceScore,
      zone,
      sweep: null,
      divergence: null,
      status: "IDLE" as const,
      bias4h,
      bias15m
    };
  });

  res.json({
    lastUpdate: new Date().toISOString(),
    data: rows
  });
});

// ---- WALLET API ----
app.get("/api/wallet", async (_req, res) => {
  const available = await executionClient.getAvailableUSDT();
  res.json({
    availableUSDT: available
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
      detail: String(err)
    });
  }
});

// --- API: Open Interest (instant from Binance REST) ---
// Usage: GET /api/open-interest?symbol=ETHUSDT
app.get("/api/open-interest", async (req, res) => {
  try {
    const symbol = (req.query.symbol as string) || "ETHUSDT";
    const url = `https://fapi.binance.com/fapi/v1/openInterest?symbol=${encodeURIComponent(symbol)}`;

    const axios = await import("axios");
    const response = await axios.default.get(url, { timeout: 5000 });

    const data = response.data;
    return res.json({
      ok: true,
      data: {
        symbol: data.symbol,
        openInterest: Number(data.openInterest),
        time: data.time
      }
    });
  } catch (err: any) {
    console.error("[API] /api/open-interest error", err?.response?.data || err);
    return res.status(500).json({
      ok: false,
      error: "internal_error",
      detail: err?.response?.data || String(err)
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
      context: String(err)
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

  console.log("[PRELOAD] Done.");
}

app.listen(PORT, async () => {
  console.log(`Smart Sniper Bot server listening on port ${PORT}`);

  wsClient.connect();

  restPingOk = await restClient.ping();
  console.log("Binance REST ping:", restPingOk ? "OK" : "FAILED");

  if (restPingOk) {
    await preloadHistoricalCandles();
  }
});

// --- API: Market Funding + OI (UI için, gerçek Binance REST) ---
// GET /api/market-funding
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

      // Funding rate: gerçek Binance USDT-M
      try {
        const frRes = await axios.get(
          "https://fapi.binance.com/fapi/v1/fundingRate",
          {
            params: { symbol: sym, limit: 1 },
            timeout: 5000
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

      // Open interest: gerçek Binance USDT-M
      try {
        const oiRes = await axios.get(
          "https://fapi.binance.com/fapi/v1/openInterest",
          {
            params: { symbol: sym },
            timeout: 5000
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
        oiTime
      });
    }

    return res.json({ ok: true, data: rows });
  } catch (err: any) {
    console.error("[API] /api/market-funding error", err);
    return res.status(500).json({
      ok: false,
      error: "internal_error",
      detail: String(err)
    });
  }
});
