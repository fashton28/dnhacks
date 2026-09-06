/* eis-planner — public API. Plain TypeScript, Node-runnable, zero Electron/DOM deps. */

export * from './contract';
export * from './geometry';
export * from './site';
export * from './verifier';
export * from './deterministic';
export * from './triage';
export * from './fleet';
export * from './escalation';
export * from './planner';
export * from './scripted';
export * from './report';
export * from './validate';
export * from './policy';
export * from './rf_adapter';
export * from './service';
export * from './hub_adapter';
// `GENESIS_HASH` is deliberately not re-exported here: `escalation.ts` already
// publishes the same constant (64 zeros) and two identical names would be an
// ambiguous re-export. Import it from `./security` directly when the companion
// mission-record chain is what you mean.
export {
  HASH_EXCLUDED_FIELDS, canonicalRecordJson, chainHash, recordHash, sha256Hex, stampRecordHash,
} from './security';
export {
  LlmClient,
  createLlmClient,
  describeEvidenceRef,
  llmEnabled,
  reportPayload,
  taskFromModel,
  triagePrompt,
  DEFAULT_LLM_MODEL,
  EVIDENCE_REF_MAX_CHARS,
  LLM_TRIAGE_ATTEMPTS,
  TASK_LIST_SCHEMA,
  TRIAGE_PROMPT_FILE,
  INCIDENT_REPORT_INPUT_SCHEMA,
} from './llm';
