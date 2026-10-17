#!/usr/bin/env node
// Runs after `npm install -g dietcode`. Refreshes managed config
// for any harness the user already set up, so updates pick up new keys (e.g.
// statusLine) and re-resolve hook paths after a Node-version change.
//
// Must never fail the install: a thrown error here would abort `npm install`.
// On a fresh install (no harness configured yet) this is a silent no-op —
// `dietcode setup` does first-time configuration.
import { loadMaintenanceConfig } from "../src/config.js";
import { reconcileAll } from "../src/reconcile.js";

// The same entry point backs the explicit dietcode-reconcile command.
const automatic = process.env.npm_lifecycle_event === "postinstall";

try {
  if (automatic && !loadMaintenanceConfig().autoReconcile) process.exit(0);
  const result = reconcileAll();
  const touched = Object.entries(result)
    .filter(([, v]) => v)
    .map(([k]) => k);
  if (touched.length > 0) {
    console.log(`dietcode: refreshed config for ${touched.join(", ")}`);
  }
} catch {
  // Never block the install.
}
