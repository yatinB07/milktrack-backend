import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';

import { TenantTransactionRunner } from '../src/common/application/transaction-context.js';
import { DeliveryPriceService } from '../src/pricing/application/delivery-price.service.js';

const owner = new pg.Pool({ connectionString: process.env.TEST_OWNER_DATABASE_URL });
const vendorId = randomUUID();
const userId = randomUUID();
const householdId = randomUUID();
const productId = randomUUID();
const unitId = randomUUID();
const slotId = randomUUID();
let app: INestApplication | undefined;

after(async () => {
  await app?.close();
  await owner.query('DELETE FROM customer_price_overrides WHERE vendor_id=$1', [vendorId]);
  await owner.query('DELETE FROM global_prices WHERE vendor_id=$1', [vendorId]);
  await owner.query('DELETE FROM delivery_slots WHERE vendor_id=$1', [vendorId]);
  await owner.query('DELETE FROM products WHERE vendor_id=$1', [vendorId]);
  await owner.query('DELETE FROM units WHERE vendor_id=$1', [vendorId]);
  await owner.query('DELETE FROM households WHERE vendor_id=$1', [vendorId]);
  await owner.query('DELETE FROM users WHERE id=$1', [userId]);
  await owner.query('DELETE FROM vendors WHERE id=$1', [vendorId]);
  await owner.end();
});

void test('delivery price evidence reads effective override before global at the original service instant', async () => {
  const overrideId = randomUUID();
  const globalId = randomUUID();
  await owner.query("INSERT INTO users (id,display_name,updated_at) VALUES ($1,'Delivery Price Owner',now())", [userId]);
  await owner.query(
    `INSERT INTO vendors (id,code,legal_name,display_name,status,timezone,currency,skip_cutoff_minutes,billing_day,updated_at)
     VALUES ($1,$2,'Delivery Price Vendor','Delivery Price Vendor','active','Asia/Kolkata','INR',0,1,now())`,
    [vendorId, `delivery-price-${vendorId}`],
  );
  await owner.query(
    "INSERT INTO households (id,vendor_id,account_number,name,address_line_1,city,region,postal_code,country_code,updated_at) VALUES ($1,$2,'DELIVERY-PRICE','Delivery Price Household','1 Price Road','Pune','Maharashtra','411001','IN',now())",
    [householdId, vendorId],
  );
  await owner.query(
    "INSERT INTO units (id,vendor_id,code,name,decimal_scale,updated_at) VALUES ($1,$2,'LITRE','Litre',2,now())",
    [unitId, vendorId],
  );
  await owner.query(
    "INSERT INTO products (id,vendor_id,code,name,default_unit_id,updated_at) VALUES ($1,$2,'MILK','Milk',$3,now())",
    [productId, vendorId, unitId],
  );
  await owner.query(
    "INSERT INTO delivery_slots (id,vendor_id,code,name,start_local_time,end_local_time,updated_at) VALUES ($1,$2,'MORNING','Morning','06:00','09:00',now())",
    [slotId, vendorId],
  );
  await owner.query(
    `INSERT INTO global_prices (id,vendor_id,product_id,unit_id,amount_minor,currency,effective_from,created_by,updated_at)
     VALUES ($1,$2,$3,$4,100,'INR','2030-01-01T00:00:00Z',$5,now())`,
    [globalId, vendorId, productId, unitId, userId],
  );
  await owner.query(
    `INSERT INTO customer_price_overrides (id,vendor_id,household_id,product_id,unit_id,amount_minor,currency,effective_from,reason,created_by,updated_at)
     VALUES ($1,$2,$3,$4,$5,95,'INR','2030-01-01T00:00:00Z','Customer agreement',$6,now())`,
    [overrideId, vendorId, householdId, productId, unitId, userId],
  );

  const { createApp } = await import('../src/bootstrap/create-app.js');
  app = await createApp({ logger: false });
  const service = app.get(DeliveryPriceService);
  const transactions = app.get(TenantTransactionRunner);
  const result = await transactions.run(vendorId, (tx) => service.resolve(tx, vendorId, {
    householdId, productId, unitId, deliverySlotId: slotId, serviceDate: '2030-01-01',
  }));

  assert.deepEqual(result, {
    amountMinor: '95', currency: 'INR', pricingLevel: 'customer_specific',
    sourcePriceId: overrideId, sourcePriceType: 'customer_price_override',
    resolvedAt: new Date('2030-01-01T00:30:00.000Z'),
  });
});
