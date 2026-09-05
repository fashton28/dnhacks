#!/usr/bin/env node
/* ============================================================================
 * verifier_fixtures/run_fixtures.mjs
 *
 * Runs every V*.json case against the REAL deterministic verifier — the
 * compiled `ground/planner/dist/verifier.js`, the same module the planner CLI,
 * the Electron host and the SITL gate call. There is no second implementation
 * of the checks here: the reference behaviour IS that verifier, and these
 * fixtures are its executable specification.
 *
 *   node verifier_fixtures/run_fixtures.mjs            # all cases
 *   node verifier_fixtures/run_fixtures.mjs V10 V23    # named cases
 *   node verifier_fixtures/run_fixtures.mjs --json V10 # dump the Verification
 *
 * Exit code 0 when every case matches its `expected` block, 1 otherwise.
 * Requires a built planner: `cd ground/planner && npm run build`.
 * `ground/planner/test/verifier-fixtures.test.ts` runs the same cases against
 * the TypeScript sources under vitest.
 * ========================================================================== */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLANNER = path.resolve(HERE, '../ground/planner');

const require = createRequire(path.join(PLANNER, 'package.json'));
let validateSite, verifyMission, CHECK_ORDER;
try {
  ({ validateSite } = require('./dist/site.js'));
  ({ verifyMission, CHECK_ORDER } = require('./dist/verifier.js'));
} catch (err) {
  process.stderr.write(
    `verifier_fixtures: cannot load the planner verifier from ${PLANNER}/dist\n` +
    `  ${err.message}\n  build it first: cd ground/planner && npm run build\n`);
  process.exit(1);
}

const readJson = (file) => JSON.parse(fs.readFileSync(path.join(HERE, file), 'utf8'));

/* Context assembly — see baseline_context.json `_fixture`. A case `telemetry`
 * block is merged over the baseline, one level deep for these four keys so a
 * case can change one battery or sensor field without restating a healthy
 * vehicle; every other key is replaced outright. */
const DEEP_MERGED = ['battery', 'readiness', 'sensors', 'anomaly'];
function buildContext(baseline, telemetry = {}) {
  const context = { ...baseline };
  delete context._fixture;
  for (const [key, value] of Object.entries(telemetry)) {
    context[key] = DEEP_MERGED.includes(key) && value && typeof value === 'object' && !Array.isArray(value)
      ? { ...(context[key] ?? {}), ...value }
      : value;
  }
  return context;
}

/** The site a case verifies against. `siteOverride` patches the VALIDATED
 * model, so a case can present geometry the loader would have refused and
 * prove the verifier re-checks the invariant itself. */
function siteFor(fixture) {
  const loaded = validateSite(readJson(fixture.site));
  return fixture.siteOverride ? { ...loaded, ...fixture.siteOverride } : loaded;
}

/** Compare one Verification against a case `expected` block. Returns failures. */
function checkCase(fixture, result, reverify) {
  const problems = [];
  const expected = fixture.expected;
  const names = result.checks.map((check) => check.name);
  if (String(names) !== String(CHECK_ORDER)) {
    problems.push(`check order is ${names.join(',')}, expected ${[...CHECK_ORDER].join(',')}`);
  }
  if (result.verdict !== expected.verdict) {
    problems.push(`verdict ${result.verdict}, expected ${expected.verdict}`);
  }
  if (result.requestId !== fixture.plan.requestId && result.requestId !== 'invalid') {
    problems.push(`requestId ${result.requestId} does not correlate with the plan`);
  }
  const failing = result.checks.filter((check) => !check.ok).map((check) => check.name);
  if (String(failing) !== String(expected.failingChecks)) {
    problems.push(`failing checks [${failing}], expected [${expected.failingChecks}]`);
  }
  const edited = result.checks.filter((check) => check.edit).map((check) => check.name);
  if (expected.editedChecks && String(edited) !== String(expected.editedChecks)) {
    problems.push(`edited checks [${edited}], expected [${expected.editedChecks}]`);
  }
  for (const [name, fragments] of Object.entries(expected.reasonContains ?? {})) {
    const reason = result.checks.find((check) => check.name === name)?.reason ?? '';
    for (const fragment of fragments) {
      if (!reason.includes(fragment)) problems.push(`${name} reason lacks ${JSON.stringify(fragment)}: ${reason}`);
    }
  }
  for (const [name, fragments] of Object.entries(expected.editContains ?? {})) {
    const edit = result.checks.find((check) => check.name === name)?.edit ?? '';
    for (const fragment of fragments) {
      if (!edit.includes(fragment)) problems.push(`${name} edit lacks ${JSON.stringify(fragment)}: ${edit}`);
    }
  }
  // Universal invariant: a corrected plan is released only if it is itself
  // clean, so re-verifying it must pass with no further edits.
  if (result.verdict === 'corrected') {
    if (!result.correctedPlan) problems.push('corrected verdict without a correctedPlan');
    else if (reverify.verdict !== 'pass') {
      const bad = reverify.checks.filter((check) => !check.ok).map((check) => check.name);
      problems.push(`corrected plan re-verifies as ${reverify.verdict} (failing [${bad}]), expected pass`);
    }
  } else if (result.correctedPlan) {
    problems.push(`${result.verdict} verdict must not carry a correctedPlan`);
  }
  return problems;
}

const args = process.argv.slice(2);
const dumpJson = args.includes('--json');
const wanted = args.filter((arg) => !arg.startsWith('--'));
const ids = fs.readdirSync(HERE).filter((file) => /^V\d\d\.json$/.test(file)).sort()
  .map((file) => file.replace('.json', ''))
  .filter((id) => wanted.length === 0 || wanted.includes(id));

if (!ids.length) {
  process.stderr.write(`verifier_fixtures: no cases matched ${wanted.join(', ')}\n`);
  process.exit(1);
}

const baseline = readJson('baseline_context.json');
let failed = 0;
for (const id of ids) {
  const fixture = readJson(`${id}.json`);
  const site = siteFor(fixture);
  const context = buildContext(baseline, fixture.telemetry);
  const result = verifyMission(fixture.plan, site, context);
  const reverify = result.correctedPlan
    ? verifyMission(result.correctedPlan, site, context)
    : { verdict: 'pass', checks: [] };
  if (dumpJson) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  const problems = checkCase(fixture, result, reverify);
  failed += problems.length ? 1 : 0;
  process.stdout.write(`${problems.length ? 'FAIL' : 'ok  '} ${id} ${fixture.scenario} -> ${result.verdict}\n`);
  for (const problem of problems) process.stdout.write(`       ${problem}\n`);
}
process.stdout.write(`\n${ids.length - failed}/${ids.length} fixtures matched the deterministic verifier\n`);
process.exit(failed ? 1 : 0);
