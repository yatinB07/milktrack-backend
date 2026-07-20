import assert from 'node:assert/strict';
import test from 'node:test';

import type { TransactionContext } from '../src/common/application/transaction-context.js';
import { requestContextStore } from '../src/common/context/request-context.js';
import { DefaultRouteService } from '../src/routing/application/route.service.js';

const actor={userId:'00000000-0000-4000-8000-000000000001',sessionId:'00000000-0000-4000-8000-000000000003',displayName:'Owner',authenticationMethod:'administrator_mfa',platformRoles:[],memberships:[]} as const,tx={} as TransactionContext;
const route={id:'route',vendorId:'vendor',code:'AM',name:'Morning',deliverySlotId:'slot',status:'active' as const,version:1,createdAt:new Date(),updatedAt:new Date()};
const projection={routeId:'route',routeVersion:2,deliverySlotId:'slot',serviceDate:'2026-07-20',effectiveFrom:'2026-07-20',stops:[{id:'stop',householdId:'household',sequence:1}]};

void test('replace validates vendor-local date, locks route and slot, validates households in order, persists, and audits',async()=>{
  const calls:string[]=[],events:unknown[]=[];
  const authorization={execute:(_input:unknown,work:(context:TransactionContext)=>Promise<unknown>)=>work(tx)};
  const routes={lockRoot:()=>{calls.push('route');return Promise.resolve(route);}};
  const plans={replace:(_tx:TransactionContext,input:{householdIds:readonly string[]})=>{calls.push(`replace:${input.householdIds.join(',')}`);return Promise.resolve(projection);}};
  const catalog={requireRouteDeliverySlot:()=>{calls.push('slot');return Promise.resolve({deliverySlotId:'slot'});}};
  const households={requireRouteHousehold:(_tx:TransactionContext,id:string)=>{calls.push(`household:${id}`);return Promise.resolve({householdId:id});}};
  const vendors={getSubscriptionTimezone:()=>{calls.push('timezone');return Promise.resolve({timezone:'Pacific/Kiritimati'});}};
  const audits={append:(_tx:TransactionContext,event:unknown)=>{events.push(event);return Promise.resolve();}};
  const service=new DefaultRouteService(authorization as never,routes as never,plans as never,catalog as never,households as never,vendors as never,audits);
  const result=await requestContextStore.run({correlationId:'00000000-0000-4000-8000-000000000002'},()=>service.replaceStops(actor,'vendor','route',{effectiveDate:'2099-07-20',expectedVersion:1,reason:' New order ',householdIds:['a','b']}));
  assert.deepEqual(result,projection);assert.deepEqual(calls,['timezone','route','slot','household:a','household:b','replace:a,b']);assert.equal(events.length,1);
});

void test('zero-stop replacement still creates a plan without validating unavailable households',async()=>{
  let households=0;let replaced:unknown;
  const service=new DefaultRouteService({execute:(_input:unknown,work:(context:TransactionContext)=>Promise<unknown>)=>work(tx)} as never,{lockRoot:()=>Promise.resolve(route)} as never,{replace:(_tx:TransactionContext,input:unknown)=>{replaced=input;return Promise.resolve({...projection,stops:[]});}} as never,{requireRouteDeliverySlot:()=>Promise.resolve({deliverySlotId:'slot'})} as never,{requireRouteHousehold:()=>{households++;return Promise.reject(new Error('unavailable'));}} as never,{getSubscriptionTimezone:()=>Promise.resolve({timezone:'Asia/Kolkata'})} as never,{append:()=>Promise.resolve()});
  await requestContextStore.run({correlationId:'00000000-0000-4000-8000-000000000002'},()=>service.replaceStops(actor,'vendor','route',{effectiveDate:'2099-07-20',expectedVersion:1,reason:'End all',householdIds:[]}));
  assert.equal(households,0);assert.deepEqual((replaced as {householdIds:unknown}).householdIds,[]);
});
