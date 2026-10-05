/**
 * #5904 probe (E28): `extract timeline --source db` on a managed PGLite brain.
 * Postgres arm: test/e2e/extract-timeline-db-postgres.test.ts.
 */
import { test } from 'bun:test';
import { managedTimelineDbRefusalExitsNonZero, managedTimelineDbWritesThroughCoordinator } from './helpers/extract-timeline-db-scenarios.ts';

test('managed extract timeline --source db writes the missing rows through the coordinator', () => managedTimelineDbWritesThroughCoordinator(), 120_000);
test('a refused timeline write says nothing was written and exits non-zero', () => managedTimelineDbRefusalExitsNonZero(), 120_000);
