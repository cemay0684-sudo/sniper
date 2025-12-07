const API_BASE = "http://52.69.165.88:3000";

export async function fetchDashboard() {
  const res = await fetch(`${API_BASE}/api/dashboard`);
  if (!res.ok) throw new Error(`/api/dashboard HTTP ${res.status}`);
  return res.json();
}

export async function fetchWallet() {
  const res = await fetch(`${API_BASE}/api/wallet`);
  if (!res.ok) throw new Error(`/api/wallet HTTP ${res.status}`);
  return res.json();
}

export async function fetchLogs(limit = 30) {
  const res = await fetch(`${API_BASE}/api/logs?limit=${limit}`);
  if (!res.ok) throw new Error(`/api/logs HTTP ${res.status}`);
  return res.json();
}

export async function fetchMarketFunding() {
  const res = await fetch(`${API_BASE}/api/market-funding`);
  if (!res.ok) throw new Error(`/api/market-funding HTTP ${res.status}`);
  return res.json();
}
