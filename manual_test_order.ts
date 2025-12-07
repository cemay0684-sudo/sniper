// manual_test_order.ts

import { ExecutionClient } from './src/execution/executionClient';

async function testOrder() {
  console.log("🚀 MANUEL TEST EMRİ BAŞLATILIYOR...");

  try {
    const execClient = new ExecutionClient();

    // --- GÜNCEL AYARLAR ---
    const symbol = 'ETHUSDT'; 
    
    // DİKKAT: Miktarı artırdık. 
    // BTC fiyatı 98.000$ desek, 0.001 = 98$ eder. Bu yeterli olmalı.
    // Eğer ETH kullanıyorsanız 0.01 yapın (yaklaşık 40$ eder).
    const quantity = 0.05; 
    
    const side = 'BUY'; 
    // ---------------------

    console.log(`${symbol} paritesinde ${side} işlemi deneniyor... (Miktar: ${quantity})`);

    const result = await execClient.openPosition({
      symbol: symbol as any, 
      side: side,
      quantity: quantity,
      leverage: 9, // Kaldıraç
      
      entryPrice: 0,       
      stopLossPrice: 0,    
      takeProfitPrice: 0,  
      isolated: true       
    });

    if (result.success) {
        console.log("✅ İŞLEM BAŞARILI!");
        console.log("Order ID:", result.details?.id || result.details?.orderId);
		console.log("Tüm Sonuç:", result);
    } else {
        console.log("❌ İŞLEM BAŞARISIZ OLDU");
        console.log("Hata Detayı:", result.error);
    }

    console.log("Tam Sonuç:", result);

  } catch (error) {
    console.error("KRİTİK HATA:", error);
  }
}

testOrder();
