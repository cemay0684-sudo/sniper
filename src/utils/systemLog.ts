export type SystemLogLevel = "INFO" | "WARN" | "ERROR";
export type SystemLogSource = "STRATEGY" | "EXECUTION" | "WS" | "SERVER";

export interface SystemLogEntry {
  time: string;        // ISO string
  level: SystemLogLevel;
  source: SystemLogSource;
  message: string;
  context?: any;
}

const MAX_LOGS = 200;
const logBuffer: SystemLogEntry[] = [];

export function addSystemLog(entry: SystemLogEntry) {
  logBuffer.push(entry);
  if (logBuffer.length > MAX_LOGS) {
    logBuffer.shift();
  }
}

export function getSystemLogs(limit = 50): SystemLogEntry[] {
  if (limit <= 0) return [];
  return logBuffer.slice(-limit);
}
