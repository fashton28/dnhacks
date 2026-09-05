/* Ambient declarations needed to typecheck eis-planner sources (imported
 * directly from ../planner/src) inside the UI's browser-targeted program
 * without pulling in @types/node. `process` is only *referenced* by the
 * planner's env-reading helpers, which the renderer never calls. */

declare const process: {
  cwd(): string;
  env: Record<string, string | undefined>;
};
