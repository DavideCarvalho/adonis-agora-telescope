import { fileURLToPath } from 'node:url';

/**
 * Absolute path to the published stubs directory, resolved from this compiled
 * module's location (`dist/stubs/main.js`). Passed to `codemods.makeUsingStub`.
 */
export const stubsRoot = fileURLToPath(new URL('./', import.meta.url));
