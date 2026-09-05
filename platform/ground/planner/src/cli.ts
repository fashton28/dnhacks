#!/usr/bin/env node
/* ============================================================================
 * eis-planner CLI — thin Node entrypoint for the Python e2e gate + demo
 * scripts. Prints exactly one JSON document to stdout on success.
 *
 *   node dist/cli.js verify <plan.json> <site.json> --context <runtime.json>
 *       -> contract Verification JSON (verdict inside; exit 0 even when the
 *          verdict is 'rejected' — a produced verdict is a success)
 *
 *   node dist/cli.js plan --scripted <anomaly.json> <site.json> [--failing]
 *       -> contract MissionPlan JSON (ScriptedPlanner; never touches the
 *          network — the live LLM path is not reachable from this CLI)
 *
 *   node dist/cli.js report <input.json>
 *       -> contract IncidentReport JSON. input.json shape:
 *          { "anomaly": Anomaly, "plan": MissionPlan,
 *            "observation": { "detected": bool, "confidence": 0..1,
 *                              "stagingTruth"?: string } }
 *
 * Exit codes: 0 whenever a JSON document was produced; non-zero (1) on bad
 * input (missing/invalid files, unknown command), with the error on stderr.
 * ========================================================================== */

import * as fs from 'fs';
import { ScriptedPlanner } from './scripted';
import { loadSite } from './site';
import { VerificationContext, verifyMission } from './verifier';
import { writeIncidentReport } from './report';
import { validateAnomaly, validateMissionPlan, validateObservation } from './validate';

function readJson(filePath: string, what: string): unknown {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`${what} file not readable: ${filePath} (${(err as Error).message})`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${what} file is not valid JSON: ${filePath} (${(err as Error).message})`);
  }
}

function emit(doc: unknown): void {
  process.stdout.write(JSON.stringify(doc, null, 2) + '\n');
}

const USAGE = `usage:
  node dist/cli.js verify <plan.json> <site.json> --context <runtime.json>
  node dist/cli.js plan --scripted <anomaly.json> <site.json> [--failing]
  node dist/cli.js report <input.json>`;

function cmdVerify(args: string[]): void {
  const contextIdx = args.indexOf('--context');
  let contextPath: string | undefined;
  if (contextIdx !== -1) {
    contextPath = args[contextIdx + 1];
    if (!contextPath) throw new Error('--context requires a file argument');
    args = args.slice(0, contextIdx).concat(args.slice(contextIdx + 2));
  }
  const [planPath, sitePath] = args;
  if (!planPath || !sitePath) throw new Error(`verify requires <plan.json> <site.json>\n${USAGE}`);

  const plan = validateMissionPlan(readJson(planPath, 'plan'));
  const site = loadSite(sitePath);
  const context = contextPath ? readJson(contextPath, 'runtime context') as VerificationContext : undefined;
  emit(verifyMission(plan, site, context));
}

function cmdPlan(args: string[]): void {
  if (!args.includes('--scripted')) {
    throw new Error(`plan supports only --scripted from the CLI (the live LLM planner is not a CLI path)\n${USAGE}`);
  }
  const failing = args.includes('--failing');
  const positional = args.filter((a) => a !== '--scripted' && a !== '--failing');
  const [anomalyPath, sitePath] = positional;
  if (!anomalyPath || !sitePath) {
    throw new Error(`plan requires <anomaly.json> <site.json>\n${USAGE}`);
  }
  const anomaly = validateAnomaly(readJson(anomalyPath, 'anomaly'));
  const site = loadSite(sitePath);
  emit(new ScriptedPlanner().plan(site, anomaly, { failing }));
}

function cmdReport(args: string[]): void {
  const [inputPath] = args;
  if (!inputPath) throw new Error(`report requires <input.json>\n${USAGE}`);
  const input = readJson(inputPath, 'report input') as Record<string, unknown>;
  const anomaly = validateAnomaly(input.anomaly);
  const plan = validateMissionPlan(input.plan);
  const observation = validateObservation(input.observation);
  emit(writeIncidentReport(anomaly, plan, observation));
}

function main(): void {
  const [command, ...args] = process.argv.slice(2);
  try {
    switch (command) {
      case 'verify':
        cmdVerify(args);
        break;
      case 'plan':
        cmdPlan(args);
        break;
      case 'report':
        cmdReport(args);
        break;
      default:
        throw new Error(`unknown command ${JSON.stringify(command ?? '')}\n${USAGE}`);
    }
  } catch (err) {
    process.stderr.write(`eis-planner: ${(err as Error).message}\n`);
    process.exit(1);
  }
}

main();
