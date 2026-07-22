# Task 6 Report: Leave/Schedule Integration

## Outcome

Implemented the scheduling leave boundary, authoritative customer-skip projection, transactional leave notifications, exact authorization operation mapping, and application/worker module wiring.

- Schedule generation resolves effective leave before reconciliation. Accepted occurrences become finalized `skipped_by_customer` deliveries with an immutable system event tagged `customer_on_leave`; pending and rejected occurrences remain scheduled.
- Direct leave create/amend/cancel and vendor decisions synchronize eligible delivery projections in the authoritative transaction. Customer/system leave skips can be reopened, while unrelated system and agent-finalized outcomes remain protected.
- Accepted leave notifies the customer and currently assigned route agents. Rejected decisions notify only the requesting customer. Notification failures roll back the leave revision, delivery projection/event, audit, and prior notifications.
- Delivery-policy PATCH uses `schedule:manage` / `vendor.delivery-policy.update`; GET remains unchanged. Leave decision reads use `schedule:read`, decisions use `schedule:manage`, and customer leave/notification operations use `customer:self`.
- The HTTP application registers Leave and Notifications. The worker graph receives only the narrow leave-store/scheduling providers, avoiding HTTP Identity/OTP dependencies and module cycles.
- Explicit Swagger primitive types were added to the newly reachable leave DTOs, with an OpenAPI composition regression test.

## TDD Evidence

RED was observed before implementation:

- Focused scheduling boundary tests failed with `ERR_MODULE_NOT_FOUND` for `scheduling-leave.service`.
- The first isolated integration run failed in the new schedule/leave path before the boundary existed.
- App wiring exposed a leave DTO Swagger bootstrap failure at `CustomerLeavePreviewRequestDto.startDate`; the added OpenAPI composition regression covers it.
- Final no-database verification exposed the worker graph importing local OTP providers; module composition was narrowed and the existing worker graph regression then passed.
- A generated-system-skip reversal regression was added after self-review found that only direct customer-source skips were reopenable.

## Verification

- `docker compose --env-file .env.example run --rm --no-deps backend npm run verify`: PASS; 330 tests, lint, typecheck, and build passed.
- `sh test/integration-release.sh`: PASS; 254 tests against an isolated disposable PostgreSQL project.
- `sh test/security-release.sh`: PASS; 68 tests against an isolated disposable PostgreSQL project.
- `P2_VOLUME_GATE=1 sh test/schedule-generation-volume.sh`: PASS; 200,000 deliveries, first pass 41.833s, repeat pass 36.849s, no duplicates.
- `sh test/migration-drift-contract.sh`: PASS; clean schema detected, intentional drift detected, clean state restored.
- `git diff --check`: PASS.

The exact no-database command from the plan was initially run without an env file and inherited blank authentication values, causing three unrelated baseline environment failures. The approved `.env.example` variant supplies safe local-only values and is the final passing verification above. Every database-mutating command used its isolated wrapper and disposable Compose project; the default development database/project was not started or cleaned.

## Self-Review

- Tenant-sensitive reads and writes remain inside the caller's tenant transaction.
- Schedule-date locking still precedes subscription/routing/pricing/leave reconciliation, and delivery rows are locked in stable order.
- Leave ranges remain compact and are processed through bounded 100-item cursor pages; the implementation does not materialize calendar ranges.
- Notifications and delivery projections are transaction-bound; payloads contain only the leave request ID.
- Schedule regeneration preserves agent-finalized outcomes and reopens only skips proven to originate from customer leave.
- No delivery read enrichment, Phase 4 behavior, provider/outbox work, migration, or dependency was added.

Residual risk: effective leave resolution currently performs one indexed lookup per unique schedule candidate. The required 200,000-subscription volume gate passed within its limit, so no additional persistence abstraction was introduced without a concrete need.
