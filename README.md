# PayCore: Payment Processing & Fraud Detection Engine

A backend payment engine: transfers are approved or declined in milliseconds by an inline fraud check, then settled asynchronously through RabbitMQ, on top of an append-only double-entry ledger.

**Stack**: TypeScript, Node.js, Express, PostgreSQL, RabbitMQ (CloudAMQP), Swagger, deployed on Render.
**Live API docs**: https://paycore-lvs4.onrender.com/api-docs/ (free instance, the first request may take about a minute to wake up)

---

## How a transfer works

```
Client / Swagger
      |  POST /api/transfers  (Idempotency-Key)
      v
 Express API --- 5 indexed fraud checks (balance, status, velocity, amount, cluster)
      |           then ONE DB transaction:
      |           debit sender -> hold in In-Transit + transfer row + outbox row
      v
 PostgreSQL (ledger, transfers, outbox)
      |  outbox publisher (at-least-once)
      v
 RabbitMQ topic exchange
  |- settlement.q -> settle: In-Transit -> receiver
  |- stats.q      -> per-user spending stats
  |- graph.q      -> device-graph clustering (BFS)
  '- analyzer.q   -> fraud signals -> auto-freeze
```

The sender gets "approved (held)" right away. The receiver gets the money when settlement runs in the background.

## Core engineering

- **Append-only double-entry ledger**: every movement is a balanced debit and credit pair. The ledger always sums to zero, and every wallet balance equals its ledger rows.
- **Idempotent transfers:** unique idempotency keys, so retries and parallel duplicates never move money twice.
- **Transactional outbox:** the hold and its event commit atomically, so no event is lost or invented.
- **Reliable queue processing:** idempotent consumers, exponential-backoff retries, dead-letter queue with replay.
- **Hold expiry and reconciliation:** unsettled holds are refunded; a scheduled job re-checks the ledger invariants.

## Fraud engine (the main feature)

**Inline checks (a few indexed lookups, no history scans):** sufficient balance, account status/blacklist, velocity (transfers per minute), amount anomaly (against a stored per-user average), and device-cluster flag.

**Device-graph clustering (BFS):** accounts and devices form a graph. When an account uses a device, a BFS over shared-device links finds the whole connected group of accounts (capped at 100). Groups of 5 or more accounts are flagged, and groups merge when a device links them. The clustering runs in the background, so the transfer request only does one indexed lookup of "is this account's cluster flagged?".

**Signals and auto-freeze:** an analyzer scores each account (velocity 2, amount anomaly 1, repeat declines 2, cluster 3). A severity sum of 5 or more within 60 minutes freezes the account. An analyst can unfreeze it, and that override blocks auto-freeze for 24 hours.

## Testing and results

All tests run against a real PostgreSQL and RabbitMQ (no mocks), on a low-end laptop, using simulated data. After each load test, a verification script checks the ledger invariants directly in SQL.

| Test | Setup | Result |
|---|---|---|
| **Load / concurrency** (k6) | 150 concurrent users, 20 sender accounts | 150/150 succeeded, **21.31 req/s**, ~**1.1 s p95** |
| **Larger run** (k6) | 500 transfers | **10.71 req/s**, **1.56 s p95**, 100% success |
| **Idempotency** | 30 parallel requests, same key | 1 transfer, 29 replays, 1 ledger debit |
| **Financial correctness** | after the load test | 6/6 invariants pass: ledger sums to 0, balances match ledger, no negative balances, In-Transit matches held transfers, no duplicate or conflicting settle/refund |
| **Reliability** | 50 transfers, 20% injected settlement failures | **100% settled**, p50 4.6 s, **p95 8.2 s**, p99 19.5 s (latency comes from retry backoff), 50/50 ledger-valid, reconciliation passed |
| **Fraud simulation** | 31 accounts (10 fraud, 21 legitimate) | **80% of fraud accounts flagged**, **4.76% false-positive rate**, auto-freeze precision **100%**, no legitimate account frozen |

Fraud simulation details: five patterns (shared-device velocity attack, shared-device repeat declines, velocity only, amount anomaly, repeat declines only). The single false positive is a legitimate account deliberately placed on a fraudster's device to test cluster handling. Auto-freeze recall was 40%, because the freeze threshold is intentionally conservative.

## Known limitations

- The fraud evaluation uses a small simulated set (31 accounts), so it shows the design works, not production accuracy.
- The API and all workers run in one process on a free instance; a real deployment would split them.
- Performance numbers come from a low-end laptop running the app, database and load generator together.