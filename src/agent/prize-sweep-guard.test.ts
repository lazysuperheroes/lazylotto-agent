/**
 * F1 (2026-07-04 custodial audit): cross-user prize-sweep contamination
 * guard. In multi-user custodial mode every user shares ONE agent wallet
 * and `transferPendingPrizes(owner, MaxUint256)` is all-or-nothing — so
 * if the wallet holds MORE pending prizes than THIS session won, sweeping
 * would send a prior user's stranded prizes to the current player
 * (cross-tenant theft). `isPrizeSweepContaminated` is the boundary the
 * guard uses; LottoAgent.transferAllPrizes returns a `blocked` outcome
 * and MultiUserAgent dead-letters it (`prize_transfer_blocked_contamination`).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isPrizeSweepContaminated,
  shouldBlockContaminatedSweep,
} from './LottoAgent.js';

describe('F1: cross-user prize-sweep contamination guard', () => {
  // revert-proof: reverting to the pre-fix `expectedFromThisSession > 0 &&
  // pending > expected` gate makes this (won-nothing, prizes-present) case
  // return false → the sweep proceeds and STEALS the prior user's prizes.
  it('blocks the pure-theft case: won nothing but prizes are pending', () => {
    assert.equal(isPrizeSweepContaminated(2, 0), true);
  });

  // revert-proof: a `>=` instead of `>` here would block legitimate sweeps
  // of exactly this session's own prizes (equal counts), permanently
  // stranding every winner's prizes; this pins the boundary at `>`.
  it("allows sweeping exactly this session's prizes (pending == won)", () => {
    assert.equal(isPrizeSweepContaminated(2, 2), false);
  });

  // revert-proof: removing the guard entirely lets this contaminated wallet
  // (a prior user's 2 stranded + this session's 1 win = 3 pending) sweep all
  // 3 to the current player; the assertion catches the missing guard.
  it("blocks when a prior user's prizes inflate the pending count", () => {
    assert.equal(isPrizeSweepContaminated(3, 1), true);
  });

  // revert-proof: an always-block regression (e.g. `pending >= 0`) would
  // trip on an empty wallet and dead-letter every clean session; this pins
  // the no-false-positive floor.
  it('allows when nothing is pending', () => {
    assert.equal(isPrizeSweepContaminated(0, 0), false);
  });
});

describe('F-R3: contamination guard applies only to a shared custodial wallet', () => {
  // revert-proof: dropping the `sharedWallet` gate (reverting to a bare
  // isPrizeSweepContaminated call in transferAllPrizes) makes this
  // single-user case block — permanently stranding the SOLE owner's own
  // prizes after a transient transfer failure, which single-user mode has no
  // dead-letter/recovery path to clear. This pins the gate.
  it('does NOT block in single-user mode even when pending > this session', () => {
    assert.equal(shouldBlockContaminatedSweep(false, 3, 1), false);
  });

  // revert-proof: if the gate ever hard-coded false (disabling the guard for
  // everyone), this multi-user contaminated case would sweep a prior tenant's
  // stranded prizes to the current player — re-opening F1's cross-tenant
  // theft. This pins that the guard STAYS active on a shared wallet.
  it('blocks in multi-user (shared-wallet) mode when pending > this session', () => {
    assert.equal(shouldBlockContaminatedSweep(true, 3, 1), true);
  });

  // revert-proof: pins that a shared wallet with exactly this session's own
  // prizes is NOT blocked (the guard is `>` not `>=`, even with the gate on).
  it('allows a shared wallet to sweep exactly this session\'s prizes', () => {
    assert.equal(shouldBlockContaminatedSweep(true, 2, 2), false);
  });
});
