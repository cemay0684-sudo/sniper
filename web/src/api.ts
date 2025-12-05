import { API_BASE_URL } from "./config";

export interface DashboardRow {
  symbol: string;
  price: number | null;
  cvd15m: number | null;
  oiChangePct: number | null;
  rvol15m: number | null;
  fundingRate: number | null;
  imbalanceScore: number | null;
  zone: string | null;
  sweep: string | null;
  divergence: boolean | null;
  status: string;
}

export interface DashboardResponse {
  lastUpdate: string;
  data: DashboardRow[];
}

export interface WalletResponse {
  availableUSDT: number;
}

export interface LogsResponse {
  logs: any[];
}

export async function fetchDashboard(): Promise<DashboardResponse> {
  const res = await fetch(`${API_BASE_URL}/api/dashboard`);
  if (!res.ok) throw new Error("Failed to fetch dashboard");
  return res.json();
}

export async function fetchWallet(): Promise<WalletResponse> {
  const res = await fetch(`${API_BASE_URL}/api/wallet`);
  if (!res.ok) throw new Error("Failed to fetch wallet");
  return res.json();
}

export async function fetchLogs(limit = 50): Promise<LogsResponse> {
  const res = await fetch(`${API_BASE_URL}/api/logs?limit=${limit}`);
  if (!res.ok) throw new Error("Failed to fetch logs");
  return res.json();
}
