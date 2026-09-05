/* ============================================================================
 * MissionDataSource — UI-side extension of the FROZEN contract DataSource.
 * ----------------------------------------------------------------------------
 * The contract file (src/contract/index.ts) already carries the mission wire
 * messages (AnomalyMessage / MissionPlanMessage / VerificationMessage /
 * IncidentReportMessage in InboundMessage) but its DataSource interface is
 * frozen. This extension adds the subscription channels for those messages,
 * following the existing onX/Unsubscribe idiom. Both providers implement it;
 * consumers get it from useDataSource().
 * ========================================================================== */
import type {
  AnomalyMessage,
  DataSource,
  EnvelopeMessage,
  EscalationMessage,
  IncidentReportMessage,
  MissionPlanMessage,
  ModeMessage,
  TaskMessage,
  Unsubscribe,
  VerificationMessage,
} from '@/contract';

export interface MissionDataSource extends DataSource {
  onAnomaly(cb: (m: AnomalyMessage) => void): Unsubscribe;
  onMissionPlan(cb: (m: MissionPlanMessage) => void): Unsubscribe;
  onVerification(cb: (m: VerificationMessage) => void): Unsubscribe;
  onIncidentReport(cb: (m: IncidentReportMessage) => void): Unsubscribe;

  /** Tasking: what to look for and why (never where/how high — see Task). */
  onTask(cb: (m: TaskMessage) => void): Unsubscribe;
  /** Envelope monitor: margin to the nearest hard limit, and what was done. */
  onEnvelope(cb: (m: EnvelopeMessage) => void): Unsubscribe;
  /** Attendance mode (attended | unattended) and operator presence. */
  onMode(cb: (m: ModeMessage) => void): Unsubscribe;
  /** Out-of-band escalations raised for a mission. */
  onEscalation(cb: (m: EscalationMessage) => void): Unsubscribe;
}
