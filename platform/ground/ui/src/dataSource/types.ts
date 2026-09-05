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
  CapabilitiesMessage,
  DataSource,
  EnvelopeMessage,
  EscalationMessage,
  FleetMessage,
  HealthEventMessage,
  IncidentReportMessage,
  MissionPlanMessage,
  ModeMessage,
  ObservationMessage,
  ReadinessMessage,
  RfEventMessage,
  SimulationToggles,
  SpectrumMessage,
  TaskMessage,
  Unsubscribe,
  VerificationMessage,
} from '@/contract';

export interface MissionDataSource extends DataSource {
  readonly kind: 'mock' | 'live' | 'hub';
  onAnomaly(cb: (m: AnomalyMessage) => void): Unsubscribe;
  onMissionPlan(cb: (m: MissionPlanMessage) => void): Unsubscribe;
  onVerification(cb: (m: VerificationMessage) => void): Unsubscribe;
  onIncidentReport(cb: (m: IncidentReportMessage) => void): Unsubscribe;
  onObservation(cb: (m: ObservationMessage) => void): Unsubscribe;
  onCapabilities(cb: (m: CapabilitiesMessage) => void): Unsubscribe;
  onReadiness(cb: (m: ReadinessMessage) => void): Unsubscribe;
  onHealthEvent(cb: (m: HealthEventMessage) => void): Unsubscribe;
  onRfEvent(cb: (m: RfEventMessage) => void): Unsubscribe;
  onSpectrum(cb: (m: SpectrumMessage) => void): Unsubscribe;
  onFleet(cb: (m: FleetMessage) => void): Unsubscribe;
  setSimulationToggles?(next: Partial<SimulationToggles>): void;
  getSimulationToggles?(): Readonly<SimulationToggles>;
  /** Passive receive-only RF events may be forwarded to the companion. */
  forwardRfEvent?(event: RfEventMessage): void;

  /** Tasking: what to look for and why (never where/how high — see Task). */
  onTask(cb: (m: TaskMessage) => void): Unsubscribe;
  /** Envelope monitor: margin to the nearest hard limit, and what was done. */
  onEnvelope(cb: (m: EnvelopeMessage) => void): Unsubscribe;
  /** Attendance mode (attended | unattended) and operator presence. */
  onMode(cb: (m: ModeMessage) => void): Unsubscribe;
  /** Out-of-band escalations raised for a mission. */
  onEscalation(cb: (m: EscalationMessage) => void): Unsubscribe;

  /* ---- Offline demo rails (MockDataProvider only) ----------------------- */
  /** Re-run triage, carrying the operator's note into the next task set. */
  runTriage?(note: string): void;
  /**
   * Operator moved a cue's location on the map. The provider RE-PLANS from
   * the moved cue through the real planner + verifier; the UI never edits a
   * plan itself. Used by the "drag the target into the switchyard" beat.
   */
  moveAnomaly?(anomalyId: string, lat: number, lon: number): void;
  /** Fire one scripted failure/authority scenario (see DemoScenario). */
  runScenario?(name: DemoScenario): void;
  /** Human label for the scenario's current availability, for the demo panel. */
  scenarioHint?(name: DemoScenario): string;
}

/** The offline demo beats Phase 3 drives from the simulation panel. */
export type DemoScenario =
  | 'gust'
  | 'operatorAbsent'
  | 'unattendedInEnvelope'
  | 'unattendedOutOfEnvelope'
  | 'handoff';

/**
 * Multi-vehicle providers (ARGUS Hub, and the offline mock's two-vehicle
 * fleet) publish a fleet list and let the dashboard follow one vehicle.
 * Beyond the frozen contract on purpose — the wire `fleet` message is what
 * crosses the seam; this is the ground station's selection state.
 */
export interface FleetCapable {
  onFleetRows(cb: (rows: FleetRow[]) => void): () => void;
  setVehicle(id: string): void;
  getVehicle(): string;
}

/** One row of a provider's fleet list (mirrors HubDataProvider.FleetEntry). */
export interface FleetRow {
  vehicleId: string;
  status: string;
  batteryPct: number;
  altM: number;
  mode: string;
}

export function fleetCapable(ds: unknown): ds is FleetCapable {
  const candidate = ds as FleetCapable | null;
  return !!candidate &&
    typeof candidate.onFleetRows === 'function' &&
    typeof candidate.setVehicle === 'function' &&
    typeof candidate.getVehicle === 'function';
}
