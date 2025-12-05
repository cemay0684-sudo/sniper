import crypto from "crypto";
import axios from "axios";

const API_KEY = process.env.BINANCE_API_KEY || "";
const API_SECRET = process.env.BINANCE_API_SECRET || "";

// TESTNET kullanmak istiyorsan ENV ile belirle:
// BINANCE_FUTURES_ENV=testnet  veya mainnet (default mainnet)
const ENV = process.env.BINANCE_FUTURES_ENV === "testnet" ? "testnet" : "mainnet";

const BASE_URL =
  ENV === "testnet"
    ? "https://testnet.binancefuture.com"
    : "https://fapi.binance.com";

function sign(query: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(query).digest("hex");
}

async function main() {
  console.log("Ortám:", ENV, "BASE_URL:", BASE_URL);

  if (!API_KEY || !API_SECRET) {
    console.error("API_KEY veya API_SECRET boş. BINANCE_API_KEY / BINANCE_API_SECRET environment değişkenlerini doldur.");
    process.exit(1);
  }

  const timestamp = Date.now();
  const recvWindow = 5000;

  const params = new URLSearchParams();
  params.append("timestamp", String(timestamp));
  params.append("recvWindow", String(recvWindow));

  const query = params.toString();
  const signature = sign(query, API_SECRET);
  params.append("signature", signature);

  const url = `${BASE_URL}/fapi/v2/balance?${params.toString()}`;

  try {
    const res = await axios.get(url, {
      headers: {
        "X-MBX-APIKEY": API_KEY
      },
      timeout: 10000
    });

    const data = res.data as any[];

    if (!Array.isArray(data)) {
      console.error("Beklenmeyen cevap formatı:", data);
      process.exit(1);
    }

    console.log("Tüm balance kaydı:");
    console.log(JSON.stringify(data, null, 2));

    const usdt = data.find((x) => x.asset === "USDT");
    if (!usdt) {
      console.error("USDT kaydı bulunamadı.");
      process.exit(1);
    }

    console.log("\nUSDT kaydı:");
    console.log(JSON.stringify(usdt, null, 2));

    const wallet = Number(usdt.balance);
    const avail = Number(usdt.availableBalance);
    console.log(`\nÖZET -> walletBalance: ${wallet}, availableBalance: ${avail}`);
  } catch (err: any) {
    if (err.response) {
      console.error("Binance cevap:", err.response.status, err.response.data);
    } else {
      console.error("İstek hatası:", err.message || err);
    }
    process.exit(1);
  }
}

main();
