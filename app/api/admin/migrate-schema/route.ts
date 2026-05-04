/**
 * POST /api/admin/migrate-schema
 *
 * One-shot schema migration. Walks every user record and the operator
 * state and re-saves them, which causes the store's saveUser /
 * updateOperator paths to stamp the current schemaVersion. Records
 * already at the current version stay at the current version (the
 * stamp is idempotent).
 *
 * Why this exists: legacy records written before the schemaVersion
 * field existed are counted as "v0" by the reconciliation drift
 * report. They're structurally identical to v1 records — the only
 * difference is whether the version field is present — but the
 * drift report still flags them. Active users converge naturally as
 * they play/withdraw/etc, but inactive users stay at v0 forever
 * unless an operator explicitly runs this migration.
 *
 * Future use: when CURRENT_SCHEMA_VERSION ever bumps to v2 with a
 * real structural change, this endpoint becomes the migration
 * primitive — adapt the loop to apply the v1→v2 transform inside
 * the saveUser call instead of just re-stamping.
 *
 * Requires 'admin' tier auth. Idempotent: safe to run multiple times.
 */

import { NextResponse } from 'next/server';
import { requireTier, isErrorResponse, CORS_HEADERS } from '../../_lib/auth';
import { getStore } from '../../_lib/store';
import { acquireOperatorLock, releaseOperatorLock } from '../../_lib/locks';
import { checkRateLimit, rateLimitResponse } from '../../_lib/rateLimit';
import { withStore } from '../../_lib/withStore';
import { CURRENT_SCHEMA_VERSION } from '~/custodial/types';

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      ...CORS_HEADERS,
      'Access-Control-Max-Age': '86400',
    },
  });
}

// withStore: F3 production-Redis preflight + uniform diagnostic shape.
export const POST = withStore(async (request: Request) => {
  try {
    // Modest limit — migration is cheap but operator-driven, no point
    // letting it be hammered.
    if (!(await checkRateLimit({ request, action: 'admin-migrate-schema', limit: 6, windowSec: 60 }))) {
      return rateLimitResponse(60);
    }

    const auth = await requireTier(request, 'admin');
    if (isErrorResponse(auth)) return auth;

    // Operator lock: migrate-schema walks the entire user list and
    // saves each one. Two concurrent runs would do the same work
    // twice and could race on saveUser write-through. 10 min TTL —
    // this is a forward-only migration; partial completion + retry
    // is safe (saveUser is idempotent on schema version).
    const lockToken = await acquireOperatorLock('migrate-schema', 600);
    if (!lockToken) {
      return NextResponse.json(
        { error: 'Schema migration already in progress.' },
        { status: 409, headers: CORS_HEADERS },
      );
    }

    const store = await getStore();

    // Pull the latest state — we want to re-stamp records that may have
    // been written by other Lambdas with different cached refs.
    await Promise.all([store.refreshUserIndex(), store.refreshOperator()]);

    const usersBefore = store.getAllUsers();
    const operatorBefore = store.getOperator();

    // Count records that need migration so we can return a meaningful
    // summary even when the operation is a no-op.
    let usersAtCurrentBefore = 0;
    let usersBehindBefore = 0;
    for (const u of usersBefore) {
      if (u.schemaVersion === CURRENT_SCHEMA_VERSION) usersAtCurrentBefore++;
      else usersBehindBefore++;
    }
    const operatorAtCurrentBefore = operatorBefore.schemaVersion === CURRENT_SCHEMA_VERSION;

    // Walk users — saveUser stamps schemaVersion = CURRENT_SCHEMA_VERSION
    // on every write. The store passes references, so this works on the
    // same in-memory objects the rest of the agent is using; if a play
    // session modifies a user during migration, the saveUser will
    // persist the latest state, not a stale snapshot.
    let usersMigrated = 0;
    for (const user of usersBefore) {
      try {
        store.saveUser(user);
        usersMigrated++;
      } catch (err) {
        console.warn(
          `[migrate-schema] Failed to re-save user ${user.userId}:`,
          err,
        );
      }
    }

    // Walk the operator — updateOperator with an identity transform
    // re-stamps the schemaVersion via the same write path.
    let operatorMigrated = false;
    try {
      store.updateOperator((s) => s);
      operatorMigrated = true;
    } catch (err) {
      console.warn('[migrate-schema] Failed to re-save operator:', err);
    }

    try {
      // Wait for any in-flight write-throughs to settle so the response
      // reflects the actual persisted state.
      await store.flush();

      return NextResponse.json(
        {
          currentVersion: CURRENT_SCHEMA_VERSION,
          usersTotal: usersBefore.length,
          usersAtCurrentBefore,
          usersBehindBefore,
          usersMigrated,
          operatorAtCurrentBefore,
          operatorMigrated,
        },
        { headers: CORS_HEADERS },
      );
    } finally {
      await releaseOperatorLock('migrate-schema', lockToken);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: message },
      { status: 500, headers: CORS_HEADERS },
    );
  }
});
