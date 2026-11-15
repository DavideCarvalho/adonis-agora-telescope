import { type BullmqTransportOptions, bullmqTransport } from './bullmq.js';
import { type DurableTransportOptions, durableTransport } from './durable.js';
import { type HttpTransportOptions, httpTransport } from './http.js';
import { type QueueTransportOptions, queueTransport } from './queue.js';
import { type RedisTransportOptions, redisTransport } from './redis.js';
import type { TelescopeTransport, TransportDriver } from './types.js';

/**
 * How a tenant's entries reach the control plane (`transport` in `config/telescope.ts`, the same
 * driver on both sides). Each driver loads its peer only when selected. Browser traffic (the
 * console, live tail, client errors) is always HTTP, whatever is chosen here.
 *
 * ```ts
 * import { defineConfig, transports } from '@adonis-agora/telescope'
 *
 * export default defineConfig({
 *   topology: 'tenant',
 *   transport: transports.queue({ connection: 'redis' }),
 *   tenant: { partition: 'shop', token: env.get('TELESCOPE_TOKEN') },
 * })
 * ```
 */
export const transports = {
  /** POST each batch to the control plane (the default when only `tenant.url` is set). */
  http: (options: HttpTransportOptions) => httpTransport(options),
  /** One `@adonisjs/queue` job per batch, on a connection from `config/queue.ts`. */
  queue: (options: QueueTransportOptions = {}) => queueTransport(options),
  /** One BullMQ job per batch (`bullmq` + `ioredis`). */
  bullmq: (options: BullmqTransportOptions) => bullmqTransport(options),
  /** One Redis stream message per batch, through `@adonisjs/redis`. */
  redis: (options: RedisTransportOptions = {}) => redisTransport(options),
  /** One `@adonis-agora/durable` step per batch, over a transport from `config/durable.ts`. */
  durable: (options: DurableTransportOptions = {}) => durableTransport(options),
};

const DRIVERS: readonly TransportDriver[] = ['http', 'queue', 'bullmq', 'redis', 'durable'];

/** Whether `value` is a transport built by {@link transports}. */
export function isTelescopeTransport(value: unknown): value is TelescopeTransport {
  if (value === null || typeof value !== 'object') return false;
  const t = value as Partial<TelescopeTransport>;
  return (
    DRIVERS.includes(t.driver as TransportDriver) &&
    typeof t.tenant === 'function' &&
    typeof t.controlPlane === 'function' &&
    typeof t.ping === 'function' &&
    typeof t.describe === 'function'
  );
}

export type { BullmqModule, BullmqTransportOptions } from './bullmq.js';
export { BullmqControlPlaneChannel, BullmqTenantChannel, bullmqTransport } from './bullmq.js';
export type {
  DurableTransportFactory,
  DurableTransportLike,
  DurableTransportOptions,
} from './durable.js';
export {
  DURABLE_STEP,
  DurableControlPlaneChannel,
  DurableTenantChannel,
} from './durable.js';
export type { HttpTransportOptions } from './http.js';
export { HttpTenantChannel } from './http.js';
export type { QueueAdapterLike, QueueJobData, QueueTransportOptions } from './queue.js';
export { QueueControlPlaneChannel, QueueTenantChannel } from './queue.js';
export type { RedisCallClient, RedisTransportOptions } from './redis.js';
export { RedisControlPlaneChannel, RedisTenantChannel } from './redis.js';
export type {
  ConsumeOutcome,
  ControlPlaneChannel,
  MessageHandler,
  OutgoingBatch,
  PushEnvelope,
  SendOutcome,
  TelescopeTransport,
  TenantChannel,
  TransportContext,
  TransportDriver,
} from './types.js';
export { ENVELOPE_VERSION, encodeEnvelope } from './types.js';
