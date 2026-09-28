/**
 * Which offline tests a develop PR runs locally. `vitest --changed` follows the import graph, which
 * cannot see a dependency bump or a build/test config edit, so those escalate to the full suite.
 */

/** Files whose change can break any test without any test importing them. */
const FULL_RUN = [
  /^package\.json$/,
  /^package-lock\.json$/,
  /^npm-shrinkwrap\.json$/,
  /^tsconfig[^/]*\.json$/,
  /^relay\/tsconfig[^/]*\.json$/,
  // vitest.config.ts, vitest.relay.config.ts, vite.config.web.ts, electron.vite.config.ts
  /^(?:electron\.)?vite(?:st)?(?:\.[\w-]+)*\.config(?:\.[\w-]+)*\.[cm]?[jt]s$/
];

/** @param {string[]} files repo-relative, forward-slash paths changed since the base */
export function fullRunReason(files) {
  return files.map((file) => file.replace(/\\/g, '/')).find((file) => FULL_RUN.some((pattern) => pattern.test(file)));
}
