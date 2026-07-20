import assert from 'node:assert/strict';
import test from 'node:test';

import type { TransactionContext } from '../src/common/application/transaction-context.js';
import { requestContextStore } from '../src/common/context/request-context.js';
import { DefaultRouteService } from '../src/routing/application/route.service.js';

const actor={userId:'00000000-0000-4000-8000-000000000001',sessionId:'00000000-0000-4000-8000-000000000003',displayName:'Owner',authenticationMethod:'administrator_mfa',platformRoles:[],memberships:[]} as const,tx={} as TransactionContext;
const route={id:'route',vendorId:'vendor',code:'AM',name:'Morning',deliverySlotId:'slot',status:'active' as const,version:1,createdAt:new Date(),updatedAt:new Date()};
const projection={routeId:'route',routeVersion:2,deliverySlotId:'slot',serviceDate:'2099-07-20',startDate:'2099-07-20',stops:[{id:'stop',householdId:'a',sequence:1}]};
const previous={routeId:'route',routeVersion:1,deliverySlotId:'slot',serviceDate:'2099-07-20',startDate:'2099-07-01',endDate:'2099-07-19',stops:[{id:'old-stop',householdId:'old',sequence:1}]};

void test('replace validates vendor-local date, locks route and slot, validates households in order, persists, and audits',async()=>{
  const calls:string[]=[],events:unknown[]=[];
  const authorization={execute:(_input:unknown,work:(context:TransactionContext)=>Promise<unknown>)=>work(tx)};
  const routes={lockRoot:()=>{calls.push('route');return Promise.resolve(route);}};
  const plans={replace:(_tx:TransactionContext,input:{householdIds:readonly string[]})=>{calls.push(`replace:${input.householdIds.join(',')}`);return Promise.resolve({projection,previous});}};
  const catalog={requireRouteDeliverySlot:()=>{calls.push('slot');return Promise.resolve({deliverySlotId:'slot'});}};
  const households={requireRouteHouseholds:(_tx:TransactionContext,ids:readonly string[])=>{calls.push(`households:${ids.join(',')}`);return Promise.resolve({householdIds:ids});}};
  const vendors={getSubscriptionTimezone:()=>{calls.push('timezone');return Promise.resolve({timezone:'Pacific/Kiritimati'});}};
  const audits={append:(_tx:TransactionContext,event:unknown)=>{events.push(event);return Promise.resolve();}};
  const service=new DefaultRouteService(authorization as never,routes as never,plans as never,catalog as never,households as never,vendors as never,audits);
  const result=await requestContextStore.run({correlationId:'00000000-0000-4000-8000-000000000002'},()=>service.replaceStops(actor,'vendor','route',{effectiveDate:'2099-07-20',expectedVersion:1,reason:' New order ',householdIds:['b','a']}));
  assert.deepEqual(result,projection);assert.deepEqual(calls,['timezone','route','slot','households:a,b','replace:b,a']);
  assert.deepEqual(events,[{id:(events[0] as {id:string}).id,vendorId:'vendor',actorUserId:actor.userId,action:'route_stops.replaced',entityType:'route',entityId:'route',oldValue:{householdIds:['old'],effectiveDate:'2099-07-20',startDate:'2099-07-01',endDate:'2099-07-19',deliverySlotId:'slot',routeStatus:'active',routeVersion:1},newValue:{householdIds:['b','a'],effectiveDate:'2099-07-20',startDate:'2099-07-20',deliverySlotId:'slot',routeStatus:'active',routeVersion:2},reason:'New order',correlationId:'00000000-0000-4000-8000-000000000002'}]);
});

void test('zero-stop replacement still creates a plan without validating unavailable households',async()=>{
  let households=0;let replaced:unknown;
  const service=new DefaultRouteService({execute:(_input:unknown,work:(context:TransactionContext)=>Promise<unknown>)=>work(tx)} as never,{lockRoot:()=>Promise.resolve(route)} as never,{replace:(_tx:TransactionContext,input:unknown)=>{replaced=input;return Promise.resolve({projection:{...projection,stops:[]},previous});}} as never,{requireRouteDeliverySlot:()=>Promise.resolve({deliverySlotId:'slot'})} as never,{requireRouteHouseholds:()=>{households++;return Promise.reject(new Error('unavailable'));}} as never,{getSubscriptionTimezone:()=>Promise.resolve({timezone:'Asia/Kolkata'})} as never,{append:()=>Promise.resolve()});
  await requestContextStore.run({correlationId:'00000000-0000-4000-8000-000000000002'},()=>service.replaceStops(actor,'vendor','route',{effectiveDate:'2099-07-20',expectedVersion:1,reason:'End all',householdIds:[]}));
  assert.equal(households,0);assert.deepEqual((replaced as {householdIds:unknown}).householdIds,[]);
});

void test('inactive routes reject stop replacement with the stable state conflict',async()=>{
  const inactive={...route,status:'inactive' as const};
  const service=new DefaultRouteService({execute:(_input:unknown,work:(context:TransactionContext)=>Promise<unknown>)=>work(tx)} as never,{lockRoot:()=>Promise.resolve(inactive)} as never,{} as never,{} as never,{} as never,{getSubscriptionTimezone:()=>Promise.resolve({timezone:'Asia/Kolkata'})} as never,{} as never);
  await assert.rejects(service.replaceStops(actor,'vendor','route',{effectiveDate:'2099-07-20',expectedVersion:1,reason:'New order',householdIds:[]}),{code:'ROUTE_STATE_CONFLICT'});
});
