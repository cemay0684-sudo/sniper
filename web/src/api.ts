const API_BASE = "http://52.69.165.88:3000";

export async function fetchDashboard(): Promise<{
  lastUpdate: string;
  data: any[];
}> {
  const res = await fetch(`${API_BASE}/api/dashboard`);
  if (!res.ok) {
    throw new Error(`/api/dashboard HTTP ${res.status}`);
  }
  return res.json();
}

export async function fetchWallet(): Promise<{
  availableUSDT: number;
}> {
  const res = await fetch(`${API_BASE}/api/wallet`);
  if (!res.ok) {
    throw new Error(`/api/wallet HTTP ${res.status}`);
  }
  return res.json();
}

export async function fetchLogs(
  limit = 30
): Promise<{
  logs: any[];
}> {
  const res = await fetch(`${API_BASE}/api/logs?limit=${limit}`);
  if (!res.ok) {
    throw new Error(`/api/logs HTTP ${res.status}`);
  }
  return res.json();
}

// Funding + Open Interest (market-funding endpoint)
export async function fetchMarketFunding(): Promise<{
  ok: boolean;
  data: {
    symbol: string;
    fundingRate: number | null;
    fundingTime: number | null;
    openInterest: number | null;
    oiTime: number | null;
  }[];
}> {
  const res = await fetch(`${API_BASE}/api/market-funding`);
  if (!res.ok) {
    throw new Error(`/api/market-funding HTTP ${res.status}`);
  }
  return res.json();
}
