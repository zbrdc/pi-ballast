/**
 * Test-only module resolution.
 *
 * Production code imports siblings without an extension, which is what pi's
 * jiti loader expects. Bare Node ESM does not resolve those, so the tests
 * register a hook that retries with `.ts` before giving up. Nothing here
 * affects the shipped extension.
 */
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.startsWith(".") && !specifier.endsWith(".ts")) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});
