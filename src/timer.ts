/**
 * Timers that must not keep a Pi process alive. The Node 22.19 test runner ends a file when the
 * only remaining handles are unref'd, cancelling tests that are still awaiting those timers, so
 * under `node --test` the timer stays referenced.
 */
export function backgroundTimer(timer: NodeJS.Timeout): NodeJS.Timeout {
  if (process.env.NODE_TEST_CONTEXT === undefined) timer.unref?.();
  return timer;
}
