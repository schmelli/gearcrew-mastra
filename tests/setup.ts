/**
 * Vitest setup file
 * Handles common test configuration and error suppression
 */

// Suppress the "PromiseRejectionHandledWarning" for tests that intentionally
// test promise rejection scenarios with fake timers
const originalWarn = console.warn;
console.warn = (...args: unknown[]) => {
  const message = args[0];
  if (typeof message === 'string' && message.includes('PromiseRejectionHandledWarning')) {
    return; // Suppress this specific warning
  }
  originalWarn.apply(console, args);
};

// Handle unhandled rejections gracefully in tests
process.on('unhandledRejection', () => {
  // Intentionally empty - let Vitest handle it but don't crash
});
