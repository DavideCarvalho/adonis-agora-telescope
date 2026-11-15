import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { TracerProvider } from '@opentelemetry/sdk-trace';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setOtelTraceIdReader } from '../../src/context_accessor.js';
import { readActiveOtelSpan, readActiveOtelTraceId } from '../../src/otel/global_emitter.js';
import { resolvePropagation } from '../../src/tracing/config.js';
import { installPropagation } from '../../src/tracing/index.js';
import { newTraceScope, runInTraceScope, setOtelSpanReader } from '../../src/tracing/scope.js';

/**
 * The app also runs OpenTelemetry (`@adonisjs/otel`): its undici instrumentation injects
 * `traceparent` on every `fetch`. Telescope must leave propagation to it, so a call carries one
 * `traceparent`, OTel's, never two.
 */

let server: Server;
let url: string;
let stop: () => void;
// Built after telescope installs: an instrumentation enables (subscribes) in its constructor.
let instrumentation: UndiciInstrumentation;

beforeAll(async () => {
  // Telescope subscribes FIRST: OTel's undici hook then runs after it, and adds its header
  // whatever is there. Only telescope stepping aside keeps it to one.
  stop = installPropagation(resolvePropagation({ targets: [/^http:\/\/127\.0\.0\.1:/] }), true);
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  instrumentation = new UndiciInstrumentation();
  const provider = new TracerProvider();
  trace.setGlobalTracerProvider(provider);
  instrumentation.setTracerProvider(provider);
  instrumentation.enable();
  setOtelTraceIdReader(readActiveOtelTraceId);
  setOtelSpanReader(readActiveOtelSpan);

  server = createServer((req, res) => {
    const values: string[] = [];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      if (req.rawHeaders[i]?.toLowerCase() === 'traceparent')
        values.push(req.rawHeaders[i + 1] as string);
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(values));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  stop();
  instrumentation.disable();
  setOtelTraceIdReader(null);
  setOtelSpanReader(null);
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function received(): Promise<string[]> {
  return (await (await fetch(url)).json()) as string[];
}

describe('next to OpenTelemetry', () => {
  it('a call inside an OTel span carries exactly one traceparent, OTel’s', async () => {
    const tracer = trace.getTracer('test');
    const { values, traceId } = await tracer.startActiveSpan('request', async (span) => {
      const result = { values: await received(), traceId: span.spanContext().traceId };
      span.end();
      return result;
    });
    expect(values).toHaveLength(1);
    expect(values[0]).toContain(traceId);
  });

  it('a call in a telescope scope still carries only OTel’s header', async () => {
    const values = await runInTraceScope(newTraceScope(), () => received());
    expect(values).toHaveLength(1);
  });
});
