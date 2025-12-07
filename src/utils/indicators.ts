import { Candle } from "../state/candleState";

/**
 * True Range (TR) Hesaplaması:
 * TR = Max(High - Low, |High - PreviousClose|, |Low - PreviousClose|)
 */
export function calculateTR(current: Candle, previous: Candle): number {
  const hl = current.high - current.low;
  const hpc = Math.abs(current.high - previous.close);
  const lpc = Math.abs(current.low - previous.close);
  return Math.max(hl, hpc, lpc);
}

/**
 * Average True Range (ATR) Hesaplaması
 * Basit Hareketli Ortalama (SMA) yöntemi kullanılır.
 * @param candles Mum dizisi (En az period + 1 kadar mum olmalı)
 * @param period Periyot (Örn: 14)
 */
export function calculateATR(candles: Candle[], period: number = 14): number | null {
  if (candles.length < period + 1) return null;

  // Son 'period' kadar mumun TR değerlerini topla ve ortalamasını al
  // Wilder's smoothing yerine basit SMA (Simple Moving Average) kullanıyoruz (Şartnameye uygunluk için yeterli ve hızlı)
  
  let trSum = 0;
  // Son N mumu al (sondan başa doğru değil, hesaplama için slice yapıyoruz)
  const subset = candles.slice(-period - 1); // TR hesaplamak için bir önceki muma ihtiyaç var

  for (let i = 1; i < subset.length; i++) {
    const current = subset[i];
    const prev = subset[i - 1];
    trSum += calculateTR(current, prev);
  }

  return trSum / period;
}
