# REST / FUNDING / OI / BTC.D / EXECUTION TODO PLANI

Bu proje şu anda:

- **WS tarafı tam aktif** (aggTrade, kline, markPrice)
- CVD, Imbalance, RVOL, 4h/15m/5m mum state'i aktif
- Strateji motoru (setup + trigger) **çalışır durumda**
- Emir motoru (ExecutionClient) **yalnızca SİMÜLASYON modunda**

Aşağıdaki kısımlar bilinçli olarak **GEÇİCİ** kapatılmış veya basitleştirilmiş durumda.

---

## 1. REST TARAFI: Funding / OI / BTC Dominance

### Nerede?

- REST client: `src/binanceRestClient.ts`
  - Kullanım:
    - `ping()`
    - `getAccountInfo()`
    - `getOpenInterest()`
    - `getFundingRate()`
    - `getBtcDominancePrice()`
  - Şu an:
    - `binance-api-node` ile testnet üzerinde kararsız yanıtlar geldiği için
    - Tüm fonksiyonlar **agresif try/catch + type check** ile korunuyor
    - Veri yoksa veya format beklenenden farklıysa `null` döndürüyor

- Funding/OI/BTC.D polling: `src/server.ts`
  - `startFundingPolling` fonksiyonu **YORUMA ALINMIŞ** durumda:
    ```ts
    /*
    const startFundingPolling = () => {
      const intervalMs = CONFIG.polling.oiFundingMs;
      const poll = async () => {
        console.log("[FundingState] Refreshing funding/OI/BTC.D...");
        await fundingState.refreshAll();
      };

      poll().catch((err) => console.error("Initial funding refresh error:", err));
      setInterval(poll, intervalMs);
    };
    */
    ```
  - `app.listen` içinde:
    ```ts
    // Funding/OI/BTC.D polling'i ŞİMDİLİK BAŞLATMIYORUZ
    // startFundingPolling();
    ```
  - FundingState: `src/state/fundingState.ts`
    - Kod hazır ama `refreshAll()` çağrılmadığı için state boş (`null`).

### Neden kapalı?

- Binance Futures TESTNET + `binance-api-node` kombinasyonu:
  - Bazı endpointlerde beklenmedik/bozuk JSON dönüyor
  - Daha önce `TypeError: Cannot read properties of undefined (reading 'fundingRate')` gibi hatalar aldık
- Şu an odak: **WS tabanlı strateji ve sinyal üretimi**  
  REST veri problemleri bizi oyalamasın diye funding/OI/BTC.D tarafı beklemeye alındı.

### Ne zaman geri açılacak?

Strateji mantığı ve emir motoru **mainnet WS verisiyle** stabil olduktan sonra:

1. Ayrı bir debug endpoint/script yaz:
   - Örn: `GET /debug/rest-funding`
   - Sadece `restClient.getFundingRate`, `getOpenInterest`, `getBtcDominancePrice` sonuçlarını loglasın
   - Gerçek JSON’u `JSON.stringify` ile gör

2. Gerekirse `binance-api-node` yerine:
   - Sadece emir ve veri için **axios + resmi Binance REST dokümantasyonu** kullanan minimal bir client yaz.

3. Testnet yerine doğrudan **mainnet REST**’i düşünebilirsin:
   - İşlem emirlerini yine testnet’te,  
   - Funding/OI/BTC.D verisini mainnet’ten almak mantıklı olabilir.

---

## 2. GLOBAL FİLTRELER: Funding & BTC Dominance

### Nerede?

- Global filtreler: `src/strategy/globalFilters.ts`
  - `checkFundingFilter(...)`
    - Long:
      - `fundingRate > +0.0003` ise **GİRME**
    - Short:
      - `fundingRate < -0.0003` ise **GİRME**
    - `fundingRate == null` ise:
      - Şu an: **temkinli → allowed=false (işlem yok)**
  - `checkDominanceFilter(...)`
    - BTC.D günlük değişim hesabı henüz YOK
    - Şimdilik sadece “btcDom.price null mı?” diye bakıyor.
    - `price == null` ise allowed=false → **işlem yok**

### Şu anki durum

- Bu fonksiyonlar **tanımlı**, ama:
  - `TriggerEngine` içinde funding & dominance filtresi **TRIGGER aşamasında devre dışı**:
    ```ts
    // GERÇEK UYGULAMA (şu an yoruma alınmış durumda):
    //  const fundingFilter = checkFundingFilter(...);
    //  if (!fundingFilter.allowed) { ... }

    //  const domFilter = checkDominanceFilter(...);
    //  if (!domFilter.allowed) { ... }
    ```
- Sadece **Session filtresi** (`checkSessionFilter`) aktif.

### Neden kapalı?

- Funding/OI/BTC.D REST verisi şu an doldurulmuyor (polling kapalı)
- `checkFundingFilter` ve `checkDominanceFilter`, veri yoksa temkinli davranıp `allowed=false` dönüyor
- Bu durumda **hiçbir setup tetiklenmezdi**
- Sinyal akışını görebilmek için V1’de funding & BTC.D filtreleri TRIGGER seviyesinde devre dışı.

### Ne zaman açılacak?

- FundingState gerçekten doğru veriyi almaya başladığında:
  - `startFundingPolling()` tekrar aktif edilecek
  - `checkFundingFilter` ve `checkDominanceFilter` satırları `TriggerEngine.handle5mClose` içinde yeniden aktif edilecek

---

## 3. TRIGGER ENGINE: Funding & Dominance Filtresi KAPALI

### Nerede?

- Trigger engine: `src/strategy/triggerEngine.ts`
  - File header’da açıkça belirtilmiş:
    ```ts
    // NOT (V1 KARARI):
    //  - Funding ve BTC Dominance filtreleri, REST tarafı stabil hale gelene kadar
    //    TRIGGER seviyesinde devre dışıdır.
    ```
  - `handle5mClose` içinde funding/dom filtresi **yorum satırı**:

    ```ts
    //  const fundingFilter = checkFundingFilter(...);
    //  if (!fundingFilter.allowed) { this.removePending(ps); continue; }

    //  const domFilter = checkDominanceFilter(...);
    //  if (!domFilter.allowed) { this.removePending(ps); continue; }
    ```

### Şu an aktif olanlar

- `checkSessionFilter` → Session window’ları dışında TRIGGER yok
- 15m setup kontrolü:
  - 4h zone
  - 15m sweep
  - 15m imbalance (>=2.8 ratio, min 3 bucket)
  - CVD divergence basit versiyon
  - Bar delta sign
  - RVOL >= 2.5

---

## 4. EXECUTION CLIENT: GERÇEK EMİR BİR SONRAKİ ADIMDA

### Nerede?

- Execution client: `src/execution/executionClient.ts`
  - Şu an:
    - `getOpenPositions()` → **NOT IMPLEMENTED, empty list** dönüyor
    - `ensureLeverageAndMarginType()` → sadece `console.warn` (9x isolated TODO)
    - `roundQuantity` / `roundPrice` → TODO (şu an gelen değeri aynen dönüyor)
    - `openPosition(...)`:
      - max open positions kontrolü (simülasyon)
      - leverage/margin ayarı (simülasyon)
      - quantity/price rounding (simülasyon)
      - Sadece `console.log` + `{ success: true, simulated: true }` döner
    - `closePosition(...)`:
      - Sadece `console.log` + `{ success: true, simulated: true }`

### Neden simülasyonda?

- Önce:
  - Sinyal mantığının gerçekten istediğimiz gibi çalıştığından emin olmak
  - CVD/Imbalance/RVOL/4h/15m/5m yapısını sağlam kurmak
- Emir tarafı:
  - Binance Futures TESTNET REST = ayrı bir hata kaynağı (özellikle `binance-api-node` ile)
  - Gerçek emir atmaya geçmeden önce:
    - LOT size/tick size, margin & leverage, stop/TP emir tiplerini netleştirmek gerekiyor

### Ne zaman gerçek emir?

- Strateji sinyalleri log’da güven verici hale geldiğinde:
  1. `ExecutionClient` içinde:
     - `getOpenPositions` → `/fapi/v2/positionRisk` veya eşdeğer endpoint
     - `ensureLeverageAndMarginType` → `/fapi/v1/leverage` + `/fapi/v1/marginType`
     - `roundQuantity` / `roundPrice` → `exchangeInfo` üzerinden stepSize/tickSize
     - `openPosition` → MARKET + stop-market SL + TP (reduceOnly)
     - `closePosition` → reduceOnly MARKET
  2. İlk denemelerde:
     - Çok küçük bakiye / çok küçük qty
     - Sadece tek sembol (örneğin ETHUSDT) ile test

---

Bu dosya:
- “Kapattıklarımız nerede, niye kapalı, ne zaman açılacak?” sorularının hepsine cevap vermek için yazıldı.
- İleride geri döndüğünde:
  - Önce burayı oku
  - Sonra ilgili dosyalara (`server.ts`, `globalFilters.ts`, `triggerEngine.ts`, `executionClient.ts`, `binanceRestClient.ts`) bak.

