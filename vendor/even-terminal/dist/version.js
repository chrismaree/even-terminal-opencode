// PORT ADDITION (Deno/JSR). Upstream read these from package.json at runtime via
// readFileSync(__dirname/../package.json) — fragile once published to JSR (no
// package.json in the module graph, cache-layout dependent). Centralized here so
// the published package is self-contained.
//
// VERSION is the upstream even-terminal app version this port is at parity with
// (shown in the banner / `--version` / the client compatibility surface).
// PACKAGE_NAME stays the UPSTREAM npm name so /api/update-check reports when Even
// Realities ships a newer even-terminal worth re-porting.
export const VERSION = "0.8.1";
export const PACKAGE_NAME = "@evenrealities/even-terminal";
