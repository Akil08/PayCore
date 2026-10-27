// Standard error shape
export interface ApiError {
  error: {
    code: string;
    message: string;
  };
}

// Auth
export interface AuthReq { email: string; password: string; }
export interface AuthRes { token: string; user: { id: string; email: string; role: string }; account_id: string | null; }
export interface LogoutRes { ok: boolean; }

// Accounts
export interface AccountMeRes { account_id: string; email: string; balance: number; status: string; }
export interface AccountLookupRes { account_id: string; email: string; }
export interface DepositWithdrawReq { amount: number; }
export interface DepositWithdrawRes { balance: number; }
export interface HistoryRes {
  items: Array<{ id: number; amount: number; reason: string; transfer_id: string | null; created_at: string }>;
  page: number;
  has_more: boolean;
}

// Transfers
export interface TransferPostReq { receiver_account_id: string; amount: number; }
export interface TransferPostRes { transfer_id: string; status: string; reason?: string; replayed?: boolean; }
export interface TransferRes {
  id: string;
  sender_account_id: string;
  receiver_account_id: string;
  amount: number;
  status: string;
  failed_check: string | null;
  created_at: string;
  updated_at: string;
}
export interface TransferListRes { items: TransferRes[]; page: number; has_more: boolean; }

// Admin
export interface AdminTransferItem { id: string; created_at: string; sender_email: string; receiver_email: string; amount: number; status: string; failed_check: string | null; }
export interface AdminTransfersRes { items: AdminTransferItem[]; page: number; has_more: boolean; }
export interface AdminFlagsRes {
  accounts: Array<{ account_id: string; email: string; status: string; reason: string | null; set_by: string; since: string }>;
  clusters: Array<{ cluster_id: string; size: number; members: string[] }>;
}
export interface AdminSignalsRes { items: Array<{ id: number; account_id: string; kind: string; severity: number; detail: any; created_at: string }> }
export interface QueueInfo { name: string; depth: number; consumers: number; processed_per_sec: number; retry_depth: number; }
export interface AdminQueuesRes { items: QueueInfo[] }
export interface DlqItem { id: number; queue: string; payload: any; error: string | null; attempts: number; created_at: string; replayed_at: string | null; }
export interface AdminDlqRes { items: DlqItem[] }
export interface ReconItem { id: number; ran_at: string; ledger_sum: number; mismatched_accounts: number; in_transit_ok: boolean; stuck_holds: number; passed: boolean; }
export interface AdminReconRes { items: ReconItem[] }
export interface AdminMetricsRes {
  tps_60s: number;
  inline_latency_ms: { count: number; p50: number; p95: number; p99: number };
  status_counts: Record<string, number>;
  outbox_pending: number;
  dlq_open: number;
  uptime_s: number;
}
