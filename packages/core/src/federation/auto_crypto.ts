import {
  type AppCaller,
  type AppCallerVerifier,
  CONSOLE_CRYPTO_KEY,
  type ConsoleCipher,
  ConsoleCommandError,
  type ConsolePublicJwk,
  consolePublicJwk,
} from './console_commands.js';

/**
 * Zero configuration when the Agora libs are used together: console commands reuse what
 * `@adonis-agora/crypto` (the `'agora.crypto'` binding) and `@adonis-agora/authkit-client` (the
 * `'authkit.client'` binding, its calls between apps) already have configured, in this app or in
 * another one. Both are detected structurally, never imported: telescope depends on neither, and
 * every piece can be replaced with plain functions (`crypto: { cipher }`, `token`, `verifyTenant`).
 */

const PACKAGE = '@adonis-agora/telescope';
/** The container binding `@adonis-agora/crypto` publishes its runtime as. */
export const CRYPTO_BINDING = 'agora.crypto';
/** The container binding `@adonis-agora/authkit-client` publishes its client as. */
export const AUTHKIT_BINDING = 'authkit.client';
/** Who creates and uses the console key (crypto's audit log shows it). */
const ACTOR = 'telescope:console';

// ---------------------------------------------------------------------------------------------
// @adonis-agora/crypto
// ---------------------------------------------------------------------------------------------

/** The slice of `@adonis-agora/crypto`'s runtime console commands use. */
export interface CryptoRuntimeLike {
  topology: 'standalone' | 'control-plane' | 'tenant';
  /** This app's crypto partition (its app name on a server, its partition on a tenant). */
  partition: string;
  /** Present where the crypto server is embedded in this app (standalone, control plane). */
  service?: {
    encrypt(principal: CryptoPrincipalLike, input: CipherInput): Promise<{ ciphertext: string }>;
    decrypt(principal: CryptoPrincipalLike, input: DecipherInput): Promise<{ plaintext: string }>;
    createKey(
      principal: CryptoPrincipalLike,
      input: { name: string; type: 'aes256-gcm'; description?: string },
    ): Promise<unknown>;
    store: { getKey(partition: string, name: string): Promise<unknown> };
  };
  /** This app's own calls (its own partition): in-process on a server, over HTTP on a tenant. */
  operations: {
    /** `partition`: seal for another app's key (`crypto:seal:<key>`, encrypt only). */
    encrypt(input: CipherInput & { partition?: string }): Promise<{ ciphertext: string }>;
    decrypt(input: DecipherInput): Promise<{ plaintext: string }>;
    getKey?(name: string): Promise<unknown>;
    /**
     * Whether this app's key exists and it may use it (§13f): same auth as `decrypt` on its own
     * partition, not audited as an error, `false` when missing. Optional (older crypto): the
     * check falls back to a dummy decrypt.
     */
    hasKey?(input: { key: string }): Promise<boolean>;
    createKey?(input: { name: string; type: 'aes256-gcm'; description?: string }): Promise<unknown>;
  };
}

interface CryptoPrincipalLike {
  partition: string;
  capabilities: string[];
  actor: string;
}
interface CipherInput {
  key: string;
  plaintext: string;
  aad?: string;
  context?: string;
}
interface DecipherInput {
  key: string;
  ciphertext: string;
  aad?: string;
  context?: string;
}

interface ContainerLike {
  hasBinding?(binding: string): boolean;
  make(binding: string): Promise<unknown>;
}

function bound(container: unknown, binding: string): boolean {
  const c = container as ContainerLike | undefined;
  return typeof c?.hasBinding === 'function' && c.hasBinding(binding);
}

/** Whether `@adonis-agora/crypto` is registered in this app (cheap: no runtime is built). */
export function hasCryptoBinding(container: unknown): boolean {
  return bound(container, CRYPTO_BINDING);
}

/** The crypto runtime of this app, or `undefined` when `@adonis-agora/crypto` is not booted here. */
export async function cryptoRuntimeOf(container: unknown): Promise<CryptoRuntimeLike | undefined> {
  if (!hasCryptoBinding(container)) return undefined;
  const runtime = (await (container as ContainerLike).make(CRYPTO_BINDING)) as
    | CryptoRuntimeLike
    | undefined;
  if (
    runtime === null ||
    typeof runtime !== 'object' ||
    typeof runtime.partition !== 'string' ||
    typeof runtime.operations?.decrypt !== 'function'
  ) {
    return undefined;
  }
  return runtime;
}

const codeOf = (error: unknown): unknown => (error as { code?: unknown } | null)?.code;
const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Creates the console key in `partition` unless it exists (idempotent; a concurrent create that
 * lost the race is fine). Only where the crypto server is embedded (`runtime.service`).
 */
export async function ensureConsoleKey(
  runtime: CryptoRuntimeLike,
  partition: string,
  key: string = CONSOLE_CRYPTO_KEY,
): Promise<'created' | 'exists'> {
  const service = runtime.service;
  if (service === undefined) {
    throw new Error(
      `[${PACKAGE}] console commands: crypto is not embedded here, cannot create ${key}`,
    );
  }
  if (await service.store.getKey(partition, key)) return 'exists';
  try {
    await service.createKey(
      { partition, capabilities: [`crypto:keys:manage:${key}`], actor: ACTOR },
      { name: key, type: 'aes256-gcm', description: 'Federated telescope console commands' },
    );
    return 'created';
  } catch (error) {
    if (codeOf(error) === 'conflict' && (await service.store.getKey(partition, key))) {
      return 'exists';
    }
    throw error;
  }
}

/** Runs `ensure` once; a failure (crypto's database down at boot) is retried by the next call. */
export function once(ensure: () => Promise<unknown>): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => {
    pending ??= ensure().then(
      () => undefined,
      (error: unknown) => {
        pending = undefined;
        throw error;
      },
    );
    return pending;
  };
}

/** The line logged when the console key cannot be created where crypto is embedded. */
export function keyCreateFailedLine(partition: string, error: unknown, key = CONSOLE_CRYPTO_KEY) {
  return `[${PACKAGE}] console commands: could not create the crypto key "${key}" in partition ${partition} (${messageOf(error)}); run \`node ace crypto:keys:create ${key} --type aes256-gcm --application ${partition}\` (retried on the first command)`;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The operations slice the watched decrypt wraps. */
type CryptoOperationsLike = CryptoRuntimeLike['operations'];

/* ------------------------------------------------------------------------------------------- */
/* App side on a crypto tenant: is the console key there, and usable?                          */
/*                                                                                             */
/* Self-contained on purpose: every Agora lib ports this block as is (only PACKAGE and the     */
/* key default differ). Rules (SECURITY-UNIFORM-SPEC §10.7, §10.14):                           */
/* - ask `operations.hasKey({ key })` when crypto offers it (no audit noise); else probe with a */
/*   dummy decrypt, which an app may always do on its own console keys; never getKey (it needs */
/*   crypto:keys:read);                                                                        */
/* - only "not found" means missing: try to create it (servers with provisioning off), else     */
/*   one INFO line (the crypto server provisions console-* keys on the console's first seal);  */
/* - any other failure (forbidden, unauthenticated, server down) logs one WARN line: never     */
/*   silent, never a boot failure;                                                             */
/* - checked once at boot; after a warning, the next command's own decrypt is the retry (its  */
/*   error is classified the same way), so a command never makes two failing calls.          */
/* ------------------------------------------------------------------------------------------- */

/** What one decrypt failure says about the key. */
export type ConsoleKeyOutcome = 'missing' | 'usable' | 'refused' | 'unreachable';

/**
 * Classifies a decrypt error from @adonis-agora/crypto (its `CryptoError` / client error carry a
 * `code`; the message is the fallback for other clients). `usable`: the key exists and this app
 * may decrypt with it (only the dummy ciphertext was rejected).
 */
export function classifyConsoleKeyError(error: unknown): ConsoleKeyOutcome {
  const code = (error as { code?: unknown } | null)?.code;
  const text = errorText(error);
  if (code === 'not_found' || /no key named|not[ _]found/i.test(text)) return 'missing';
  if (code === 'invalid' || code === 'unreadable') return 'usable';
  if (
    code === 'forbidden' ||
    code === 'unauthenticated' ||
    /forbid|lacks|capabilit|denied|not allowed|unauthori[sz]ed|unauthenticated|\b40[13]\b/i.test(
      text,
    )
  ) {
    return 'refused';
  }
  if (
    /invalid|unreadable|malformed|ciphertext|unable to authenticate|auth(entication)? tag/i.test(
      text,
    )
  )
    return 'usable';
  return 'unreachable';
}

/** A `forbidden` refusal from crypto (its error code, or the message for other clients). */
export function isForbidden(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'forbidden' || /forbid/i.test(errorText(error));
}

/** The one line to log for `outcome`, or `undefined` when all is well. */
export function consoleKeyNote(
  runtime: Pick<CryptoRuntimeLike, 'partition'>,
  outcome: ConsoleKeyOutcome | 'created',
  key: string = CONSOLE_CRYPTO_KEY,
  detail?: string,
): { level: 'info' | 'warn'; line: string } | undefined {
  const where = `the crypto key "${key}" in partition ${runtime.partition}`;
  const create = `\`node ace crypto:keys:create ${key} --type aes256-gcm --application ${runtime.partition}\``;
  const why = detail ? ` (${detail})` : '';
  switch (outcome) {
    case 'usable':
      return undefined;
    case 'created':
      return { level: 'info', line: `[${PACKAGE}] console commands: created ${where}` };
    case 'missing':
      // Not a problem on a crypto tenant: the crypto server provisions `console-*` keys on the
      // console's first seal. Only a server with sealProvisioning off needs the command.
      return {
        level: 'info',
        line: `[${PACKAGE}] console commands: the crypto key "${key}" does not exist in partition ${runtime.partition} yet; the crypto server creates it on the console's first command (if it has sealProvisioning off: ${create.slice(1, -1)})`,
      };
    case 'refused':
      return {
        level: 'warn',
        line: `[${PACKAGE}] console commands: the crypto server refused this app on ${where}${why}; no grant is needed for an app's own console keys (crypto:decrypt:console-* is harmless if present): check this app's crypto token is valid and the crypto server is up to date`,
      };
    case 'unreachable':
      return {
        level: 'warn',
        line: `[${PACKAGE}] console commands: could not check ${where}${why}; is the crypto server up? Retried on the next command`,
      };
  }
}

/**
 * Checks the console key once (a dummy decrypt) and, when it is missing, tries to create it
 * through the channel crypto already configured (works with `crypto:keys:manage:console-*`).
 * Never throws: returns the line to log, or `undefined` when the key is there and usable.
 */
export async function checkTenantConsoleKey(
  runtime: CryptoRuntimeLike,
  key: string = CONSOLE_CRYPTO_KEY,
): Promise<{ level: 'info' | 'warn'; line: string } | undefined> {
  let outcome: ConsoleKeyOutcome;
  let detail: string | undefined;
  const hasKey = runtime.operations.hasKey;
  if (typeof hasKey === 'function') {
    // Newer crypto servers answer this directly: no decrypt, no error row in the audit. A
    // `forbidden` refusal is the "no permission" outcome; any other throw (an older server
    // without the route) falls back to the decrypt probe below.
    try {
      if (await hasKey.call(runtime.operations, { key })) return undefined;
      return createMissing(runtime, key);
    } catch (error) {
      if (isForbidden(error)) return consoleKeyNote(runtime, 'refused', key, errorText(error));
    }
  }
  try {
    await runtime.operations.decrypt({
      key,
      ciphertext: `agora:ct1:${key}:1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
      aad: 'agora:console-key-check',
    });
    return undefined; // a dummy that decrypts: cannot happen, but the key is clearly there
  } catch (error) {
    outcome = classifyConsoleKeyError(error);
    detail = errorText(error);
  }
  if (outcome !== 'missing') return consoleKeyNote(runtime, outcome, key, detail);
  return createMissing(runtime, key);
}

/** The key is missing: create it when this app may (servers with provisioning off), else say so. */
async function createMissing(
  runtime: CryptoRuntimeLike,
  key: string,
): Promise<{ level: 'info' | 'warn'; line: string } | undefined> {
  try {
    if (typeof runtime.operations.createKey !== 'function') throw new Error('no createKey');
    await runtime.operations.createKey({
      name: key,
      type: 'aes256-gcm',
      description: `${PACKAGE}: seals the federated console's commands to this app`,
    });
    return consoleKeyNote(runtime, 'created', key);
  } catch {
    return consoleKeyNote(runtime, 'missing', key);
  }
}

/**
 * The tenant's console key, watched: `atBoot()` runs {@link checkTenantConsoleKey} once;
 * `decrypt` wraps the app's own decrypt so that, while the last check warned, a command's failure
 * is classified and logged (one line, only when it changes) and its success clears the warning.
 * No extra crypto call per command.
 */
export function watchTenantConsoleKey(
  runtime: CryptoRuntimeLike,
  log: (note: { level: 'info' | 'warn'; line: string }) => void,
  key: string = CONSOLE_CRYPTO_KEY,
): { atBoot(): Promise<void>; decrypt: CryptoOperationsLike['decrypt'] } {
  let last: string | undefined;
  let healthy = false;
  const report = (note: { level: 'info' | 'warn'; line: string } | undefined) => {
    healthy = note === undefined || note.level === 'info';
    if (note && note.line !== last) log(note);
    last = note?.line;
  };
  const boot = once(async () => report(await checkTenantConsoleKey(runtime, key)));
  return {
    atBoot: () => boot().catch(() => undefined),
    decrypt: async (input) => {
      try {
        const result = await runtime.operations.decrypt(input);
        if (!healthy && input.key === key) report(undefined);
        return result;
      } catch (error) {
        if (input.key === key) {
          const outcome = classifyConsoleKeyError(error);
          // A command's ciphertext rejected for itself (tampered) says nothing about the key.
          if (outcome !== 'usable') report(consoleKeyNote(runtime, outcome, key, errorText(error)));
        }
        throw error;
      }
    },
  };
}

/** A cipher source: what `crypto.cipher` takes (resolved on each command). */
type CipherSource = () => Promise<ConsoleCipher>;

/**
 * App side: this app decrypts with its own crypto (its own partition). Where crypto is embedded
 * here, the key is created in this app's partition first: once, retried on the next command when
 * it failed.
 */
export function appConsoleCipher(
  runtime: CryptoRuntimeLike,
  /** A crypto tenant's watched decrypt ({@link watchTenantConsoleKey}). */
  decrypt?: CryptoOperationsLike['decrypt'],
): {
  cipher: CipherSource;
  ready: () => Promise<void>;
} {
  const service = runtime.service;
  const ready = service ? once(() => ensureConsoleKey(runtime, runtime.partition)) : async () => {};
  const cipher: ConsoleCipher = {
    encrypt: (input) => runtime.operations.encrypt(input),
    decrypt: decrypt ?? ((input) => runtime.operations.decrypt(input)),
  };
  return {
    ready,
    cipher: async () => {
      await ready();
      return cipher;
    },
  };
}

/**
 * Console side: encrypts for the federated app's partition with the console key, and nothing
 * else (it never decrypts). Crypto embedded in this console encrypts in-process, the key created
 * there first (once, retried on the next command when it failed); a console that is a crypto
 * tenant asks its crypto server to seal for that partition (`crypto:seal:console-*`).
 */
export function consoleSideCipher(
  runtime: CryptoRuntimeLike,
  partition: string,
  key: string = CONSOLE_CRYPTO_KEY,
  /** Called once when the key had to be created (the console logs it, §11b). */
  onCreated?: () => void,
): { cipher: CipherSource; ready: () => Promise<void> } {
  const service = runtime.service;
  const ready = service
    ? once(async () => {
        if ((await ensureConsoleKey(runtime, partition, key)) === 'created') onCreated?.();
      })
    : async () => {};
  const encrypt =
    service !== undefined
      ? (input: CipherInput) =>
          service.encrypt(
            { partition, capabilities: [`crypto:encrypt:${key}`], actor: ACTOR },
            input,
          )
      : async (input: CipherInput) => {
          try {
            return await runtime.operations.encrypt({ ...input, partition });
          } catch (error) {
            throw new Error(
              `[${PACKAGE}] console commands: the crypto server refused to seal with "${key}" for partition ${partition} (${messageOf(error)}): grant this app's crypto client crypto:seal:console-*, check the key exists there, or, if the crypto server predates cross-partition sealing, upgrade @adonis-agora/crypto on it or set apps.federated.<app>.commands.crypto explicitly`,
            );
          }
        };
  const cipher: ConsoleCipher = {
    encrypt,
    decrypt: async () => {
      throw new Error(`[${PACKAGE}] console commands: the console side never decrypts`);
    },
  };
  return {
    ready,
    cipher: async () => {
      await ready();
      return cipher;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// @adonis-agora/authkit-client (calls between apps)
// ---------------------------------------------------------------------------------------------

/** The slice of `@adonis-agora/authkit-client`'s client console commands use. */
export interface AuthkitClientLike {
  appCallTokens?():
    | { token(app: string): Promise<string>; reset?(app?: string): void }
    | undefined
    | null;
  appCallerVerifier?():
    | { verifyToken(token: string): Promise<AppCaller | null> }
    | undefined
    | null;
  /** authkit's key directory: publish this app's public key (never rejects; retried). */
  publishAppKey?(input: { purpose: string; jwk: ConsolePublicJwk }): Promise<void>;
  /** authkit's key directory: another app's public key for `purpose` (cached), or `null`. */
  appKey?(input: { app: string; purpose: string }): Promise<ConsolePublicJwk | null>;
}

/** The key directory purpose telescope's console key is published under. */
export const CONSOLE_KEY_PURPOSE = 'console:telescope';

/**
 * App side, token mode: publish this app's console public key in authkit's key directory, so a
 * console finds it without a copied `publicKey`. Never fails boot (authkit retries by itself).
 */
export async function publishConsoleKey(
  authkit: AuthkitClientLike | undefined,
  publicKey: string,
): Promise<boolean> {
  if (typeof authkit?.publishAppKey !== 'function') return false;
  try {
    await authkit.publishAppKey({ purpose: CONSOLE_KEY_PURPOSE, jwk: consolePublicJwk(publicKey) });
  } catch {
    // Documented never to reject; a failure here only means the console uses its explicit key.
  }
  return true;
}

/**
 * Console side, token mode without `commands.publicKey`: the app's console key from authkit's key
 * directory, looked up on each command (authkit caches it). `null` is an actionable error.
 */
export function directoryConsoleKey(
  authkit: AuthkitClientLike,
  app: string,
  entry: string,
): () => Promise<ConsolePublicJwk> {
  return async () => {
    const jwk = await (authkit.appKey as NonNullable<AuthkitClientLike['appKey']>)({
      app,
      purpose: CONSOLE_KEY_PURPOSE,
    });
    if (!jwk) {
      throw new Error(
        `[${PACKAGE}] ${entry}: the "${app}" app has no console key in authkit's key directory (purpose ${CONSOLE_KEY_PURPOSE}). It publishes it automatically at boot in token mode when it has authkit's \`service\` configured (and an APP_KEY); or set ${entry}.commands.publicKey (node ace telescope:console:key on that app prints it)`,
      );
    }
    return jwk;
  };
}

/** Whether `@adonis-agora/authkit-client` is registered in this app. */
export function hasAuthkitBinding(container: unknown): boolean {
  return bound(container, AUTHKIT_BINDING);
}

/** This app's authkit client, or `undefined` (also when it is bound but does not resolve). */
export async function authkitOf(container: unknown): Promise<AuthkitClientLike | undefined> {
  if (!hasAuthkitBinding(container)) return undefined;
  try {
    const client = (await (container as ContainerLike).make(AUTHKIT_BINDING)) as
      | AuthkitClientLike
      | undefined;
    return client !== null && typeof client === 'object' ? client : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What authkit's calls between apps actually provide here: an app-caller verifier (app side) and an
 * app-call token source (console side). A binding without them (calls between apps not
 * configured) provides neither, so the modes are decided on what is usable, not on the binding.
 */
export async function authkitUsable(
  container: unknown,
): Promise<{ verifier: boolean; tokens: boolean; directory: boolean }> {
  const authkit = await authkitOf(container);
  if (authkit === undefined) return { verifier: false, tokens: false, directory: false };
  let verifier = false;
  let tokens = false;
  try {
    verifier = appCallerVerifierOf(authkit) !== undefined;
  } catch {
    verifier = false;
  }
  try {
    tokens = appCallTokenSource(authkit, 'probe') !== undefined;
  } catch {
    tokens = false;
  }
  return { verifier, tokens, directory: typeof authkit.appKey === 'function' };
}

/** Console side: a token source for `app` from authkit's calls between apps, or `undefined`. */
export function appCallTokenSource(
  authkit: AuthkitClientLike | undefined,
  app: string,
): { get(): Promise<string>; reset(): void } | undefined {
  const tokens = authkit?.appCallTokens?.();
  if (!tokens || typeof tokens.token !== 'function') return undefined;
  return {
    get: () => tokens.token(app),
    reset: () => tokens.reset?.(app),
  };
}

/** App side: authkit's verifier of app-call tokens addressed to this app, or `undefined`. */
export function appCallerVerifierOf(
  authkit: AuthkitClientLike | undefined,
): AppCallerVerifier | undefined {
  const verifier = authkit?.appCallerVerifier?.();
  if (!verifier || typeof verifier.verifyToken !== 'function') return undefined;
  return (token) => verifier.verifyToken(token);
}

// ---------------------------------------------------------------------------------------------
// Which modes each side resolves (shared by the providers and `agora:doctor`)
// ---------------------------------------------------------------------------------------------

/** What the owning app's `consoleCommands` asks for, as far as authentication goes. */
export interface AppAuthInput {
  secret?: unknown;
  crypto?: { key?: string | undefined } | false | undefined;
  verifyTenant?: unknown;
}

/** How the owning app answers commands, once resolved. */
export interface AppAuthPlan {
  /** One label per accepted mode, for the boot log and the doctor. Empty: nothing resolves. */
  modes: string[];
  /** Automatic crypto mode: open with this app's own `@adonis-agora/crypto`. */
  autoCrypto: boolean;
  /** Check authkit app-call tokens (`consoleCommands.verifyTenant` unset, authkit present). */
  appCall: boolean;
  /** Token mode with the control plane's own `verifyTenant` (consoleCommands.verifyTenant unset). */
  fallbackVerifier: boolean;
  /** Accept commands sealed to this app's APP_KEY-derived key (a token verifier is set). */
  keys: boolean;
  /** Why automatic modes were off or blocked, for the boot error (§11 `Note:`). */
  notes: string[];
}

/** Where the console docs live (linked from the boot errors). */
export const CONSOLE_AUTH_DOCS =
  'https://davidecarvalho.github.io/agora/docs/telescope/concepts/federated-console#authenticating-the-console';

/** A console-commands configuration that cannot authenticate: thrown at boot (web process). */
export class ConsoleAuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConsoleAuthConfigError';
  }
}

const DOCTOR_HINT = "Run `node ace agora:doctor` to see every Agora lib's console auth at once.";

/** What else was found, after the uniform message (why the automatic modes did not apply). */
const notesOf = (notes: readonly string[]) => (notes.length ? ` Note: ${notes.join('; ')}.` : '');

/** The error an owning app with `consoleCommands` and no way to authenticate throws at boot. */
export const APP_UNAUTHENTICATED_MESSAGE = `[${PACKAGE}] consoleCommands needs authentication: install and boot @adonis-agora/crypto in this app (automatic, key ${CONSOLE_CRYPTO_KEY}), or configure authkit-client's \`service\` (automatic: the console uses an authkit app-call token; grant it telescope:console:* on this app), or set consoleCommands.secret (shared with the console), or consoleCommands.verifyTenant (your own verifier; needs an APP_KEY). ${DOCTOR_HINT} Docs: ${CONSOLE_AUTH_DOCS}`;

/** {@link APP_UNAUTHENTICATED_MESSAGE}, with why the automatic modes did not apply. */
export function appUnauthenticatedMessage(notes: readonly string[] = []): string {
  return `${APP_UNAUTHENTICATED_MESSAGE}${notesOf(notes)}`;
}

/**
 * The modes the owning app accepts. Explicit options are used as given; automatic crypto only when
 * none is set (and `crypto` is not `false`). With `verifyTenant` unset (not `false`), authkit's
 * app-call tokens are checked when authkit is here, and on a control plane its own `verifyTenant`
 * stands in (safe: every verb needs a console capability an ingest token lacks).
 */
export function planAppAuth(
  commands: AppAuthInput,
  context: {
    cryptoBound: boolean;
    authkitBound: boolean;
    appKey: boolean;
    appName: string | undefined;
    controlPlaneVerifier: boolean;
    /** The short id of the APP_KEY-derived console key, once derived (never the key itself). */
    keyId?: string | undefined;
  },
): AppAuthPlan {
  const modes: string[] = [];
  const explicitCrypto = commands.crypto !== undefined && commands.crypto !== false;
  const explicitVerify = commands.verifyTenant !== undefined && commands.verifyTenant !== false;
  const explicit = explicitCrypto || commands.secret !== undefined || explicitVerify;
  const autoCrypto = !explicit && commands.crypto !== false && context.cryptoBound;
  const appCall = commands.verifyTenant === undefined && context.authkitBound;
  const fallbackVerifier =
    commands.verifyTenant === undefined &&
    context.controlPlaneVerifier &&
    context.appName !== undefined;
  // §2c: only an explicit verifyTenant makes the token mandatory on crypto commands; a fallback
  // verifier checks a token when the console sends one. Labels: SECURITY-UNIFORM-SPEC §11.
  const sources = [
    ...(explicitVerify ? ['verifyTenant'] : []),
    ...(appCall ? ['authkit app-call, auto'] : []),
    ...(!explicitVerify && fallbackVerifier ? ["the control plane's verifyTenant"] : []),
  ];
  if (explicitCrypto || autoCrypto) {
    const key = explicitCrypto
      ? ((commands.crypto as { key?: string }).key ?? CONSOLE_CRYPTO_KEY)
      : CONSOLE_CRYPTO_KEY;
    modes.push(autoCrypto ? `crypto (auto, key ${key})` : `crypto (key ${key})`);
    if (explicitVerify) modes.push(`token required (${sources.join(', ')})`);
    else if (sources.length > 0) modes.push(`token checked when sent (${sources.join(', ')})`);
  }
  // Kept alongside crypto (explicit or automatic) whenever a verifier and an APP_KEY exist: the
  // migration path between token mode and crypto.
  const keys = context.appKey && (explicitVerify || appCall || fallbackVerifier);
  if (keys)
    modes.push(
      `token (${sources.join(', ')}; sealed to ${context.keyId ?? 'key (derived from APP_KEY)'})`,
    );
  if (commands.secret !== undefined) modes.push('secret');
  const notes = [
    ...(sources.length > 0 && !context.appKey
      ? [
          `a token verifier is available (${sources.join(', ')}), but token mode needs an APP_KEY (commands are sealed to a key derived from it)`,
        ]
      : []),
    ...(commands.crypto === false ? ['`crypto: false` turned the automatic crypto mode off'] : []),
  ];
  return { modes, autoCrypto, appCall, fallbackVerifier, keys, notes };
}

/** What one federated app's `commands` asks for, on the console side. */
export interface ConsoleAuthInput {
  secret?: unknown;
  token?: unknown;
  publicKey?: unknown;
  crypto?: { key?: string | undefined } | false | undefined;
}

/** How the console sends to one federated app. */
export interface ConsoleAuthPlan {
  mode: string;
  autoCrypto: boolean;
  /** Attach an authkit app-call token (no `token` set, authkit here, and the command is sealed). */
  autoToken: boolean;
  /** Seal to the app's key from authkit's key directory (token mode, no `publicKey`). */
  directoryKey?: boolean;
  /** §13a: token mode when the app publishes a directory key, else crypto, decided per command. */
  lazy?: boolean;
}

/** How long a lazy mode choice, or a failed app-call token, is kept before trying again. */
export const RECONSIDER_MS = 5 * 60_000;

/** The grant that lets the console attach an app-call token (§13b). */
const grantHint = (app: string) =>
  `To attach it: grant the console's service client telescope:console:* on "${app}" in authkit.`;

/**
 * Crypto mode (§13b): the app-call token is optional, so a token that cannot be minted (no grant,
 * \`invalid_target\`, authkit unreachable) never blocks a command. It is sent without one, the
 * failure is logged once (per reason), and minting is retried after {@link RECONSIDER_MS}.
 */
export function optionalAppCallToken(
  source: { get(): Promise<string>; reset(): void },
  app: string,
  /** Logs the §13b line; the error decides its level ({@link isMissingGrant}). */
  warn: (line: string, error: unknown) => void,
  now: () => number = Date.now,
): { get(): Promise<string>; reset(): void } {
  let retryAt = 0;
  const said = new Set<string>();
  return {
    async get() {
      if (now() < retryAt) return '';
      try {
        return await source.get();
      } catch (error) {
        retryAt = now() + RECONSIDER_MS;
        const reason = error instanceof Error ? error.message : String(error);
        if (!said.has(reason)) {
          said.add(reason);
          warn(withoutTokenLine(app, reason), error);
        }
        return '';
      }
    },
    reset: () => source.reset(),
  };
}

/** The code of a command that could not be sent because its app-call token could not be minted. */
export const APP_CALL_TOKEN_FAILED = 'app-call-token-failed';

/** An app-call token that could not be minted (token mode): `reason` is authkit's own. */
export class AppCallTokenError extends ConsoleCommandError {
  constructor(
    readonly reason: string,
    message: string,
    /** What authkit threw (its `code` tells a missing grant apart). */
    readonly source?: unknown,
  ) {
    super(message, APP_CALL_TOKEN_FAILED);
  }
}

/**
 * Whether a mint failure is only a missing grant (canonical, §13b): the code `invalid_target`, or
 * a message mentioning `invalid_target`, "not granted" or "no grant". Then the §13b line is `info` (crypto works fine
 * without the token); anything else (`unauthorized_client`, `invalid_client`, …) is `warn`.
 */
export function isMissingGrant(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'invalid_target') return true;
  const text = error instanceof Error ? error.message : String(error);
  return /invalid_target|not granted|no grant/i.test(text);
}

/** The §13b line: a command sent by crypto only, without the app-call token. */
export function withoutTokenLine(app: string, reason: string): string {
  return `[${PACKAGE}] console commands to "${app}": sending without an authkit app-call token (crypto only): ${reason}. ${grantHint(app)}`;
}

/** Token mode: the token is required, and a failure to mint it says which grant fixes it. */
export function requiredAppCallToken(
  source: { get(): Promise<string>; reset(): void },
  app: string,
): { get(): Promise<string>; reset(): void } {
  return {
    async get() {
      try {
        return await source.get();
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new AppCallTokenError(reason, `${reason}. ${grantHint(app)}`, error);
      }
    },
    reset: () => source.reset(),
  };
}

/** How the console sends to one federated app, or `null` when no mode resolves. */
export function planConsoleAuth(
  commands: ConsoleAuthInput,
  context: {
    cryptoBound: boolean;
    authkitBound: boolean;
    partition?: string;
    /** authkit's key directory can give the app's console key (no explicit `publicKey`). */
    keyDirectory?: boolean;
  },
): ConsoleAuthPlan | null {
  const explicitCrypto = commands.crypto !== undefined && commands.crypto !== false;
  const explicitToken = commands.token !== undefined && commands.token !== false;
  const explicit = explicitCrypto || explicitToken || commands.secret !== undefined;
  const autoCrypto = !explicit && commands.crypto !== false && context.cryptoBound;
  const sealedByCrypto = explicitCrypto || autoCrypto;
  // A token travels sealed: by crypto, or to the app's public key (given, or from authkit's key
  // directory). §17: no explicit token, not `token: false`, no secret; also with explicit crypto.
  const appKeyKnown = commands.publicKey !== undefined || context.keyDirectory === true;
  const autoToken =
    commands.token === undefined &&
    commands.secret === undefined &&
    context.authkitBound &&
    (sealedByCrypto || appKeyKnown);
  const token = explicitToken ? 'token' : autoToken ? 'token (authkit app-call, auto)' : undefined;
  // §13a: nothing explicit, crypto here and authkit's directory too: the app decides, per command
  // (cached): a key in the directory means it runs token mode, else crypto.
  if (
    autoCrypto &&
    autoToken &&
    commands.publicKey === undefined &&
    context.keyDirectory === true
  ) {
    const partition = context.partition !== undefined ? `, partition ${context.partition}` : '';
    return {
      mode: `auto (authkit key directory if the app publishes one, else crypto (auto, key ${CONSOLE_CRYPTO_KEY}${partition}))`,
      autoCrypto: true,
      autoToken: true,
      lazy: true,
    };
  }
  if (sealedByCrypto) {
    const key = explicitCrypto
      ? ((commands.crypto as { key?: string }).key ?? CONSOLE_CRYPTO_KEY)
      : CONSOLE_CRYPTO_KEY;
    const crypto = autoCrypto
      ? `crypto (auto, key ${key}${context.partition !== undefined ? `, partition ${context.partition}` : ''})`
      : `crypto (key ${key})`;
    return { mode: `${crypto}${token ? ` + ${token}` : ''}`, autoCrypto, autoToken };
  }
  if (token !== undefined && appKeyKnown) {
    return {
      // §11b: the token's source, then where the key comes from.
      mode:
        commands.publicKey !== undefined
          ? `token (${explicitToken ? 'commands.token' : 'authkit app-call, auto'}; sealed to the app's publicKey)`
          : `token (${explicitToken ? 'commands.token' : 'authkit app-call, auto'}, authkit key directory; sealed to the key the app publishes)`,
      autoCrypto: false,
      autoToken,
      directoryKey: commands.publicKey === undefined,
    };
  }
  if (commands.secret !== undefined && !explicitToken) {
    return { mode: 'secret', autoCrypto: false, autoToken: false };
  }
  return null;
}

/** The error a console with a federated app it cannot authenticate to throws at boot. */
export function consoleUnauthenticatedMessage(
  app: string,
  commands: ConsoleAuthInput = {},
): string {
  const entry = `apps.federated["${app}"]`;
  const notes = [
    ...(commands.crypto === false ? ['`crypto: false` turned the automatic crypto mode off'] : []),
    ...(commands.token === false ? ['`token: false` turned the automatic authkit token off'] : []),
    ...(commands.token !== undefined &&
    commands.token !== false &&
    commands.publicKey === undefined &&
    (commands.crypto === undefined || commands.crypto === false)
      ? [
          `${entry}.commands.token needs ${entry}.commands.publicKey, authkit's key directory or ${entry}.commands.crypto (a token always travels sealed)`,
        ]
      : []),
  ];
  return `[${PACKAGE}] ${entry}: commands to this app need authentication: boot @adonis-agora/crypto in this app (automatic), or set ${entry}.commands.secret, or ${entry}.commands.token — or commands: false to only browse it. ${DOCTOR_HINT}${notesOf(notes)}`;
}
