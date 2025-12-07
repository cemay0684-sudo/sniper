import { Candle, Interval } from "./candleState";
import { FuturesSymbol } from "../types";

interface VolumeBucket {
  priceStart: number;
  priceEnd: number;
  volume: number;
}

export class VolumeProfileState {
  // Her sembol için 4h mumları tutuyoruz
  private candles4h: Map<FuturesSymbol, Candle[]> = new Map();
  
  // Şartname: 24 Bucket (Dilim)
  private readonly BUCKET_COUNT = 24;

  /**
   * Tarihsel 4h mumları yükle (Server açılışında çağrılır)
   */
  public ingestCandles(symbol: FuturesSymbol, candles: Candle[]) {
    this.candles4h.set(symbol, candles);
  }

  /**
   * Yeni gelen 4h mumu ekle
   */
  public updateCandle(symbol: FuturesSymbol, candle: Candle) {
    const current = this.candles4h.get(symbol) ?? [];
    // Eğer son mum güncelleniyorsa (openTime aynıysa) değiştir, yoksa ekle
    const last = current[current.length - 1];
    if (last && last.openTime === candle.openTime) {
      current[current.length - 1] = candle;
    } else {
      current.push(candle);
      // Hafıza şişmesin, son 1500 mum yeterli (6 ay ~ 1080 mum)
      if (current.length > 1500) current.shift();
    }
    this.candles4h.set(symbol, current);
  }

  /**
   * Mevcut fiyata en yakın "High Volume Node" (Yüksek Hacim Düğümü) fiyatını bulur.
   * Hedef (TP) belirlemek için kullanılır.
   * * @param direction İşlem yönü ("LONG" veya "SHORT")
   * @param currentPrice Giriş fiyatı
   */
  public getClosestHVN(symbol: FuturesSymbol, direction: "LONG" | "SHORT", currentPrice: number): number | null {
    const candles = this.candles4h.get(symbol);
    if (!candles || candles.length < 50) return null; // Yeterli veri yoksa

    // 1. Visible Range Belirle (Elimizdeki verinin en yükseği ve en düşüğü)
    let minPrice = Infinity;
    let maxPrice = -Infinity;

    for (const c of candles) {
      if (c.low < minPrice) minPrice = c.low;
      if (c.high > maxPrice) maxPrice = c.high;
    }

    // 2. Bucket Boyutunu Hesapla
    const range = maxPrice - minPrice;
    const bucketSize = range / this.BUCKET_COUNT;

    // 3. Bucketları Oluştur ve Doldur
    const buckets: number[] = new Array(this.BUCKET_COUNT).fill(0);

    for (const c of candles) {
      // Mumun ortalama fiyatının hangi bucket'a düştüğünü bul
      // (Daha hassas olması için mum hacmini mumun kapsadığı bucketlara yaymak gerekir ama
      // performans için mumun 'close' veya 'hl2' fiyatını baz alıyoruz)
      const price = (c.high + c.low) / 2;
      let idx = Math.floor((price - minPrice) / bucketSize);
      if (idx < 0) idx = 0;
      if (idx >= this.BUCKET_COUNT) idx = this.BUCKET_COUNT - 1;
      
      buckets[idx] += c.volume;
    }

    // 4. HVN (High Volume Node) Tespiti
    // Basit mantık: Ortalama hacmin üzerindeki bucketlar "Node" kabul edilir.
    const totalVol = buckets.reduce((a, b) => a + b, 0);
    const avgVol = totalVol / this.BUCKET_COUNT;
    const significantNodes: number[] = []; // Node'ların orta fiyatları

    for (let i = 0; i < this.BUCKET_COUNT; i++) {
      if (buckets[i] > avgVol * 1.2) { // Ortalamanın %20 fazlası ise HVN kabul et
         const nodePrice = minPrice + (i * bucketSize) + (bucketSize / 2);
         significantNodes.push(nodePrice);
      }
    }

    // 5. En Yakın Hedefi Bul
    // LONG ise: Fiyatın üzerindeki en yakın HVN
    // SHORT ise: Fiyatın altındaki en yakın HVN
    
    let closestTarget: number | null = null;
    let minDistance = Infinity;

    for (const nodePrice of significantNodes) {
      if (direction === "LONG") {
        if (nodePrice > currentPrice) {
          const dist = nodePrice - currentPrice;
          if (dist < minDistance) {
            minDistance = dist;
            closestTarget = nodePrice;
          }
        }
      } else { // SHORT
        if (nodePrice < currentPrice) {
          const dist = currentPrice - nodePrice;
          if (dist < minDistance) {
            minDistance = dist;
            closestTarget = nodePrice;
          }
        }
      }
    }

    return closestTarget;
  }
}
