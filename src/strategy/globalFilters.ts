import { Candle } from "../state/candleState";
import { FundingState } from "../state/fundingState";
import { FuturesSymbol } from "../types";

/**
 * İşlem yönü
 */
export type TradeDirection = "LONG" | "SHORT";

export interface SessionFilterResult {
  allowed: boolean;
  reason?: string;
}

export interface FundingFilterResult {
  allowed: boolean;
  reason?: string;
}

export interface DominanceFilterResult {
  allowed: boolean;
  reason?: string;
}

export interface EffortResultFilterResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Session filtresi:
 *  - Sadece şu saatlerde (UTC) işlem açılabilir:
 *    00:05 – 13:55
 *    14:05 – 21:55
 */
export function checkSessionFilter(now: Date = new Date()): SessionFilterResult {
  const hour = now.getUTCHours();
  const minute = now.getUTCMinutes();
  const hm = hour * 60 + minute;

  // 00:05 (5) – 13:55 (13*60+55=835)
  const session1Start = 0 * 60 + 5;
  const session1End = 13 * 60 + 55;

  // 14:05 (14*60+5=845) – 21:55 (21*60+55=1315)
  const session2Start = 14 * 60 + 5;
  const session2End = 21 * 60 + 55;

  const inSession1 = hm >= session1Start && hm <= session1End;
  const inSession2 = hm >= session2Start && hm <= session2End;

  if (inSession1 || inSession2) {
    return { allowed: true };
  }

  return {
    allowed: false,
    reason: `Session filter: current UTC time ${hour
      .toString()
      .padStart(2, "0")}:${minute.toString().padStart(2, "0")} is outside allowed windows.`
  };
}

/**
 * Funding filtresi:
 *  - Long: Funding Rate > +0.0003 ise GİRME.
 *  - Short: Funding Rate < -0.0003 ise GİRME.
 *  - Funding verisi yoksa (null) -> temkinli: GİRME.
 */
export function checkFundingFilter(
  fundingState: FundingState,
  symbol: FuturesSymbol,
  direction: TradeDirection
): FundingFilterResult {
  const f = fundingState.getFunding(symbol);

  if (f.fundingRate === null) {
    return {
      allowed: false,
      reason: "Funding filter: fundingRate is null (no reliable data)."
    };
  }

  const fr = f.fundingRate;

  if (direction === "LONG") {
    if (fr > 0.0003) {
      return {
        allowed: false,
        reason: `Funding filter (LONG): fundingRate=${fr} > 0.0003, skip trade.`
      };
    }
  } else {
    if (fr < -0.0003) {
      return {
        allowed: false,
        reason: `Funding filter (SHORT): fundingRate=${fr} < -0.0003, skip trade.`
      };
    }
  }

  return { allowed: true };
}

/**
 * BTC Dominance filtresi:
 *  - Long: BTC.D günlük değişimi > +%0.4 (Artıyorsa) → GİRME.
 *  - Short: BTC.D günlük değişimi < -%0.4 (Düşüyorsa) → GİRME.
 *
 * Şimdilik elimizde sadece anlık price var (ve o da testnette çalışmıyor olabilir).
 * Dolayısıyla "veri yoksa GİRME" şeklinde temkinli davranacağız.
 *
 * İleride:
 *  - Son 24h BTC.D fiyatlarını toplayıp günlük değişim oranını hesaplayacağız.
 */
export function checkDominanceFilter(
  fundingState: FundingState,
  _direction: TradeDirection
): DominanceFilterResult {
  const btcDom = fundingState.getBtcDominance();

  if (btcDom.price === null) {
    return {
      allowed: false,
      reason: "Dominance filter: BTC.D data is null (not available)."
    };
  }

  // TODO: Günlük değişim oranı hesaplanmadığı için şimdilik "sadece veri var/yok" kontrolü yapıyoruz.
  // Gerçek implementasyonda:
  //  - BTC.D için geçmiş fiyat serisi tutulacak
  //  - 24h önceki fiyata göre değişim oranı hesaplanıp eşiğe göre filtrelenecek.

  return {
    allowed: true
  };
}

/**
 * Effort vs Result (Tuzak Filtresi - "High Volume Doji"):
 *
 * Formül:
 *  - Volume >= 3x AvgVolume  (örneğin son N mumun ortalaması)
 *  - Body/Range <= 0.15
 *
 * Bu tam olarak "yüksek hacimli doji"yi yakalar.
 */
export function checkEffortVsResultFilter(
  candle: Candle,
  averageVolume: number
): EffortResultFilterResult {
  if (averageVolume <= 0) {
    // volum verisi yoksa bu filtreyi nötr sayıyoruz (allowed=true),
    // çünkü bu global kill-switch değil, sadece tuzak filtresi.
    return { allowed: true };
  }

  const volume = candle.volume;
  const body = Math.abs(candle.close - candle.open);
  const range = candle.high - candle.low;

  const isVolumeSpike = volume >= 3 * averageVolume;
  const isDojiLike = range > 0 ? body / range <= 0.15 : false;

  if (isVolumeSpike && isDojiLike) {
    return {
      allowed: false,
      reason: `Effort vs Result: High-volume doji detected (volume=${volume}, avg=${averageVolume}, body=${body}, range=${range}).`
    };
  }

  return { allowed: true };
}
