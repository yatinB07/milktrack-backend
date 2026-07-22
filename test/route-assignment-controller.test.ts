import assert from 'node:assert/strict';
import test from 'node:test';

import { requestContextStore } from '../src/common/context/request-context.js';
import { AgentRouteAssignmentController,RouteController } from '../src/routing/http/route.controller.js';

const actor={userId:'00000000-0000-4000-8000-000000000001',sessionId:'00000000-0000-4000-8000-000000000002',displayName:'Owner',authenticationMethod:'administrator_mfa',platformRoles:[],memberships:[]}as const,at=new Date('2026-07-20T00:00:00Z'),assignment={id:'00000000-0000-4000-8000-000000000010',routeId:'00000000-0000-4000-8000-000000000011',routeCode:'R-01',routeName:'North route',deliverySlotId:'00000000-0000-4000-8000-000000000012',deliverySlotName:'Morning',deliverySlotStartLocalTime:'06:00',deliverySlotEndLocalTime:'09:00',agentMembershipId:'00000000-0000-4000-8000-000000000013',serviceDate:'2026-07-20',status:'assigned'as const,createdAt:at,updatedAt:at};
void test('assignment controllers map pages, dynamic create status, cancel, and agent self scope',async()=>{const calls:unknown[]=[];const service={listAssignments:(...args:unknown[])=>{calls.push(['list',...args]);return Promise.resolve({items:[assignment],nextCursor:'next'});},assign:(...args:unknown[])=>{calls.push(['assign',...args]);return Promise.resolve({assignment,routeVersion:2,created:true});},cancelAssignment:(...args:unknown[])=>{calls.push(['cancel',...args]);return Promise.resolve({assignment:{...assignment,status:'cancelled'},routeVersion:3,created:false,previous:assignment});},listSelfAssignments:(...args:unknown[])=>{calls.push(['self',...args]);return Promise.resolve({items:[assignment]});}};const vendor=new RouteController(service as never),self=new AgentRouteAssignmentController(service as never),response={statusCode:0};await requestContextStore.run({correlationId:'00000000-0000-4000-8000-000000000020',actor},async()=>{assert.equal((await vendor.listAssignments('vendor','route',{limit:10})).nextCursor,'next');assert.equal((await vendor.assign('vendor','route','2026-07-20',{agentMembershipId:assignment.agentMembershipId,expectedVersion:1,reason:'Assign'},response)).routeVersion,2);assert.equal(response.statusCode,201);assert.equal((await vendor.cancelAssignment('vendor','route','2026-07-20',{expectedVersion:2,reason:'Cancel'})).status,'cancelled');assert.equal((await self.list('vendor',{serviceDate:'2026-07-20'})).items.length,1);});assert.deepEqual(calls.map(call=>(call as unknown[])[0]),['list','assign','cancel','self']);});

void test('agent assignment response adds labels and page date without uncontracted internals', async () => {
  const controller = new AgentRouteAssignmentController({
    listSelfAssignments: () => Promise.resolve({
      serviceDate: assignment.serviceDate,
      items: [{ ...assignment, internalState: 'private' }],
      nextCursor: 'next',
    }),
  } as never);

  const response = await requestContextStore.run(
    { correlationId: '00000000-0000-4000-8000-000000000020', actor },
    () => controller.list('vendor', {}),
  );

  assert.deepEqual(response, {
    serviceDate: assignment.serviceDate,
    items: [{
      id: assignment.id,
      routeId: assignment.routeId,
      routeCode: assignment.routeCode,
      routeName: assignment.routeName,
      deliverySlotId: assignment.deliverySlotId,
      deliverySlotName: assignment.deliverySlotName,
      deliverySlotStartLocalTime: assignment.deliverySlotStartLocalTime,
      deliverySlotEndLocalTime: assignment.deliverySlotEndLocalTime,
      agentMembershipId: assignment.agentMembershipId,
      serviceDate: assignment.serviceDate,
      status: assignment.status,
      createdAt: assignment.createdAt.toISOString(),
      updatedAt: assignment.updatedAt.toISOString(),
    }],
    nextCursor: 'next',
  });
});
