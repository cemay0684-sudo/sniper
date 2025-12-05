import dotenv from "dotenv";

dotenv.config();

export const CONFIG = {
  server: {
    port: Number(process.env.PORT || 3000)
  },
  binance: {
    mainnetWsBase: process.env.BINANCE_FUTURES_MAINNET_WS || "wss://fstream.binance.com/ws",
    testnetRestBase: process.env.BINANCE_FUTURES_TESTNET_REST || "https://testnet.binancefuture.com",
    apiKey: process.env.BINANCE_API_KEY || "",
    apiSecret: process.env.BINANCE_API_SECRET || ""
  },
  symbols: [
    "ETHUSDT",
    "1000PEPEUSDT",
    "WIFUSDT",
    "1000BONKUSDT",
    "POPCATUSDT",
    "BRETTUSDT",
    "SUIUSDT",
    "SOLUSDT"
  ],
  // BTC Dominance sembolü (Binance'te varsa bunu kullanacağız)
  btcDomSymbol: "BTCDOMUSDT",
  // OI & Funding polling interval (ms)
  polling: {
    oiFundingMs: 60_000
  }
};
