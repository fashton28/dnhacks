#!/usr/bin/env node
/* ============================================================================
 * eis-planner CLI — thin Node entrypoint for the Python e2e gate + demo
 * scripts. Prints exactly one JSON document to stdout on success.
 *
 *   node dist/cli.js verify <plan.json> <site.json> --context <runtime.json>
 *       -> contract Verification JSON (verdict inside; exit 0 even when the
 *          verdict is 'rejected' — a produced verdict is a success)
 *
 *   node dist/cli.js plan --task <task.json> <site.json> [--context <runtime.json>]
 *       -> contract MissionPlan JSON from the DETERMINISTIC planner, or
 *          {"infeasible": true, "reason": ..., "planTrace": [...]} when the rule
 *          table refuses the task. task.json is {task, anomaly} or a Task with
 *          an embedded `anomaly`.
 *
 *   node dist/cli.js plan --scripted <anomaly.json> <site.json> [--failing]
 *       -> contract MissionPlan JSON (ScriptedPlanner — the EIS_TEST_BAD_PLAN
 *          demo rail only; never touches the network)
 *
 *   node dist/cli.js triage --scripted <anomalies.json>
 *       -> ordered contract Task[] JSON from the deterministic ranking.
 *          anomalies.json is an Anomaly[] or {anomalies, fleet?, cueBudget?,
 *          mode?, normalcy?, zones?, rfEvents?, operatorNote?, now?}
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
import { Anomaly, Task } from './contract';
import { planMission } from './deterministic';
import { ScriptedPlanner } from './scripted';
import { loadSite } from './site';
import { TriageInput, scriptedTriage } from './triage';
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
  node dist/cli.js plan --task <task.json> <site.json> [--context <runtime.json>]
  node dist/cli.js plan --scripted <anomaly.json> <site.json> [--failing]
  node dist/cli.js triage --scripted <anomalies.json>
  node dist/cli.js report <input.json>`;

/** Pull `--flag <value>` out of an argv slice, returning the rest. */
function takeOption(args: string[], flag: string): { value?: string; rest: string[] } {
  const index = args.indexOf(flag);
  if (index === -1) return { rest: args };
  const value = args[index + 1];
  if (!value) throw new Error(`${flag} requires a file argument`);
  return { value, rest: args.slice(0, index).concat(args.slice(index + 2)) };
}

/** Validate a Task the way the wire contract describes it. */
function validateTask(data: unknown): Task {
  if (typeof data !== 'object' || data === null) throw new Error('invalid Task: must be an object');
  const d = data as Record<string, unknown>;
  const looks = ['person', 'vehicle', 'fence_gap', 'structure', 'unknown'];
  const urgencies = ['immediate', 'next_sortie', 'defer'];
  const sources = ['llm', 'operator', 'scripted'];
  if (typeof d.taskId !== 'string' || d.taskId === '') throw new Error('invalid Task: taskId must be a non-empty string');
  if (typeof d.anomalyId !== 'string' || d.anomalyId === '') throw new Error('invalid Task: anomalyId must be a non-empty string');
  if (typeof d.lookFor !== 'string' || !looks.includes(d.lookFor)) {
    throw new Error(`invalid Task: lookFor must be one of ${looks.join('|')}`);
  }
  if (typeof d.urgency !== 'string' || !urgencies.includes(d.urgency)) {
    throw new Error(`invalid Task: urgency must be one of ${urgencies.join('|')}`);
  }
  if (typeof d.priority !== 'number' || !Number.isFinite(d.priority) || d.priority < 0 || d.priority > 1) {
    throw new Error('invalid Task: priority must be a number in [0, 1]');
  }
  if (typeof d.question !== 'string' || typeof d.rationale !== 'string') {
    throw new Error('invalid Task: question and rationale must be strings');
  }
  const source = typeof d.source === 'string' && sources.includes(d.source) ? d.source : 'scripted';
  return {
    taskId: d.taskId, anomalyId: d.anomalyId, lookFor: d.lookFor as Task['lookFor'],
    question: d.question, urgency: d.urgency as Task['urgency'], priority: d.priority,
    rationale: d.rationale, source: source as Task['source'],
    ...(typeof d.assignedTo === 'string' ? { assignedTo: d.assignedTo } : {}),
  };
}

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
  if (args.includes('--task')) return cmdPlanTask(args);
  if (!args.includes('--scripted')) {
    throw new Error(`plan requires --task (deterministic) or --scripted (the EIS_TEST_BAD_PLAN demo rail)\n${USAGE}`);
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

/** The deterministic path: a task plus the cue it answers become a plan. */
function cmdPlanTask(args: string[]): void {
  const context = takeOption(args, '--context');
  const task = takeOption(context.rest, '--task');
  const positional = task.rest.filter((arg) => !arg.startsWith('--'));
  const sitePath = positional[0];
  if (!task.value || !sitePath) throw new Error(`plan --task requires <task.json> <site.json>\n${USAGE}`);
  const raw = readJson(task.value, 'task') as Record<string, unknown>;
  const parsedTask = validateTask(raw.task ?? raw);
  if (raw.anomaly === undefined) {
    throw new Error('plan --task requires an `anomaly` alongside the task (the cue carries the only coordinates)');
  }
  const anomaly: Anomaly = validateAnomaly(raw.anomaly);
  const site = loadSite(sitePath);
  const runtime = context.value
    ? readJson(context.value, 'runtime context') as VerificationContext : {};
  const result = planMission({
    task: parsedTask, anomaly, site,
    context: { anomaly, ...runtime },
    ...(typeof raw.requestId === 'string' ? { requestId: raw.requestId } : {}),
  });
  emit(result.infeasible
    ? { infeasible: true, reason: result.reason, planTrace: result.planTrace }
    : result.plan);
}

/** The deterministic ranking, without a model and without a network. */
function cmdTriage(args: string[]): void {
  if (!args.includes('--scripted')) {
    throw new Error(`triage supports only --scripted from the CLI (live triage is a host path)\n${USAGE}`);
  }
  const positional = args.filter((arg) => !arg.startsWith('--'));
  const [inputPath] = positional;
  if (!inputPath) throw new Error(`triage requires <anomalies.json>\n${USAGE}`);
  const raw = readJson(inputPath, 'triage input');
  const bundle = Array.isArray(raw) ? { anomalies: raw } : raw as Record<string, unknown>;
  const anomalies = (bundle.anomalies as unknown[] ?? []).map((entry) => validateAnomaly(entry));
  const input: TriageInput = {
    anomalies,
    fleet: (bundle.fleet as TriageInput['fleet']) ?? [],
    cueBudget: (bundle.cueBudget as TriageInput['cueBudget']) ?? { used: 0, cap: 2 },
    mode: bundle.mode === 'unattended' ? 'unattended' : 'attended',
    ...(bundle.normalcy ? { normalcy: bundle.normalcy as TriageInput['normalcy'] } : {}),
    ...(bundle.zones ? { zones: bundle.zones as TriageInput['zones'] } : {}),
    ...(bundle.rfEvents ? { rfEvents: bundle.rfEvents as TriageInput['rfEvents'] } : {}),
    ...(typeof bundle.operatorNote === 'string' ? { operatorNote: bundle.operatorNote } : {}),
    ...(typeof bundle.now === 'number' ? { now: bundle.now } : {}),
  };
  const result = scriptedTriage(input);
  emit({
    tasks: result.tasks, source: result.source,
    requiresOperator: result.requiresOperator,
    escalateWithoutFlying: result.escalateWithoutFlying,
  });
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
      case 'triage':
        cmdTriage(args);
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
