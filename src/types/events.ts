export interface EventEnvelope<T = unknown> {
  event_id: string;
  type: string;
  occurred_at: string;
  payload: T;
}

export interface TransferHeldPayload {
  transfer_id: string;
  sender_account_id: string;
  receiver_account_id: string;
  amount: number;
  device_id: string | null;
}

export interface TransferDeclinedPayload {
  transfer_id: string;
  sender_account_id: string;
  failed_check: string;
}

export interface TransferSettledPayload {
  transfer_id: string;
  sender_account_id: string;
  receiver_account_id: string;
  amount: number;
  device_id: string | null;
}

export interface TransferExpiredPayload {
  transfer_id: string;
  sender_account_id: string;
  amount: number;
}

export interface StatsDonePayload {
  account_id: string;
  transfer_id: string;
}

export interface GraphDonePayload {
  account_id: string;
  transfer_id: string;
}
