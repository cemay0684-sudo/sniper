import crypto from "crypto";
import axios from "axios";
import { CONFIG } from "../src/config";

const BASE_URL = "https://fapi.binance.com";

function getSignature(queryString: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(queryString).digest("hex");
}

async function main() {
  const apiKey = CONFIG.binance.apiKey;
  const apiSecret = CONFIG.binance.apiSecret;

  if (!apiKey || !apiSecret) {
    console.error("Binance API anahtarı veya sırrı boş. CONFIG.binance.apiKey / apiSecret kontrol et.");
    process.exit(1);
  }

  const timestamp = Date.now();
  const recvWindow = 5000;

  const params = new URLSearchParams();
  params.append("timestamp", String(timestamp));
  params.append("recvWindow", String(recvWindow));

  const queryString = params.toString();
  const signature = getSignature(queryString, apiSecret);
  params.append("signature", signature);

  const url = `${BASE_URL}/fapi/v2/balance?${params.toString()}`;

  try {
    const res = await axios.get(url, {
      headers: {
        "X-MBX-APIKEY": apiKey
      },
      timeout: 10000
    });

    const data = res.data as any[];

    if (!Array.isArray(data)) {
      console.error("Beklenmeyen cevap formatı:", data);
      process.exit(1);
    }

    const usdt = data.find((item) => item.asset === "USDT");
    if (!usdt) {
      console.error("Cevapta USDT asset bulunamadı. Tüm kayıtlar:");
      console.log(JSON.stringify(data, null, 2));
      process.exit(1);
    }

    const available = Number(usdt.availableBalance);
    const balance = Number(usdt.balance);

    console.log("Futures USDT bakiyesi:");
    console.log("  walletBalance    :", balance);
    console.log("  availableBalance :", available);

    if (!Number.isFinite(available)) {
      console.error("availableBalance sayıya çevrilemedi. Ham kayıt:");
      console.log(JSON.stringify(usdt, null, 2));
      process.exit(1);
    }

    process.exit(0);
  } catch (err: any) {
    if (err.response) {
      console.error("Binance hata cevabı:", err.response.status, err.response.data);
    } else {
      console.error("İstek hatası:", err.message || err);
    }
    process.exit(1);
  }
}

main();
