/* ============================================================================
 * Browser stubs for the Node builtins ('fs', 'path') that eis-planner's
 * site.ts imports at module scope. The UI reuses the planner's PURE exports
 * (validateSite, verifyMission, geometry) and never calls the file-reading
 * ones (loadSite / loadSiteFromEnv / resolveSiteFile) in the renderer, so
 * these stubs exist only to make the import graph resolve cleanly in Vite
 * and tsc. Calling any of them throws a descriptive error.
 *
 * Wired via tsconfig `paths` + vite `resolve.alias` ('fs' / 'path' → here).
 * ========================================================================== */

function browserOnly(name: string): never {
  throw new Error(
    `eis-ui: Node builtin "${name}" is not available in the browser. ` +
    'Use the site provider (src/site) instead of eis-planner loadSite*() here.',
  );
}

export function readFileSync(_path: string, _encoding: string): string {
  return browserOnly('fs.readFileSync');
}

export function isAbsolute(_p: string): boolean {
  return browserOnly('path.isAbsolute');
}

export function resolve(..._segments: string[]): string {
  return browserOnly('path.resolve');
}
