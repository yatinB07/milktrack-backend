import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';

const runtime = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const owner = new pg.Pool({ connectionString: process.env.TEST_OWNER_DATABASE_URL });
test.after(() => Promise.all([runtime.end(), owner.end()]));

void test('notification records are tenant-isolated and roll back with the authoritative transaction', async () => {
  const vendorId = randomUUID(); const userId = randomUUID(); const notificationId = randomUUID();
  try {
    await owner.query("INSERT INTO users (id,display_name,updated_at) VALUES ($1,'Notification Customer',now())", [userId]);
    await owner.query("INSERT INTO vendors (id,code,legal_name,display_name,status,timezone,currency,skip_cutoff_minutes,billing_day,updated_at) VALUES ($1,$2,'Notification Vendor','Notification Vendor','active','Asia/Kolkata','INR',0,1,now())", [vendorId, `notification-${vendorId}`]);
    const client = await runtime.connect();
    try {
      await client.query('BEGIN'); await client.query("SELECT set_config('app.vendor_id',$1,true)", [vendorId]);
      await client.query("INSERT INTO notifications (id,vendor_id,recipient_user_id,type,payload) VALUES ($1,$2,$3,'leave_accepted',$4::jsonb)", [notificationId, vendorId, userId, JSON.stringify({ leaveRequestId: randomUUID() })]);
      await client.query("UPDATE vendors SET display_name='Rolled back notification' WHERE id=$1", [vendorId]);
    } finally { await client.query('ROLLBACK'); client.release(); }
    assert.equal((await owner.query('SELECT id FROM notifications WHERE id=$1', [notificationId])).rowCount, 0);
    assert.equal((await owner.query<{ display_name: string }>('SELECT display_name FROM vendors WHERE id=$1', [vendorId])).rows[0]?.display_name, 'Notification Vendor');
  } finally {
    await owner.query('DELETE FROM notifications WHERE vendor_id=$1', [vendorId]);
    await owner.query('DELETE FROM vendors WHERE id=$1', [vendorId]); await owner.query('DELETE FROM users WHERE id=$1', [userId]);
  }
});
