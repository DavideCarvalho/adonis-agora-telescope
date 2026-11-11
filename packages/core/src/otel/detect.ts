const API_GLOBAL = Symbol.for('opentelemetry.js.api.1');

/**
 * Whether an OpenTelemetry SDK registered a global tracer provider (`@adonisjs/otel` does it
 * in `otel.ts`, before the app boots). Reads the API's global registry slot directly, so the
 * provider learns there is nothing to route entries to without loading `@opentelemetry/api`.
 */
export function isGlobalOtelRegistered(): boolean {
  const registry = (globalThis as Record<symbol, unknown>)[API_GLOBAL] as
    | { trace?: unknown }
    | undefined;
  return registry?.trace !== undefined;
}
