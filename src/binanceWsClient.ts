import WebSocket from "ws";
import { CONFIG } from "./config";
import { AggTradeEvent, KlineEvent, MarkPriceEvent, DataFeedHealth } from "./types";

type OnAggTrade = (trade: AggTradeEvent) => void;
type OnKline = (kline: KlineEvent) => void;
type OnMarkPrice = (mark: MarkPriceEvent) => void;
type OnConnected = () => void;
type OnDisconnected = () => void;

export class BinanceWsClient {
  private ws: WebSocket | null = null;
  private readonly baseUrl: string;
  private readonly symbols: string[];
  private health: DataFeedHealth = {
    wsConnected: false
  };

  private onAggTradeHandlers: OnAggTrade[] = [];
  private onKlineHandlers: OnKline[] = [];
  private onMarkPriceHandlers: OnMarkPrice[] = [];
  private onConnectedHandlers: OnConnected[] = [];
  private onDisconnectedHandlers: OnDisconnected[] = [];

  constructor() {
    this.baseUrl = CONFIG.binance.mainnetWsBase;
    this.symbols = CONFIG.symbols;
  }

  public getHealth(): DataFeedHealth {
    return { ...this.health };
  }

  public onAggTrade(handler: OnAggTrade) {
    this.onAggTradeHandlers.push(handler);
  }

  public onKline(handler: OnKline) {
    this.onKlineHandlers.push(handler);
  }

  public onMarkPrice(handler: OnMarkPrice) {
    this.onMarkPriceHandlers.push(handler);
  }

  public onConnected(handler: OnConnected) {
    this.onConnectedHandlers.push(handler);
  }

  public onDisconnected(handler: OnDisconnected) {
    this.onDisconnectedHandlers.push(handler);
  }

  public connect() {
    if (this.ws) {
      console.warn("BinanceWsClient: already connected or connecting.");
      return;
    }

    const streams: string[] = [];

    for (const sym of this.symbols) {
      const s = sym.toLowerCase();
      streams.push(`${s}@aggTrade`);
      streams.push(`${s}@kline_5m`);
      streams.push(`${s}@kline_15m`);
      streams.push(`${s}@kline_4h`);
      streams.push(`${s}@markPrice`);
    }

    const streamPath = streams.join("/");
    const url = `${this.baseUrl.replace("/ws", "")}/stream?streams=${streamPath}`;

    console.log("BinanceWsClient: connecting to", url);

    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      console.log("BinanceWsClient: WebSocket connected");
      this.health.wsConnected = true;
      this.onConnectedHandlers.forEach((h) => h());
    });

    this.ws.on("close", () => {
      console.warn("BinanceWsClient: WebSocket closed");
      this.health.wsConnected = false;
      this.onDisconnectedHandlers.forEach((h) => h());
      this.ws = null;

      // Basit reconnect mekanizması (2 saniye sonra tekrar bağlan)
      setTimeout(() => this.connect(), 2000);
    });

    this.ws.on("error", (err) => {
      console.error("BinanceWsClient: WebSocket error", err);
    });

    this.ws.on("message", (data: WebSocket.RawData) => {
      try {
        const parsed = JSON.parse(data.toString());

        // Combined stream yapısı: { stream: "...", data: {...} }
        const stream: string = parsed.stream;
        const payload = parsed.data;

        if (!stream || !payload) {
          return;
        }

        if (payload.e === "aggTrade") {
          const event = payload as AggTradeEvent;
          this.health.lastAggTradeTs = event.E;
          this.onAggTradeHandlers.forEach((h) => h(event));
          return;
        }

        if (payload.e === "kline") {
          const event = payload as KlineEvent;
          this.health.lastKlineTs = event.E;
          this.onKlineHandlers.forEach((h) => h(event));
          return;
        }

        if (payload.e === "markPriceUpdate") {
          const event = payload as MarkPriceEvent;
          this.health.lastMarkPriceTs = event.E;
          this.onMarkPriceHandlers.forEach((h) => h(event));
          return;
        }
      } catch (err) {
        console.error("BinanceWsClient: failed to parse message", err);
      }
    });
  }
}
