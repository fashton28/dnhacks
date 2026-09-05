/* Compile-time guard: the package's local Anomaly type must stay mutually
 * assignable with the FROZEN authoritative contract type. Runs under
 * `npm run typecheck` (tsc includes test/) — vitest itself does not typecheck,
 * so the runtime assertion below is just a keep-alive. */

import { describe, expect, it } from 'vitest';

import type { Anomaly as ContractAnomaly } from '../../ui/src/contract/index.ts';
import type { Anomaly as LocalAnomaly } from '../src/types.js';

// Mutual assignability — either line fails `tsc --noEmit` on drift.
const _localToContract: ContractAnomaly = {} as LocalAnomaly;
const _contractToLocal: LocalAnomaly = {} as ContractAnomaly;

describe('contract compatibility', () => {
  it('local Anomaly is structurally identical to the contract Anomaly', () => {
    // The real check is the type-level assignability above.
    expect(_localToContract).toBeDefined();
    expect(_contractToLocal).toBeDefined();
  });
});
