import { PoolClient } from "pg";

export async function recordDeviceAndRecluster(
  client: PoolClient,
  accountId: string,
  deviceId: string,
): Promise<void> {
  // 1. Record the device usage for this account
  await client.query(
    `INSERT INTO account_devices (account_id, device_id) 
     VALUES ($1, $2) 
     ON CONFLICT (account_id, device_id) DO NOTHING`,
    [accountId, deviceId],
  );

  // 2. Compute the connected component using BFS
  const visitedAccounts = new Set<string>();
  const queue: string[] = [accountId];
  visitedAccounts.add(accountId);

  while (queue.length > 0 && visitedAccounts.size < 100) {
    const currentAccount = queue.shift()!;

    // Get all devices associated with the current account
    const devicesRes = await client.query(
      `SELECT device_id FROM account_devices WHERE account_id = $1`,
      [currentAccount],
    );

    const deviceIds = devicesRes.rows.map((r: any) => r.device_id);
    if (deviceIds.length === 0) continue;

    // Find all accounts that share any of these devices
    const accountsRes = await client.query(
      `SELECT account_id FROM account_devices WHERE device_id = ANY($1)`,
      [deviceIds],
    );

    for (const row of accountsRes.rows) {
      if (!visitedAccounts.has(row.account_id) && visitedAccounts.size < 100) {
        visitedAccounts.add(row.account_id);
        queue.push(row.account_id);
      }
    }
  }

  // 3. Determine cluster metadata
  const sortedAccounts = Array.from(visitedAccounts).sort();
  const clusterId = sortedAccounts[0]; // Smallest account ID lexicographically
  const clusterSize = visitedAccounts.size;
  const flagged = clusterSize >= Number(process.env.CLUSTER_FLAG_SIZE || 5);

  // 4. Upsert cluster data for all members in the component
  if (visitedAccounts.size > 0) {
    const accountIds = Array.from(visitedAccounts);
    await client.query(
      `INSERT INTO account_clusters (account_id, cluster_id, cluster_size, flagged)
       SELECT unnest($1::uuid[]), $2::uuid, $3, $4
       ON CONFLICT (account_id) 
       DO UPDATE SET 
         cluster_id = EXCLUDED.cluster_id,
         cluster_size = EXCLUDED.cluster_size,
         flagged = EXCLUDED.flagged`,
      [accountIds, clusterId, clusterSize, flagged],
    );
  }
}
