import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';

const runtime = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const owner = new pg.Pool({ connectionString: process.env.TEST_OWNER_DATABASE_URL });
test.after(() => Promise.all([runtime.end(), owner.end()]));

async function fixture(label: string) {
  const userId=randomUUID(),vendorId=randomUUID(),slotId=randomUUID(),householdId=randomUUID(),routeIds=[randomUUID(),randomUUID()] as const;
  await owner.query('INSERT INTO users(id,display_name,updated_at) VALUES($1,$2,now())',[userId,`Stops ${label}`]);
  await owner.query(`INSERT INTO vendors(id,code,legal_name,display_name,status,timezone,currency,skip_cutoff_minutes,billing_day,updated_at) VALUES($1,$2,$3,$3,'active','Asia/Kolkata','INR',0,1,now())`,[vendorId,`stops-${vendorId}`,`Stops ${label}`]);
  await owner.query(`INSERT INTO delivery_slots(id,vendor_id,code,name,start_local_time,end_local_time,updated_at) VALUES($1,$2,$3,$4,'06:00','09:00',now())`,[slotId,vendorId,`STOP_SLOT_${label}`,`Stop Slot ${label}`]);
  await owner.query(`INSERT INTO households(id,vendor_id,account_number,name,address_line_1,city,region,postal_code,country_code,updated_at) VALUES($1,$2,$3,$4,'Road','Pune','MH','411001','IN',now())`,[householdId,vendorId,`STOP-${label}`,`Stop Household ${label}`]);
  for(const [index,id] of routeIds.entries()) await owner.query(`INSERT INTO routes(id,vendor_id,code,name,delivery_slot_id,updated_at) VALUES($1,$2,$3,$4,$5,now())`,[id,vendorId,`STOP_${label}_${index}`,`Stop Route ${label} ${index}`,slotId]);
  return {userId,vendorId,slotId,householdId,routeIds};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
async function cleanup(values:readonly Fixture[]){const vendors=values.map(v=>v.vendorId),users=values.map(v=>v.userId);await owner.query('DELETE FROM route_stops WHERE vendor_id=ANY($1::uuid[])',[vendors]);await owner.query('DELETE FROM route_stop_plans WHERE vendor_id=ANY($1::uuid[])',[vendors]);await owner.query('DELETE FROM routes WHERE vendor_id=ANY($1::uuid[])',[vendors]);await owner.query('DELETE FROM households WHERE vendor_id=ANY($1::uuid[])',[vendors]);await owner.query('DELETE FROM delivery_slots WHERE vendor_id=ANY($1::uuid[])',[vendors]);await owner.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[users]);await owner.query('DELETE FROM vendors WHERE id=ANY($1::uuid[])',[vendors]);}
async function plan(value:Fixture,routeId:string,from:string,to:string|null=null,client:pg.Pool|pg.PoolClient=owner){const id=randomUUID();await client.query(`INSERT INTO route_stop_plans(id,vendor_id,route_id,delivery_slot_id,effective_from,effective_to,created_by,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,now())`,[id,value.vendorId,routeId,value.slotId,from,to,value.userId]);return id;}
async function stop(value:Fixture,routeId:string,planId:string,sequence=1,client:pg.Pool|pg.PoolClient=owner){const id=randomUUID();await client.query(`INSERT INTO route_stops(id,vendor_id,route_id,plan_id,household_id,delivery_slot_id,sequence,effective_from,effective_to,created_by,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,'1900-01-01','1900-01-02',$8,now())`,[id,value.vendorId,routeId,planId,value.householdId,value.slotId,sequence,value.userId]);return id;}
async function asTenant(vendorId:string,work:(client:pg.PoolClient)=>Promise<void>){const client=await runtime.connect();try{await client.query('BEGIN');await client.query("SELECT set_config('app.vendor_id',$1,true)",[vendorId]);await work(client);}finally{await client.query('ROLLBACK');client.release();}}

void test('route stop tables publish forced RLS, deferred identity, triggers, exclusions, indexes, and narrow grants',async()=>{
  const tables=['route_stop_plans','route_stops'];const rls=await owner.query<{relname:string;relrowsecurity:boolean;relforcerowsecurity:boolean}>('SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname=ANY($1::text[])',[tables]);assert.equal(rls.rows.length,2);assert.ok(rls.rows.every(row=>row.relrowsecurity&&row.relforcerowsecurity));
  for(const name of ['route_stop_plans_supersession_fkey','route_stops_plan_fkey','route_stops_household_fkey','route_stops_no_sequence_overlap','route_stops_no_household_slot_overlap']) assert.equal((await owner.query('SELECT 1 FROM pg_constraint WHERE conname=$1',[name])).rowCount,1);
  for(const name of ['derive_route_stop_plan_fields','propagate_route_stop_plan_fields']) assert.equal((await owner.query('SELECT 1 FROM pg_proc WHERE proname=$1',[name])).rowCount,1);
  assert.equal((await owner.query<{allowed:boolean}>("SELECT has_table_privilege('milktrack_app','route_stops','DELETE') allowed")).rows[0]?.allowed,false);
});

void test('database derives finite/open stop bounds and immediately propagates plan closure and supersession',async()=>{
  const value=await fixture('A');try{const finite=await plan(value,value.routeIds[0],'2030-01-01','2030-02-01'),finiteStop=await stop(value,value.routeIds[0],finite);assert.deepEqual((await owner.query('SELECT effective_from::text,effective_to::text FROM route_stops WHERE id=$1',[finiteStop])).rows,[{effective_from:'2030-01-01',effective_to:'2030-02-01'}]);
    const open=await plan(value,value.routeIds[0],'2030-02-01'),openStop=await stop(value,value.routeIds[0],open,2),replacement=randomUUID(),client=await owner.connect();try{await client.query('BEGIN');await client.query(`UPDATE route_stop_plans SET effective_to='2030-03-01',superseded_at=now(),superseded_by_plan_id=$1,supersession_reason='Correction',updated_at=now() WHERE id=$2`,[replacement,open]);await client.query(`INSERT INTO route_stop_plans(id,vendor_id,route_id,delivery_slot_id,effective_from,created_by,updated_at) VALUES($1,$2,$3,$4,'2030-03-01',$5,now())`,[replacement,value.vendorId,value.routeIds[0],value.slotId,value.userId]);await client.query('COMMIT');}catch(cause){await client.query('ROLLBACK');throw cause;}finally{client.release();}
    const copied=await owner.query<{effective_from:string;effective_to:string;superseded:boolean;replacement:string;reason:string}>(`SELECT effective_from::text,effective_to::text,superseded_at IS NOT NULL superseded,superseded_by_plan_id replacement,supersession_reason reason FROM route_stops WHERE id=$1`,[openStop]);assert.deepEqual(copied.rows,[{effective_from:'2030-02-01',effective_to:'2030-03-01',superseded:true,replacement,reason:'Correction'}]);
  }finally{await cleanup([value]);}
});

void test('partial exclusions reject same-route sequence and cross-route household-slot overlap',async()=>{
  const value=await fixture('B');try{const first=await plan(value,value.routeIds[0],'2030-01-01');await stop(value,value.routeIds[0],first);const sameRoute=await plan(value,value.routeIds[0],'2030-02-01');await assert.rejects(stop(value,value.routeIds[0],sameRoute),/route_stops_no_sequence_overlap/);const otherRoute=await plan(value,value.routeIds[1],'2030-02-01');await assert.rejects(stop(value,value.routeIds[1],otherRoute),/route_stops_no_household_slot_overlap/);}finally{await cleanup([value]);}
});

void test('runtime route stop access is same-tenant and bidirectionally isolated with no hard delete',async()=>{
  const values=[await fixture('C'),await fixture('D')] as const;const planIds=[await plan(values[0],values[0].routeIds[0],'2030-01-01'),await plan(values[1],values[1].routeIds[0],'2030-01-01')];const stopIds=[await stop(values[0],values[0].routeIds[0],planIds[0]),await stop(values[1],values[1].routeIds[0],planIds[1])];try{for(const [index,other] of [[0,1],[1,0]] as const){await asTenant(values[index].vendorId,async client=>{assert.equal((await client.query('SELECT id FROM route_stop_plans WHERE id=$1',[planIds[index]])).rowCount,1);assert.equal((await client.query('SELECT id FROM route_stops WHERE id=$1',[stopIds[other]])).rowCount,0);});await asTenant(values[index].vendorId,async client=>{await assert.rejects(client.query('DELETE FROM route_stops WHERE id=$1',[stopIds[index]]),/permission denied/);});await asTenant(values[index].vendorId,async client=>{await assert.rejects(client.query(`INSERT INTO route_stop_plans(id,vendor_id,route_id,delivery_slot_id,effective_from,created_by,updated_at) VALUES($1,$2,$3,$4,'2031-01-01',$5,now())`,[randomUUID(),values[other].vendorId,values[other].routeIds[0],values[other].slotId,values[other].userId]),/row-level security policy/);});}}finally{await cleanup(values);}
});
