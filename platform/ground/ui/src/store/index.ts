/* Store barrel — explicit surface for the settings, recorder and data-source
   modules; the mission store re-exports wholesale. */
export {
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY,
  SAFETY_ACTIONS,
  UNIT_SYSTEMS,
  MAP_TILE_SETS,
  PID_AXES,
  PID_GAIN_KEYS,
  normaliseSettings,
  bridgePersistence,
  storagePersistence,
  memoryPersistence,
  detectPersistence,
  createSettingsStore,
  settingsStore,
  useSettings,
} from './settings';
export type {
  SafetyAction,
  FailsafeConfig,
  PidAxisGains,
  PidGains,
  PidAxis,
  PidGainKey,
  UnitSystem,
  MapTileSet,
  AppSettings,
  SettingsPersistence,
  SettingsStore,
  SettingsStoreOptions,
} from './settings';

export { DataSourceProvider, useDataSource } from './DataSourceContext';
export type { DataSourceProviderProps } from './DataSourceContext';

export { recorder, createRecorder, toRecordedFrame, defaultRecordingId } from './recorder';
export type { RecordedFrame, RecordingMeta, RecordingSession, Recorder, RecorderOptions } from './recorder';

export * from './mission';
