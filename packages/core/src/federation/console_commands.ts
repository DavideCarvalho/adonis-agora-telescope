import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { dedicatedConnection } from '../topology/transports/redis.js';
import {
  readToken,
  resetToken,
  resolveTenantVerifier,
  type TenantTokenSource,
  type TenantVerifierInput,
  type VerifiedTenant,
} from '../topology/verify.js';

/**
 * Console commands: the actions a console runs on an app whose entries it reads from that app's
 * own store (a federated app). The console publishes each command on the app's Redis; every
 * instance of the app that answers commands hears it, one claims it (`SET … NX`) and runs it, and
 * its reply comes back on a reply channel. Nothing is queued: a publish no instance hears fails at
 * once, and a reply that does not come in time is a timeout.
 *
 * Redis is not a trust boundary, so a channel neither sends nor answers commands without one of
 * three authentication modes (see {@link ConsoleChannelAuthOptions}): commands encrypted with an
 * `@adonis-agora/crypto` key, a token sealed to the app's key (derived from its `APP_KEY`), or a
 * secret both sides share. The same design as `@adonis-agora/config`'s federated console.
 */

/** This package's part of the channel names and key labels. */
const CONSOLE_TOPIC = 'telescope';
const PACKAGE = '@adonis-agora/telescope';

/** The Redis client commands travel through: an `@adonisjs/redis` connection or an `ioredis` client. */
export interface ConsoleRedisClient {
  call(command: string, ...args: Array<string | number>): Promise<unknown>;
}

/** The subscriber connection, duplicated from the client (Redis pub/sub takes a connection of its own). */
interface SubscriberConnection {
  subscribe(...channels: string[]): unknown;
  on(event: 'message', listener: (channel: string, message: string) => void): unknown;
  on(event: 'error', listener: (error: unknown) => void): unknown;
  disconnect(): void;
}

/** One command, as the owning app's handler gets it. */
export interface ConsoleCommand {
  id: string;
  verb: string;
  args: unknown[];
  /** Who asked, as the console says (for the owning app's log; never verified). */
  actor?: string;
  /**
   * What the viewer may do, as the console says. Only ever narrows: a missing list grants nothing
   * beyond what the channel's authentication (and the app's `actions`) already allow.
   */
  capabilities?: string[];
  /** When it was sent (ms since the epoch): a command over a minute old is refused. */
  ts?: number;
  /** Shared-secret mode: HMAC of the fields above (set by the channel). */
  mac?: string;
  /**
   * Token mode: who the owning app verified the console as (its token's partition and
   * capabilities). Set by the channel after verification, never taken from the wire.
   */
  verified?: Pick<VerifiedTenant, 'partition' | 'capabilities' | 'clientId'> & {
    /**
     * An authkit app-call token: its audience already binds it to this app, so `partition` is the
     * calling (console) app and the "partition must be this app" rule does not apply.
     */
    appCall?: boolean;
  };
}

/** What an authkit app-call verifier answers for a valid token (`appCallerVerifier().verifyToken`). */
export interface AppCaller {
  /** The calling app (the console). */
  app: string;
  /** What authkit granted the calling app on this app. */
  capabilities: string[];
  clientId?: string;
  expiresAt?: number;
}

/** Verifies an authkit app-call token addressed to this app; `null` refuses it. */
export type AppCallerVerifier = (token: string) => Promise<AppCaller | null>;

/** What the owning app answers: the HTTP status and body its own console handler produced. */
export type ConsoleCommandReply = (
  | { id: string; ok: true; status: number; body: unknown }
  | { id: string; ok: false; error: { message: string; code?: string; status?: number } }
) & { mac?: string };

/** The code of an error a command gets when no instance of the owning app answered. */
export const FEDERATED_APP_UNREACHABLE = 'federated-app-unreachable';
/** The channel has no authentication, or a command arrived without valid authentication. */
export const UNSIGNED_CHANNEL = 'federated-channel-unsigned';
/** A command without the viewer's capabilities is refused with this code (`403`). */
export const CAPABILITIES_REQUIRED = 'capabilities-required';
export const CAPABILITIES_REQUIRED_MESSAGE =
  "The console sent no capabilities for its viewer, so this app runs nothing for it; update the console's @adonis-agora/telescope.";
/** The owning app refused the console's token (the console drops its cached token). */
export const UNAUTHORIZED_CONSOLE = 'federated-console-unauthorized';

/** A command the owning app did not run (nobody listened, no answer in time, or it refused). */
export class ConsoleCommandError extends Error {
  readonly code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.name = 'ConsoleCommandError';
    this.code = code;
  }
}

/** Default Redis key prefix (the owning app's `consoleCommands.prefix`). */
export const DEFAULT_CONSOLE_PREFIX = 'telescope';
/** Default wait for a reply. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;
/**
 * How long a claim is kept (2 minutes, twice the freshness window): a replay inside the window
 * reuses the id and finds the claim; past it the command is stale anyway.
 */
export const CLAIM_TTL_MS = 120_000;
/** The most command ids one instance remembers having run (to tell its own replays apart). */
const RAN_IDS_LIMIT = 10_000;
/** How far a command's `ts` may be from this clock (and so how long a replay could live). */
const MAX_COMMAND_SKEW_MS = 60_000;

/** The channels and keys of one app's console commands. */
export function consoleChannels(prefix: string = DEFAULT_CONSOLE_PREFIX) {
  return {
    commands: `${prefix}:telescope-console`,
    replies: `${prefix}:telescope-console-reply`,
    claim: (id: string) => `${prefix}:telescope-console-claim:${id}`,
  };
}

// ---------------------------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------------------------

/** JSON with object keys sorted, after a JSON round trip (so both sides MAC the same bytes). */
function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .map((key) => [key, sort((v as Record<string, unknown>)[key])]),
      );
    }
    return v;
  };
  const json = JSON.stringify(value);
  return JSON.stringify(sort(json === undefined ? null : JSON.parse(json)));
}

function sameMac(expected: string, actual: unknown): boolean {
  if (typeof actual !== 'string') return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}

function fresh(ts: unknown): boolean {
  return typeof ts === 'number' && Math.abs(Date.now() - ts) <= MAX_COMMAND_SKEW_MS;
}

function replyFields(reply: ConsoleCommandReply): unknown[] {
  return [
    reply.id,
    reply.ok,
    reply.ok ? [reply.status, reply.body ?? null] : (reply as { error: unknown }).error,
  ];
}

/** A shared secret: a string, or a Secret-like object (`env.get('X')` in AdonisJS). */
export type ChannelSecret = string | { release(): string };

/** What one sent command needs from the channel's authentication. */
interface OutgoingMessage {
  wire: unknown;
  verifyReply(reply: ConsoleCommandReply): boolean;
}

/** A command that arrived, once its authentication is checked. */
interface IncomingMessage {
  id: string;
  /** The command to run, or `undefined` when it must be refused with `error`. */
  command?: ConsoleCommand;
  error?: { message: string; code: string; status: number };
  /**
   * The command opened, but its token was refused: answered with this error, after the verb and
   * the capabilities are checked (the uniform order: verb, capabilities, token, viewer, …).
   */
  refused?: { message: string; code: string; status: number };
  signReply(reply: ConsoleCommandReply): ConsoleCommandReply;
}

interface ChannelAuth {
  /** What the app logs this mode as when a command came in another (`secret`, `crypto`, `token`). */
  readonly mode?: string;
  wrap?(command: ConsoleCommand): Promise<OutgoingMessage>;
  /** `null`: not this mode's message. Throws: this mode's message, but not authentic. */
  unwrap?(wire: Record<string, unknown>): Promise<IncomingMessage | null>;
  unauthorized?(): void;
}

/**
 * A bounded set of ids, each kept `ttlMs`: past `limit` the oldest go first, so a flood of
 * commands cannot grow it without end.
 */
function recentIds(ttlMs: number, limit: number) {
  const ids = new Map<string, number>();
  const prune = (now: number) => {
    for (const [id, expires] of ids) {
      if (expires > now && ids.size <= limit) break;
      ids.delete(id);
    }
  };
  return {
    add(id: string) {
      const now = Date.now();
      ids.delete(id);
      ids.set(id, now + ttlMs);
      prune(now);
    },
    has(id: string) {
      const expires = ids.get(id);
      return expires !== undefined && expires > Date.now();
    },
  };
}

/** How a command on the wire says it is authenticated, for the "mode not accepted" reason. */
function wireMode(wire: Record<string, unknown>): string {
  if (typeof wire.mac === 'string') return 'secret';
  if (typeof wire.sealed === 'string') {
    return wire.sealed.startsWith('agora:pk1:') ? 'token' : 'crypto';
  }
  return 'unsigned';
}

/** Strips what only the channel may set (`verified`) and the transport fields. */
function plainFields(command: ConsoleCommand): ConsoleCommand {
  const { mac: _mac, ts: _ts, verified: _verified, ...fields } = command;
  return fields;
}

/**
 * Shared-secret mode: both sides hold the same secret, and every command and reply carries an
 * HMAC over its fields, bound to this channel's prefix.
 */
class SecretAuth implements ChannelAuth {
  readonly mode = 'secret';
  readonly #key: Buffer;
  constructor(secret: ChannelSecret, prefix: string) {
    const raw = typeof secret === 'string' ? secret : secret?.release?.();
    if (typeof raw !== 'string' || raw.length < 16) {
      throw new Error(
        `[${PACKAGE}] console commands: the shared secret must be at least 16 characters`,
      );
    }
    this.#key = createHmac('sha256', raw)
      .update(`agora:console-commands:${CONSOLE_TOPIC}:${prefix}`)
      .digest();
  }

  #mac(kind: 'command' | 'reply', fields: unknown): string {
    return createHmac('sha256', this.#key)
      .update(`${kind}\n${canonicalJson(fields)}`)
      .digest('base64url');
  }

  #commandFields(command: ConsoleCommand): unknown[] {
    return [
      command.id,
      command.verb,
      command.args ?? [],
      command.actor ?? null,
      command.capabilities ?? null,
      command.ts ?? null,
    ];
  }

  #signReply(reply: ConsoleCommandReply): ConsoleCommandReply {
    const { mac: _mac, ...rest } = reply;
    return { ...rest, mac: this.#mac('reply', replyFields(rest)) } as ConsoleCommandReply;
  }

  async wrap(command: ConsoleCommand): Promise<OutgoingMessage> {
    const stamped = { ...plainFields(command), ts: Date.now() };
    return {
      wire: { ...stamped, mac: this.#mac('command', this.#commandFields(stamped)) },
      verifyReply: (reply) => sameMac(this.#mac('reply', replyFields(reply)), reply.mac),
    };
  }

  async unwrap(wire: Record<string, unknown>): Promise<IncomingMessage | null> {
    if (typeof wire.mac !== 'string') return null;
    const command = wire as unknown as ConsoleCommand;
    if (typeof command.id !== 'string' || typeof command.verb !== 'string') return null;
    // Tampered or stale: not from the console that holds the secret. A replay inside the window
    // reuses the id, and the claim refuses it. The reasons are the uniform ones (§11b).
    if (!sameMac(this.#mac('command', this.#commandFields(command)), command.mac)) {
      throw new ConsoleCommandError('bad signature', UNSIGNED_CHANNEL);
    }
    if (!fresh(command.ts)) throw new ConsoleCommandError('stale', UNSIGNED_CHANNEL);
    return {
      id: command.id,
      command: plainFields(command),
      signReply: (reply) => this.#signReply(reply),
    };
  }
}

/**
 * How a sealed command is encrypted: to the app's command key derived from its `APP_KEY`, or with
 * a key of `@adonis-agora/crypto`. Either way only the owning app opens it, and the AAD binds it to
 * this channel and this command id.
 */
interface ConsoleSealer {
  /** Whether `sealed` is this sealer's ciphertext (so the app knows which one opens it). */
  owns(sealed: string): boolean;
  seal(plaintext: string, aad: string): Promise<string>;
  open(sealed: string, aad: string): Promise<string>;
}

/** The `encrypt`/`decrypt` pair `@adonis-agora/crypto` exposes (`crypto.client`, `serviceCipher`). */
export interface ConsoleCipher {
  encrypt(input: {
    key: string;
    plaintext: string;
    aad?: string;
    context?: string;
  }): Promise<{ ciphertext: string }>;
  decrypt(input: {
    key: string;
    ciphertext: string;
    aad?: string;
    context?: string;
  }): Promise<{ plaintext: string }>;
}

/**
 * A cipher, or a function returning one: `config/telescope.ts` is read before
 * `@adonis-agora/crypto` is ready, so `() => crypto.client!` (or `() => serviceCipher(crypto.service,
 * 'app')`) defers it to the first command.
 */
export type ConsoleCipherSource = ConsoleCipher | (() => ConsoleCipher | Promise<ConsoleCipher>);

/**
 * Sealed with a cipher: `@adonis-agora/crypto`'s, or any service with the same `encrypt`/`decrypt`
 * (AWS KMS, Vault transit, an HSM wrapper).
 */
export interface ConsoleCryptoOptions {
  cipher: ConsoleCipherSource;
  /** The key name. Default `console-telescope`. */
  key?: string | undefined;
  /**
   * Whether a ciphertext is this cipher's (so the app knows which mode opens a command). Default:
   * it starts with `agora:ct1:<key>:` (`@adonis-agora/crypto`'s format). Set it for a cipher of
   * your own whose ciphertext looks different.
   */
  owns?: ((ciphertext: string) => boolean) | undefined;
}

/** The `@adonis-agora/crypto` key console commands are sealed with, unless another is named. */
export const CONSOLE_CRYPTO_KEY = 'console-telescope';

/** Seals with an `@adonis-agora/crypto` key: whoever may `encrypt` with it sends, the app opens. */
function cryptoConsoleSealer(options: ConsoleCryptoOptions): ConsoleSealer {
  const key = options.key ?? CONSOLE_CRYPTO_KEY;
  const source = options.cipher;
  const cipher = async (): Promise<ConsoleCipher> => {
    const resolved = typeof source === 'function' ? await source() : source;
    if (
      !resolved ||
      typeof resolved.encrypt !== 'function' ||
      typeof resolved.decrypt !== 'function'
    ) {
      throw new Error(
        `[${PACKAGE}] console commands: \`crypto.cipher\` is not ready (is @adonis-agora/crypto booted?)`,
      );
    }
    return resolved;
  };
  return {
    // `agora:ct1:<key>:<version>:…`: only this key's ciphertext is taken as a crypto command (a
    // cipher of your own with another format says what it owns).
    owns: options.owns ?? ((sealed) => sealed.startsWith(`agora:ct1:${key}:`)),
    async seal(plaintext, aad) {
      const { ciphertext } = await (await cipher()).encrypt({ key, plaintext, aad, context: aad });
      return ciphertext;
    },
    async open(sealed, aad) {
      const { plaintext } = await (await cipher()).decrypt({
        key,
        ciphertext: sealed,
        aad,
        context: aad,
      });
      return plaintext;
    },
  };
}

/** An app's console-command key pair: the public half the console seals to, the private half. */
export interface ConsoleCommandKeys {
  /** `x25519:<base64url>`: what the console's `commands.publicKey` is set to. */
  publicKey: string;
  privateKey: KeyObject;
}

/** The DER prefix of a PKCS#8 X25519 private key, before its 32 raw bytes. */
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');

function rawPublic(key: KeyObject): Buffer {
  const x = key.export({ format: 'jwk' }).x;
  if (typeof x !== 'string') throw new Error('not an X25519 key');
  return Buffer.from(x, 'base64url');
}

/**
 * The app's console-command key pair, derived from its `APP_KEY` and the channel `prefix`: the same
 * `APP_KEY` always gives the same key, so every instance opens what the console sealed to it.
 */
export function consoleCommandKeys(
  appKey: string,
  prefix: string = DEFAULT_CONSOLE_PREFIX,
): ConsoleCommandKeys {
  if (typeof appKey !== 'string' || appKey.length < 16) {
    throw new Error(`[${PACKAGE}] console commands: the APP_KEY must be at least 16 characters`);
  }
  const seed = Buffer.from(
    hkdfSync('sha256', appKey, `agora:console-commands:${CONSOLE_TOPIC}`, prefix, 32),
  );
  const privateKey = createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  return {
    publicKey: `x25519:${rawPublic(createPublicKey(privateKey)).toString('base64url')}`,
    privateKey,
  };
}

/**
 * A short, stable id of a console public key (the first 8 hex of its SHA-256), for logs: never the
 * key material itself (§11).
 */
export function consoleKeyId(publicKey: string): string {
  return `key ${createHash('sha256').update(publicKey).digest('hex').slice(0, 8)}`;
}

/** A public X25519 JWK, as authkit's key directory serves it (never with its private `d`). */
export interface ConsolePublicJwk {
  kty: 'OKP';
  crv: 'X25519' | 'Ed25519';
  x: string;
  kid?: string;
  use?: string;
  alg?: string;
}

/** A console public key: `x25519:<base64url>` (`node ace telescope:console:key`) or its JWK. */
export type ConsolePublicKey = string | ConsolePublicJwk;

/**
 * Where the console takes an app's console public key from: the key itself, or a function that
 * looks it up (authkit's key directory), called on each command.
 */
export type ConsolePublicKeySource = ConsolePublicKey | (() => Promise<ConsolePublicKey>);

/** The JWK of a console public key, for authkit's key directory (public part only). */
export function consolePublicJwk(publicKey: string): ConsolePublicJwk {
  parseConsolePublicKey(publicKey);
  return {
    kty: 'OKP',
    crv: 'X25519',
    x: publicKey.trim().slice('x25519:'.length),
    kid: consoleKeyId(publicKey).slice('key '.length),
    use: 'enc',
  };
}

/**
 * Parses a `commands.publicKey`: `x25519:<base64url>` (as `telescope:console:key` prints it) or an
 * X25519 public JWK (as authkit's key directory serves it).
 */
export function parseConsolePublicKey(input: ConsolePublicKey): KeyObject {
  const value =
    input !== null &&
    typeof input === 'object' &&
    (input as ConsolePublicJwk).kty === 'OKP' &&
    (input as ConsolePublicJwk).crv === 'X25519' &&
    typeof (input as ConsolePublicJwk).x === 'string'
      ? `x25519:${(input as ConsolePublicJwk).x}`
      : input;
  const match =
    typeof value === 'string' ? /^x25519:([A-Za-z0-9_-]{43})$/.exec(value.trim()) : null;
  if (!match?.[1]) {
    throw new Error(
      `[${PACKAGE}] console commands: \`publicKey\` must be the app's console key, \`x25519:<43 characters>\` (node ace telescope:console:key on that app prints it)`,
    );
  }
  return createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: match[1] }, format: 'jwk' });
}

const SEAL_INFO = `agora:console-seal:${CONSOLE_TOPIC}`;

function sealKey(shared: Buffer, ephemeral: Buffer, recipient: Buffer): Buffer {
  return Buffer.from(
    hkdfSync('sha256', shared, Buffer.concat([ephemeral, recipient]), SEAL_INFO, 32),
  );
}

/** ECDH (X25519) with a one-off key, then AES-256-GCM: only the private key's holder opens it. */
function sealTo(recipient: KeyObject, plaintext: string, aad: string): string {
  const ephemeral = generateKeyPairSync('x25519');
  const epk = rawPublic(ephemeral.publicKey);
  const rpk = rawPublic(recipient);
  const key = sealKey(
    diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient }),
    epk,
    rpk,
  );
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `agora:pk1:${[epk, iv, body, cipher.getAuthTag()].map((part) => part.toString('base64url')).join('.')}`;
}

function openWith(privateKey: KeyObject, sealed: string, aad: string): string {
  const parts = sealed.slice('agora:pk1:'.length).split('.');
  if (parts.length !== 4) throw new Error('malformed sealed command');
  const [epk, iv, body, tag] = parts.map((part) => Buffer.from(part, 'base64url')) as [
    Buffer,
    Buffer,
    Buffer,
    Buffer,
  ];
  const ephemeral = createPublicKey({
    key: { kty: 'OKP', crv: 'X25519', x: epk.toString('base64url') },
    format: 'jwk',
  });
  const key = sealKey(
    diffieHellman({ privateKey, publicKey: ephemeral }),
    epk,
    rawPublic(createPublicKey(privateKey)),
  );
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

/** Seals to the app's X25519 command key: the console side (the key from its configuration). */
function appKeySealerTo(publicKey: ConsolePublicKeySource): ConsoleSealer {
  // A key given as is is checked now (a typo fails at once); a looked-up one on each command.
  const fixed = typeof publicKey === 'function' ? undefined : parseConsolePublicKey(publicKey);
  const recipient = async () =>
    fixed ?? parseConsolePublicKey(await (publicKey as () => Promise<ConsolePublicKey>)());
  return {
    owns: (sealed) => sealed.startsWith('agora:pk1:'),
    seal: async (plaintext, aad) => sealTo(await recipient(), plaintext, aad),
    open: async () => {
      throw new Error('the console side cannot open commands');
    },
  };
}

/** Opens with the app's X25519 command key pair (derived from its `APP_KEY`): the app side. */
function appKeySealer(keys: ConsoleCommandKeys): ConsoleSealer {
  return {
    owns: (sealed) => sealed.startsWith('agora:pk1:'),
    seal: async (plaintext, aad) => sealTo(createPublicKey(keys.privateKey), plaintext, aad),
    open: async (sealed, aad) => openWith(keys.privateKey, sealed, aad),
  };
}

/** The key that MACs the replies to one command: a secret only the console and the app know. */
function replyKey(secret: string, prefix: string, id: string): Buffer {
  return createHmac('sha256', Buffer.from(secret, 'base64url'))
    .update(`agora:console-reply:${CONSOLE_TOPIC}:${prefix}:${id}`)
    .digest();
}

function replyMac(key: Buffer, reply: ConsoleCommandReply): string {
  return createHmac('sha256', key)
    .update(`reply\n${canonicalJson(replyFields(reply))}`)
    .digest('base64url');
}

const commandAad = (prefix: string, id: string) =>
  JSON.stringify(['agora:console-command', CONSOLE_TOPIC, prefix, id]);

/**
 * Sealed mode (console side): the whole command, with the console's token when it has one, travels
 * sealed so only the owning app opens it. A Redis reader sees an id and ciphertext: no token to
 * lift and replay, no command to alter. The sealed payload also carries a one-off secret the app
 * MACs its answer with, so a forged answer (from someone who cannot open the command) is ignored.
 */
class SealedSenderAuth implements ChannelAuth {
  constructor(
    readonly sealer: ConsoleSealer,
    readonly token: TenantTokenSource | undefined,
    readonly prefix: string,
  ) {}

  async wrap(command: ConsoleCommand): Promise<OutgoingMessage> {
    const token = this.token === undefined ? undefined : await readToken(this.token);
    const secret = randomBytes(32).toString('base64url');
    const sealed = await this.sealer.seal(
      JSON.stringify({
        command: { ...plainFields(command), ts: Date.now() },
        ...(token !== undefined ? { token } : {}),
        replySecret: secret,
      }),
      commandAad(this.prefix, command.id),
    );
    const key = replyKey(secret, this.prefix, command.id);
    return {
      wire: { id: command.id, sealed },
      verifyReply: (reply) => sameMac(replyMac(key, reply), reply.mac),
    };
  }

  unauthorized(): void {
    if (this.token !== undefined) resetToken(this.token);
  }
}

/**
 * Sealed mode (owning app side): open, check freshness, and — when `verifyTenant` is set — verify
 * the token the command carries. With a token the console's app and capabilities come from it; a
 * command without one is accepted only when no `verifyTenant` is set (crypto mode: whoever may
 * encrypt with the key is the console, like a shared secret).
 */
class SealedReceiverAuth implements ChannelAuth {
  readonly #verifiers: TokenVerifier[];
  constructor(
    readonly sealer: ConsoleSealer,
    verifiers: TokenVerifier[],
    readonly prefix: string,
    /**
     * Whether a command without a token is refused. `false` (a fallback verifier on a crypto
     * channel): the key authenticates the console, and a token, when sent, must still pass and
     * then caps the command.
     */
    readonly tokenRequired: boolean = true,
    readonly mode: string = 'token',
  ) {
    this.#verifiers = verifiers;
  }

  /** The first verifier that accepts `token`, or `null`. */
  async #verify(token: string): Promise<NonNullable<ConsoleCommand['verified']> | null> {
    for (const verify of this.#verifiers) {
      try {
        const verified = await verify(token);
        if (verified) return verified;
      } catch {
        // A verifier that throws refuses; the next may still accept.
      }
    }
    return null;
  }

  async unwrap(wire: Record<string, unknown>): Promise<IncomingMessage | null> {
    if (typeof wire.sealed !== 'string' || typeof wire.id !== 'string') return null;
    if (!this.sealer.owns(wire.sealed)) return null;
    const id = wire.id;
    let payload: { command?: ConsoleCommand; token?: unknown; replySecret?: unknown };
    try {
      payload = JSON.parse(
        await this.sealer.open(wire.sealed, commandAad(this.prefix, id)),
      ) as typeof payload;
    } catch {
      throw new ConsoleCommandError("did not open with this app's key", UNSIGNED_CHANNEL);
    }
    const command = payload?.command;
    if (
      !command ||
      command.id !== id ||
      typeof command.verb !== 'string' ||
      typeof payload.replySecret !== 'string'
    ) {
      throw new ConsoleCommandError("did not open with this app's key", UNSIGNED_CHANNEL);
    }
    if (!fresh(command.ts)) throw new ConsoleCommandError('stale', UNSIGNED_CHANNEL);
    const key = replyKey(payload.replySecret, this.prefix, id);
    const signReply = (reply: ConsoleCommandReply): ConsoleCommandReply => {
      const { mac: _mac, ...rest } = reply;
      return { ...rest, mac: replyMac(key, rest as ConsoleCommandReply) } as ConsoleCommandReply;
    };
    const fields = plainFields(command);
    if (this.#verifiers.length === 0) return { id, signReply, command: fields };
    const hasToken = typeof payload.token === 'string' && payload.token !== '';
    if (!hasToken && !this.tokenRequired) return { id, signReply, command: fields };

    const verified = hasToken ? await this.#verify(payload.token as string) : null;
    if (!verified) {
      return {
        id,
        signReply,
        command: fields,
        refused: {
          message: `the console's token was refused by the "${this.prefix}" app`,
          code: UNAUTHORIZED_CONSOLE,
          status: 401,
        },
      };
    }
    return {
      id,
      signReply,
      command: { ...fields, verified },
    };
  }
}

/** One way the app checks a console's token: the verified console, or `null`. */
type TokenVerifier = (token: string) => Promise<NonNullable<ConsoleCommand['verified']> | null>;

/** A service-tenant verifier (`verifyTenant`): the token's partition must later be this app. */
function tenantTokenVerifier(input: TenantVerifierInput, app: string | undefined): TokenVerifier {
  const verify = resolveTenantVerifier(input);
  return async (token) => {
    const verified = await verify({ token, partition: app, tenant: app });
    return verified
      ? {
          partition: verified.partition,
          capabilities: verified.capabilities,
          ...(verified.clientId !== undefined ? { clientId: verified.clientId } : {}),
        }
      : null;
  };
}

/** An authkit app-call verifier: the audience binds the token to this app; the caller is the console. */
function appCallTokenVerifier(verify: AppCallerVerifier): TokenVerifier {
  return async (token) => {
    const caller = await verify(token);
    if (
      !caller ||
      typeof caller.app !== 'string' ||
      caller.app === '' ||
      !Array.isArray(caller.capabilities) ||
      (typeof caller.expiresAt === 'number' && caller.expiresAt <= Date.now())
    ) {
      return null;
    }
    return {
      partition: caller.app,
      capabilities: caller.capabilities.filter((c) => typeof c === 'string'),
      clientId: caller.clientId ?? caller.app,
      appCall: true,
    };
  };
}

/**
 * How one side of the channel authenticates. The console sends with one mode; the app accepts
 * every mode it has configured (so it can take the old and the new while its consoles move over).
 *
 * - `crypto` — commands encrypted with an `@adonis-agora/crypto` key (the console may encrypt with
 *   it, the app decrypt), optionally with a `token` the app checks with `verifyTenant`;
 * - `token` + `publicKey` (console) / `keys` + `verifyTenant` (app) — the token, with the whole
 *   command, sealed to the app's key derived from its `APP_KEY`;
 * - `secret` — the same value on both sides; every command and reply carries an HMAC.
 */
export interface ConsoleChannelAuthOptions {
  /** Shared-secret mode: the same value on the console and on the app (16+ characters). */
  secret?: ChannelSecret | undefined;
  /**
   * Sealed with `@adonis-agora/crypto`, both sides: the cipher and the key (`console-telescope` by
   * default). The console needs `encrypt` on it, the app `decrypt`.
   */
  crypto?: ConsoleCryptoOptions | undefined;
  /** Console side: the token each command carries (`authkitTenantToken(...)`). */
  token?: TenantTokenSource | undefined;
  /**
   * Console side, without `crypto`: the app's console public key (`x25519:…` or its JWK), or a
   * function looking it up (authkit's key directory).
   */
  publicKey?: ConsolePublicKeySource | undefined;
  /** App side, without `crypto`: this app's console key pair (from {@link consoleCommandKeys}). */
  keys?: ConsoleCommandKeys | undefined;
  /** App side: verifies the console's token (`authkitTenantVerifier(...)`). */
  verifyTenant?: TenantVerifierInput | undefined;
  /**
   * App side: the control plane's own verifier, used for tokens sealed to {@link keys} when
   * `verifyTenant` is not set. Never asked of `crypto` commands (an automatic crypto console sends
   * no token). Safe with ingest tokens: every verb needs a `telescope:console:*` capability.
   */
  fallbackVerifyTenant?: TenantVerifierInput | undefined;
  /**
   * App side: verifies an authkit app-call token (`authkit.client`'s `appCallerVerifier()`). Its
   * audience binds it to this app, so no partition rule; its capabilities cap the command.
   */
  verifyAppCaller?: AppCallerVerifier | undefined;
  /** App side, token mode: this app's partition, which a classic token's `partition` must be. */
  partition?: string | undefined;
}

function unsignedError(prefix: string): ConsoleCommandError {
  return new ConsoleCommandError(
    `the "${prefix}" ${CONSOLE_TOPIC} console channel has no authentication; use @adonis-agora/crypto (\`crypto\` on both sides), a token (\`token\` + \`publicKey\` on the console, \`verifyTenant\` on the app) or the same \`secret\` on both`,
    UNSIGNED_CHANNEL,
  );
}

/** How the console sends: crypto when configured, else a token sealed to the app's key, else the secret. */
function senderAuth(options: ConsoleChannelAuthOptions, prefix: string): ChannelAuth | undefined {
  const crypto = options.crypto ? cryptoConsoleSealer(options.crypto) : undefined;
  if (options.token !== undefined && !crypto && options.publicKey === undefined) {
    throw new ConsoleCommandError(
      `[${PACKAGE}] console commands: a \`token\` needs \`crypto\` or the app's \`publicKey\` (node ace telescope:console:key on that app prints it)`,
      UNSIGNED_CHANNEL,
    );
  }
  if (crypto) return new SealedSenderAuth(crypto, options.token, prefix);
  if (options.token !== undefined && options.publicKey !== undefined) {
    return new SealedSenderAuth(appKeySealerTo(options.publicKey), options.token, prefix);
  }
  return options.secret === undefined ? undefined : new SecretAuth(options.secret, prefix);
}

/** Every way the app accepts commands. Without crypto, sealed commands need a token check. */
function receiverAuths(options: ConsoleChannelAuthOptions, prefix: string): ChannelAuth[] {
  const receivers: ChannelAuth[] = [];
  const appCall =
    options.verifyAppCaller !== undefined ? [appCallTokenVerifier(options.verifyAppCaller)] : [];
  if (options.crypto) {
    // An explicit `verifyTenant`: every crypto command must also carry a valid token. Only
    // fallback verifiers (authkit app calls, the control plane's own): whoever may encrypt with
    // the key is the console, and a token it sends must pass and caps the command.
    if (options.verifyTenant !== undefined) {
      const verifiers = [tenantTokenVerifier(options.verifyTenant, options.partition), ...appCall];
      receivers.push(
        new SealedReceiverAuth(
          cryptoConsoleSealer(options.crypto),
          verifiers,
          prefix,
          true,
          'crypto',
        ),
      );
    } else {
      const verifiers = [
        ...appCall,
        ...(options.fallbackVerifyTenant !== undefined
          ? [tenantTokenVerifier(options.fallbackVerifyTenant, options.partition)]
          : []),
      ];
      receivers.push(
        new SealedReceiverAuth(
          cryptoConsoleSealer(options.crypto),
          verifiers,
          prefix,
          false,
          'crypto',
        ),
      );
    }
  }
  const tenant = options.verifyTenant ?? options.fallbackVerifyTenant;
  const keyVerifiers = [
    ...(tenant !== undefined ? [tenantTokenVerifier(tenant, options.partition)] : []),
    ...appCall,
  ];
  if (options.keys && keyVerifiers.length > 0) {
    receivers.push(new SealedReceiverAuth(appKeySealer(options.keys), keyVerifiers, prefix));
  }
  if (options.secret !== undefined) receivers.push(new SecretAuth(options.secret, prefix));
  return receivers;
}

// ---------------------------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------------------------

function subscriberOf(client: ConsoleRedisClient): SubscriberConnection {
  const connection = dedicatedConnection(client) as unknown as SubscriberConnection | null;
  if (connection === null) {
    throw new ConsoleCommandError(
      'console commands need a Redis client that can open a subscriber connection (an @adonisjs/redis connection or an ioredis client)',
    );
  }
  connection.on('error', () => {
    // ioredis reconnects by itself; an unhandled 'error' would crash the process.
  });
  return connection;
}

/**
 * The console's side: sends commands to one app and waits for the reply. The reply channel is
 * subscribed on the first send. Without one of the modes of {@link ConsoleChannelAuthOptions} it
 * refuses to send.
 */
export class ConsoleCommandSender {
  private readonly channels: ReturnType<typeof consoleChannels>;
  private readonly prefix: string;
  private readonly auth: ChannelAuth | undefined;
  private subscriber: SubscriberConnection | null = null;
  private subscribed: Promise<void> | null = null;
  private readonly pending = new Map<
    string,
    {
      verify: (reply: ConsoleCommandReply) => boolean;
      resolve: (reply: ConsoleCommandReply) => void;
      reject: (error: Error) => void;
    }
  >();

  constructor(
    private readonly client: ConsoleRedisClient,
    private readonly options: {
      app: string;
      prefix?: string;
      timeoutMs?: number;
    } & Pick<ConsoleChannelAuthOptions, 'secret' | 'crypto' | 'token' | 'publicKey'>,
  ) {
    this.prefix = options.prefix ?? DEFAULT_CONSOLE_PREFIX;
    this.channels = consoleChannels(this.prefix);
    this.auth = senderAuth(options, this.prefix);
  }

  /** Whether this sender can send commands (one of the authentication modes is configured). */
  get signed(): boolean {
    return this.auth !== undefined;
  }

  /**
   * Run `verb` on the app; resolves with its reply, rejects when it cannot be run there. `extra`
   * capabilities only narrow what the app lets this console do.
   */
  async send(
    verb: string,
    args: unknown[],
    actor?: string,
    extra: { capabilities?: string[] } = {},
  ): Promise<ConsoleCommandReply> {
    const auth = this.auth;
    if (auth?.wrap === undefined) throw unsignedError(this.prefix);
    const command: ConsoleCommand = {
      id: randomUUID(),
      verb,
      args,
      ...(actor !== undefined ? { actor } : {}),
      ...(extra.capabilities !== undefined ? { capabilities: [...extra.capabilities] } : {}),
    };
    let outgoing: OutgoingMessage;
    try {
      outgoing = await auth.wrap(command);
    } catch (error) {
      if (error instanceof ConsoleCommandError) throw error;
      throw new ConsoleCommandError(
        `could not prepare the console command for the "${this.options.app}" app: ${error instanceof Error ? error.message : String(error)}`,
        FEDERATED_APP_UNREACHABLE,
      );
    }
    await this.listen();
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    const reply = new Promise<ConsoleCommandReply>((resolve, reject) => {
      this.pending.set(command.id, { verify: outgoing.verifyReply, resolve, reject });
      timer = setTimeout(() => {
        this.pending.delete(command.id);
        reject(
          new ConsoleCommandError(
            `no instance of "${this.options.app}" answered within ${timeoutMs / 1000}s — the app may have refused the command (check its logs, or run \`node ace agora:doctor\` there)`,
            FEDERATED_APP_UNREACHABLE,
          ),
        );
      }, timeoutMs);
      timer.unref?.();
    });
    reply.catch(() => {});
    let receivers: unknown;
    try {
      receivers = await this.client.call(
        'PUBLISH',
        this.channels.commands,
        JSON.stringify(outgoing.wire),
      );
    } catch (error) {
      this.settle(command.id, timer);
      throw new ConsoleCommandError(
        `could not reach the "${this.options.app}" app: ${error instanceof Error ? error.message : String(error)}`,
        FEDERATED_APP_UNREACHABLE,
      );
    }
    if (Number(receivers) === 0) {
      this.settle(command.id, timer);
      throw new ConsoleCommandError(
        `no instance of the "${this.options.app}" app answers console commands (is \`consoleCommands\` set in its config/telescope.ts?)`,
        FEDERATED_APP_UNREACHABLE,
      );
    }
    try {
      const answer = await reply;
      if (!answer.ok && answer.error.code === UNAUTHORIZED_CONSOLE) auth.unauthorized?.();
      return answer;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Stop listening; commands still waiting for a reply fail at once. */
  close(): void {
    this.subscriber?.disconnect();
    this.subscriber = null;
    this.subscribed = null;
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const { reject } of waiting) {
      reject(
        new ConsoleCommandError(
          `stopped waiting for the "${this.options.app}" app`,
          FEDERATED_APP_UNREACHABLE,
        ),
      );
    }
  }

  private settle(id: string, timer: NodeJS.Timeout | undefined): void {
    this.pending.delete(id);
    if (timer) clearTimeout(timer);
  }

  private listen(): Promise<void> {
    if (this.subscribed === null) {
      const subscriber = subscriberOf(this.client);
      this.subscriber = subscriber;
      subscriber.on('message', (channel, message) => {
        if (channel !== this.channels.replies) return;
        const reply = parseReply(message);
        if (reply === null) return;
        const waiting = this.pending.get(reply.id);
        if (waiting === undefined) return;
        // A reply without this command's MAC is someone else's (or forged): wait for the real one.
        if (!waiting.verify(reply)) return;
        this.pending.delete(reply.id);
        const { mac: _mac, ...verified } = reply;
        waiting.resolve(verified as ConsoleCommandReply);
      });
      const attempt = Promise.resolve(subscriber.subscribe(this.channels.replies)).then(() => {});
      this.subscribed = attempt;
      attempt.catch(() => {
        if (this.subscribed === attempt) this.close();
      });
    }
    return this.subscribed;
  }
}

/** Runs one command on the owning app: the status and body of its own console handler. */
export type ConsoleCommandHandler = (
  command: ConsoleCommand,
) => Promise<{ status: number; body: unknown }>;

/**
 * The owning app's side: every instance listens; the one that claims a command runs it and
 * publishes the reply. Returns a function that stops listening. Throws when no authentication
 * mode is configured: an app with none answers nothing. A command that is not authentic is
 * dropped, unanswered, and reported to `onError`.
 */
export async function answerConsoleCommands(
  client: ConsoleRedisClient,
  handler: ConsoleCommandHandler,
  options: {
    prefix?: string;
    instanceId?: string;
    onError?: (message: string, error: unknown) => void;
    /** The verbs this app answers: an unknown one is refused before anything else. */
    verbs?: readonly string[];
  } & Pick<
    ConsoleChannelAuthOptions,
    | 'secret'
    | 'crypto'
    | 'keys'
    | 'verifyTenant'
    | 'fallbackVerifyTenant'
    | 'verifyAppCaller'
    | 'partition'
  > = {},
): Promise<() => void> {
  const prefix = options.prefix ?? DEFAULT_CONSOLE_PREFIX;
  const receivers = receiverAuths(options, prefix);
  if (receivers.length === 0) throw unsignedError(prefix);
  const channels = consoleChannels(prefix);
  const instance = options.instanceId ?? randomUUID();
  const subscriber = subscriberOf(client);
  /** The command ids this instance ran, for the claim TTL (bounded): what makes a replay. */
  const ran = recentIds(CLAIM_TTL_MS, RAN_IDS_LIMIT);
  /** A refusal the console is also answered about: reported with its uniform reason (§11b). */
  const report = (reason: string) => {
    try {
      options.onError?.(reason, new ConsoleCommandError(reason, UNSIGNED_CHANNEL));
    } catch {
      // Reporting never breaks answering.
    }
  };
  const onMessage = async (message: string) => {
    let wire: Record<string, unknown>;
    try {
      wire = JSON.parse(message) as Record<string, unknown>;
    } catch {
      throw new ConsoleCommandError('not JSON', UNSIGNED_CHANNEL);
    }
    if (wire === null || typeof wire !== 'object' || typeof wire.id !== 'string') {
      throw new ConsoleCommandError('no command id', UNSIGNED_CHANNEL);
    }
    let incoming: IncomingMessage | null = null;
    for (const receiver of receivers) {
      incoming = (await receiver.unwrap?.(wire)) ?? null;
      if (incoming) break;
    }
    if (!incoming) {
      const accepts = [...new Set(receivers.map((receiver) => receiver.mode ?? 'unknown'))];
      throw new ConsoleCommandError(
        `mode not accepted here (this app accepts: ${accepts.join(', ')}; the command came as ${wireMode(wire)})`,
        UNSIGNED_CHANNEL,
      );
    }
    // One instance runs (or refuses) it; a replay inside the freshness window reuses the id, and
    // the claim refuses it.
    const claimed = await client.call(
      'SET',
      channels.claim(incoming.id),
      instance,
      'PX',
      CLAIM_TTL_MS,
      'NX',
    );
    if (claimed === null || claimed === undefined) {
      // Losing a claim to another instance is the normal case (every instance hears every
      // command): silent. Only the instance that already ran this id calls it a replay (§11b).
      if (ran.has(incoming.id)) report('replayed');
      return;
    }
    ran.add(incoming.id);
    if (!incoming.command) {
      await client.call(
        'PUBLISH',
        channels.replies,
        JSON.stringify(incoming.signReply({ id: incoming.id, ok: false, error: incoming.error! })),
      );
      return;
    }
    const { actor, capabilities, ...command } = incoming.command;
    const publish = (reply: ConsoleCommandReply) =>
      client.call(
        'PUBLISH',
        channels.replies,
        JSON.stringify(
          incoming.signReply(JSON.parse(JSON.stringify(reply)) as ConsoleCommandReply),
        ),
      );
    // The uniform order: verb known, capabilities present, token, then the handler (viewer,
    // partition, actions).
    if (options.verbs !== undefined && !options.verbs.includes(command.verb)) {
      await publish({
        id: incoming.id,
        ok: false,
        error: {
          message: `this app does not answer the console command ${command.verb}`,
          code: 'unsupported-request',
        },
      });
      return;
    }
    if (!Array.isArray(capabilities)) {
      report(CAPABILITIES_REQUIRED);
      await publish({
        id: incoming.id,
        ok: true,
        status: 403,
        body: { error: CAPABILITIES_REQUIRED_MESSAGE, code: CAPABILITIES_REQUIRED },
      });
      return;
    }
    if (incoming.refused) {
      report('token refused');
      await publish({ id: incoming.id, ok: false, error: incoming.refused });
      return;
    }
    let reply: ConsoleCommandReply;
    try {
      const { status, body } = await handler({
        ...command,
        args: Array.isArray(command.args) ? command.args : [],
        ...(typeof actor === 'string' ? { actor } : {}),
        ...(Array.isArray(capabilities)
          ? { capabilities: capabilities.filter((c) => typeof c === 'string') }
          : {}),
      });
      reply = { id: incoming.id, ok: true, status, body };
    } catch (error) {
      reply = {
        id: incoming.id,
        ok: false,
        error: {
          message: error instanceof Error ? error.message : String(error),
          ...(error instanceof ConsoleCommandError && error.code !== undefined
            ? { code: error.code }
            : {}),
        },
      };
    }
    // Signed over its JSON form: what the console parses is what the MAC covers.
    const wireReply = JSON.parse(JSON.stringify(reply)) as ConsoleCommandReply;
    await client.call('PUBLISH', channels.replies, JSON.stringify(incoming.signReply(wireReply)));
  };
  subscriber.on('message', (channel, message) => {
    if (channel !== channels.commands) return;
    // Never crash on a bad message: every path ends here, and a throwing `onError` is contained.
    onMessage(typeof message === 'string' ? message : String(message)).catch((error) => {
      try {
        options.onError?.(error instanceof Error ? error.message : String(error), error);
      } catch {
        // The report itself failed: the message is dropped either way.
      }
    });
  });
  await subscriber.subscribe(channels.commands);
  return () => subscriber.disconnect();
}

/** A reply of either shape, or `null` (dropped like any other unreadable message). */
export function parseReply(message: string): ConsoleCommandReply | null {
  let value: unknown;
  try {
    value = JSON.parse(message);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object') return null;
  const reply = value as Record<string, unknown>;
  if (typeof reply.id !== 'string') return null;
  const mac = typeof reply.mac === 'string' ? { mac: reply.mac } : {};
  if (reply.ok === true && typeof reply.status === 'number') {
    return { id: reply.id, ok: true, status: reply.status, body: reply.body, ...mac };
  }
  const error = reply.error as Record<string, unknown> | null | undefined;
  if (reply.ok === false && typeof error?.message === 'string') {
    return {
      id: reply.id,
      ok: false,
      error: {
        message: error.message,
        ...(typeof error.code === 'string' ? { code: error.code } : {}),
        ...(typeof error.status === 'number' ? { status: error.status } : {}),
      },
      ...mac,
    };
  }
  return null;
}

/** The app's `APP_KEY` from `config.get('app.appKey')` (a string or an AdonisJS `Secret`). */
export function readAppKey(value: unknown): string | undefined {
  const raw =
    typeof value === 'string'
      ? value
      : value !== null &&
          typeof value === 'object' &&
          typeof (value as { release?: unknown }).release === 'function'
        ? (value as { release(): unknown }).release()
        : undefined;
  return typeof raw === 'string' && raw !== '' ? raw : undefined;
}

/** A usable key: a non-empty string, or a `Secret` whose `release()` is one. */
const present = (value: unknown): boolean => readAppKey(safeRelease(value)) !== undefined;

function safeRelease(value: unknown): unknown {
  if (typeof value === 'string') return value;
  try {
    return readAppKey(value);
  } catch {
    return undefined;
  }
}

/** A config value that may be an AdonisJS config provider (`{ resolver(app) }`), resolved. */
async function resolvedConfig(value: unknown, app: unknown): Promise<unknown> {
  if (value === null || typeof value !== 'object') return value;
  const resolver = (value as { resolver?: unknown }).resolver;
  if (typeof resolver !== 'function') return value;
  try {
    return await (resolver as (app: unknown) => unknown).call(value, app);
  } catch {
    return undefined;
  }
}

/** The first key of an encryption config entry, whatever its shape (`keys[0]`, `key`). */
function keyOfEntry(entry: unknown): unknown {
  if (entry === null || typeof entry !== 'object') return undefined;
  const { keys, key } = entry as { keys?: unknown; key?: unknown };
  if (Array.isArray(keys)) return keys.find((k) => present(k));
  return key;
}

/**
 * The key of `config/encryption.ts` (AdonisJS 7): the first key of its default entry
 * (`list[default]`, else the first entry), resolving the lazy config providers `defineConfig` and
 * `drivers.*` return. A flat `{ keys }` / `{ key }` config is read as is.
 */
async function encryptionKeyOf(app: unknown): Promise<unknown> {
  let raw: unknown;
  try {
    raw = (app as AppConfigLike)?.config?.get?.('encryption');
  } catch {
    return undefined;
  }
  const config = await resolvedConfig(raw, app);
  if (config === null || typeof config !== 'object') return undefined;
  const { list, default: name } = config as { list?: unknown; default?: unknown };
  if (list !== null && typeof list === 'object') {
    const entries = list as Record<string, unknown>;
    const chosen =
      typeof name === 'string' && Object.hasOwn(entries, name) ? name : Object.keys(entries)[0];
    return chosen === undefined
      ? undefined
      : keyOfEntry(await resolvedConfig(entries[chosen], app));
  }
  return keyOfEntry(config);
}

interface AppConfigLike {
  config?: { get?(key: string, fallback?: unknown): unknown };
}

/**
 * The app's `APP_KEY` (SECURITY-UNIFORM-SPEC §13c, identical in every lib): `config/app.ts`'s
 * `appKey`, else the default entry of `config/encryption.ts` (AdonisJS 7, its lazy providers
 * resolved), else the `APP_KEY` environment variable. A `Secret` or a string; a source that throws
 * counts as "no key here". Returned released (never logged).
 */
export async function appKeyOf(app: unknown): Promise<string | undefined> {
  let fromApp: unknown;
  try {
    fromApp = (app as AppConfigLike)?.config?.get?.('app.appKey');
  } catch {
    fromApp = undefined;
  }
  if (present(fromApp)) return safeRelease(fromApp) as string;
  const fromEncryption = await encryptionKeyOf(app);
  if (present(fromEncryption)) return safeRelease(fromEncryption) as string;
  const fromEnv = process.env.APP_KEY;
  return present(fromEnv) ? fromEnv : undefined;
}
