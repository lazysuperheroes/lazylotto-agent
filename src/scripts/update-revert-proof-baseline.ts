#!/usr/bin/env tsx
/**
 * R4-0: regenerate `src/__tests__/revert-proof-baseline.json` from
 * the current state of every test file. Use after tightening legacy
 * tests with `revert-proof:` comments to lock the improved discipline
 * into the baseline (running this also lowers the file's permitted
 * undocumented-block count).
 *
 * Usage:
 *   npm run revert-proof:update-baseline
 */

import { writeFileSync } from 'node:fs';
import {
  BASELINE_PATH,
  computeFileCounts,
} from '../__tests__/revert-proof-scan.js';

const counts = computeFileCounts();
const sortedKeys = Object.keys(counts).sort();
const fileCounts: Record<string, number> = {};
for (const k of sortedKeys) fileCounts[k] = counts[k]!;

const baseline = {
  version: 1,
  generatedAt: new Date().toISOString(),
  fileCounts,
};

writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n', 'utf8');
console.log(`Wrote ${BASELINE_PATH}`);
console.log(`Tracked ${sortedKeys.length} files with undocumented test blocks.`);
const total = Object.values(counts).reduce((a, b) => a + b, 0);
console.log(`Total undocumented blocks across the repo: ${total}`);
