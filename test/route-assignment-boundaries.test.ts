import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import type { TransactionContext } from '../src/common/application/transaction-context.js';
import { PrismaMembershipService } from '../src/memberships/application/membership.service.js';

void test('Memberships exposes only transaction-bound route-agent validation and self resolution',async()=>{const tx={}as TransactionContext,calls:unknown[]=[];const store={requireRouteAgent:(...args:unknown[])=>{calls.push(['require',...args]);return Promise.resolve({membershipId:'agent'});},resolveSelfRouteAgent:(...args:unknown[])=>{calls.push(['self',...args]);return Promise.resolve({membershipId:'agent'});}};const service=new PrismaMembershipService({}as never,store as never,{}as never);assert.deepEqual(await service.requireRouteAgent(tx,'vendor','agent'),{membershipId:'agent'});assert.deepEqual(await service.resolveSelfRouteAgent(tx,'vendor','user'),{membershipId:'agent'});assert.deepEqual(calls,[['require',tx,'vendor','agent'],['self',tx,'vendor','user']]);});

void test('assignment mutations reuse deterministic vendor-slot and exact agent-date advisory namespaces',async()=>{const source=await readFile(new URL('../src/routing/infrastructure/prisma-route-assignment.store.ts',import.meta.url),'utf8');assert.match(source,/routing-vendor-slot:/u);assert.match(source,/routing-agent:/u);assert.match(source,/\.filter\([\s\S]*\.sort\(\)/u);assert.match(source,/membershipId.*deliverySlotId.*serviceDate/u);});
