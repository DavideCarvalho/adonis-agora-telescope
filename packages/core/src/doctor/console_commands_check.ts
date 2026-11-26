import type { ApplicationService } from '@adonisjs/core/types';
import {
  appUnauthenticatedMessage,
  authkitUsable,
  type ConsoleKeyOutcome,
  type CryptoRuntimeLike,
  classifyConsoleKeyError,
  consoleKeyNote,
  consoleUnauthenticatedMessage,
  cryptoRuntimeOf,
  hasCryptoBinding,
  isForbidden,
  planAppAuth,
  planConsoleAuth,
} from '../federation/auto_crypto.js';
import {
  appKeyOf,
  CONSOLE_CRYPTO_KEY,
  consoleCommandKeys,
  consoleKeyId,
  DEFAULT_CONSOLE_PREFIX,
} from '../federation/console_commands.js';
import { resolveFederatedCommands } from '../federation/federation.js';
import type { AgoraDoctorCheck, AgoraDoctorResult } from './agora_doctor.js';

const DOCS = 'https://davidecarvalho.github.io/agora/docs/telescope/concepts/federated-console';
type AnyConfig = Record<string, unknown>;

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Encrypt then decrypt a probe with the console key, where the crypto server is embedded. */
async function probeEmbedded(
  runtime: CryptoRuntimeLike,
  partition: string,
): Promise<string | null> {
  const service = runtime.service;
  if (service === undefined) return null;
  if (!(await service.store.getKey(partition, CONSOLE_CRYPTO_KEY))) {
    return `the crypto key ${CONSOLE_CRYPTO_KEY} does not exist in partition "${partition}" yet (it is created when the web process starts)`;
  }
  const principal = {
    partition,
    capabilities: [`crypto:encrypt:${CONSOLE_CRYPTO_KEY}`, `crypto:decrypt:${CONSOLE_CRYPTO_KEY}`],
    actor: 'telescope:doctor',
  };
  const { ciphertext } = await service.encrypt(principal, {
    key: CONSOLE_CRYPTO_KEY,
    plaintext: 'agora-doctor',
    aad: 'agora-doctor',
  });
  const { plaintext } = await service.decrypt(principal, {
    key: CONSOLE_CRYPTO_KEY,
    ciphertext,
    aad: 'agora-doctor',
  });
  return plaintext === 'agora-doctor' ? null : 'the probe did not decrypt to what was encrypted';
}

/** The owning app's side: the modes it accepts and, in automatic crypto mode, its key. */
async function appSide(app: ApplicationService, deep: boolean): Promise<AgoraDoctorResult | null> {
  const telescope = app.config.get<AnyConfig | undefined>('telescope', undefined);
  const commands = telescope?.consoleCommands as AnyConfig | false | undefined;
  if (!commands || telescope?.enabled === false) return null;
  const container = (app as { container?: unknown }).container;
  const topology = telescope?.topology;
  const appKey = await appKeyOf(app);
  const plan = planAppAuth(commands, {
    keyId:
      appKey !== undefined
        ? consoleKeyId(
            consoleCommandKeys(
              appKey,
              (commands.prefix as string | undefined) ?? DEFAULT_CONSOLE_PREFIX,
            ).publicKey,
          )
        : undefined,
    cryptoBound: hasCryptoBinding(container),
    authkitBound: (await authkitUsable(container)).verifier,
    appKey: appKey !== undefined,
    // Defaults to the tenant partition, the app name or the prefix: never missing.
    appName:
      (commands.partition as string | undefined) ??
      (topology === 'tenant'
        ? (telescope?.tenant as { partition?: string } | undefined)?.partition
        : undefined) ??
      'default',
    controlPlaneVerifier: topology === 'control-plane',
  });
  if (plan.modes.length === 0) {
    if (deep) return null;
    return {
      status: 'error',
      // The boot error itself, so the doctor and boot say the same thing.
      message: appUnauthenticatedMessage(plan.notes),
      fix: 'Install @adonis-agora/crypto (automatic), or set consoleCommands.secret, or consoleCommands.verifyTenant with an APP_KEY.',
      docs: DOCS,
    };
  }
  // The boot log's own line (§11b): the same labels and sentence.
  const actions = (commands.actions ?? {}) as { replay?: boolean; queues?: boolean };
  const modes = `[@adonis-agora/telescope] console commands: ${plan.modes.join(' + ')}; ${
    actions.replay === true || actions.queues === true
      ? 'actions on'
      : 'actions off (set consoleCommands.actions.replay or consoleCommands.actions.queues to let the console act)'
  }`;
  if (!deep) {
    // §13e: with crypto active the token key is not published; crypto is enough.
    const note =
      plan.keys &&
      plan.modes.some((mode) => mode.startsWith('crypto (')) &&
      !plan.modes.some((mode) => mode.startsWith('token required ('))
        ? ". Crypto is enough here: this app does not publish its token key in authkit's key directory"
        : '';
    return { status: 'ok', message: `${modes}${note}` };
  }
  if (!plan.autoCrypto) return null;
  const runtime = await cryptoRuntimeOf(container);
  if (runtime === undefined) {
    return { status: 'warn', message: `${modes}. @adonis-agora/crypto did not resolve here.` };
  }
  try {
    if (runtime.service !== undefined) {
      const problem = await probeEmbedded(runtime, runtime.partition);
      return problem === null
        ? { status: 'ok', message: `${modes}. Key probe (encrypt + decrypt) passed.` }
        : { status: 'warn', message: `${modes}. ${problem}.`, docs: DOCS };
    }
    // A crypto tenant usually holds decrypt only: a dummy decrypt, classified like the boot check
    // (never getKey, which needs crypto:keys:read).
    let outcome: ConsoleKeyOutcome = 'usable';
    let detail: string | undefined;
    // §13f: `hasKey` when crypto has it (no audit noise). A refusal is "no permission"; any other
    // throw (an older crypto server without it) falls back to the dummy decrypt.
    let known: boolean | undefined;
    if (typeof runtime.operations.hasKey === 'function') {
      try {
        known = await runtime.operations.hasKey({ key: CONSOLE_CRYPTO_KEY });
        if (!known) outcome = 'missing';
      } catch (error) {
        if (isForbidden(error)) {
          outcome = 'refused';
          detail = messageOf(error);
          known = false;
        }
      }
    }
    if (known === undefined) {
      try {
        await runtime.operations.decrypt({
          key: CONSOLE_CRYPTO_KEY,
          ciphertext: `agora:ct1:${CONSOLE_CRYPTO_KEY}:1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
          aad: 'agora:console-key-check',
        });
      } catch (error) {
        outcome = classifyConsoleKeyError(error);
        detail = messageOf(error);
      }
    }
    if (outcome === 'usable') {
      return {
        status: 'ok',
        message: `${modes}. The key exists and this app may decrypt with it.`,
      };
    }
    const note = consoleKeyNote(runtime, outcome, CONSOLE_CRYPTO_KEY, detail);
    // Missing on a crypto tenant is fine: the crypto server provisions it on the console's first
    // seal (§2e). Refused and unreachable are real problems.
    if (outcome === 'missing') {
      return { status: 'ok', message: `${modes}. ${note?.line ?? ''}`.trim() };
    }
    return {
      status: outcome === 'unreachable' ? 'warn' : 'error',
      message: `${modes}. ${note?.line ?? ''}`.trim(),
      fix:
        outcome === 'refused'
          ? "An app needs no grant to decrypt its own console-* keys: check its crypto client's token, and that @adonis-agora/crypto on the crypto server is up to date."
          : 'Check the crypto server is up and reachable from this app.',
      docs: DOCS,
    };
  } catch (error) {
    return {
      status: 'error',
      message: `${modes}. The console key is not usable: ${messageOf(error)}`,
      docs: DOCS,
    };
  }
}

/** The console's side: per federated app with commands, how it sends and whether it can seal. */
async function consoleSide(app: ApplicationService, deep: boolean): Promise<AgoraDoctorResult[]> {
  const ui = app.config.get<AnyConfig | undefined>('telescope_ui', undefined);
  const federated = (ui?.apps as { federated?: Record<string, AnyConfig> } | undefined)?.federated;
  if (!federated || ui?.enabled === false) return [];
  const container = (app as { container?: unknown }).container;
  const results: AgoraDoctorResult[] = [];
  // `commands` is on by default: the same resolution boot uses.
  const resolved = resolveFederatedCommands(federated as Record<string, { commands?: never }>);
  for (const [id, entry] of Object.entries(federated)) {
    const commands = resolved[id]?.commands as AnyConfig | false | undefined;
    if (!commands) continue;
    const plan = planConsoleAuth(commands, {
      cryptoBound: hasCryptoBinding(container),
      authkitBound: (await authkitUsable(container)).tokens,
      partition: (entry.partition as string | undefined) ?? id,
      keyDirectory: (await authkitUsable(container)).directory,
    });
    if (plan === null) {
      if (deep) continue;
      results.push({
        status: 'error',
        message: consoleUnauthenticatedMessage(id, commands),
        fix: `Install @adonis-agora/crypto here, or set commands.secret, or commands.token with commands.publicKey; or commands: false to browse ${id} read-only.`,
        docs: DOCS,
      });
      continue;
    }
    const partition = (entry.partition as string | undefined) ?? id;
    const line = `[@adonis-agora/telescope] console commands to "${id}": ${plan.mode}`;
    if (!deep) {
      results.push({ status: 'ok', message: line });
      continue;
    }
    if (!plan.autoCrypto) continue;
    try {
      const runtime = await cryptoRuntimeOf(container);
      if (runtime === undefined) throw new Error('@adonis-agora/crypto did not resolve here');
      if (runtime.service !== undefined) {
        const problem = await probeEmbedded(runtime, partition);
        results.push(
          problem === null
            ? { status: 'ok', message: `${line}. Key probe passed.` }
            : { status: 'warn', message: `${line}. ${problem}.`, docs: DOCS },
        );
      } else {
        await runtime.operations.encrypt({
          key: CONSOLE_CRYPTO_KEY,
          plaintext: 'agora-doctor',
          aad: 'agora-doctor',
          partition,
        });
        results.push({ status: 'ok', message: `${line}. The crypto server seals for it.` });
      }
    } catch (error) {
      results.push({
        status: 'error',
        message: `${line}. Cannot seal: ${messageOf(error)}`,
        fix: "Grant this console's crypto client crypto:seal:console-* in authkit (and upgrade @adonis-agora/crypto on the crypto server), or set commands.crypto explicitly.",
        docs: DOCS,
      });
    }
  }
  return results;
}

async function run(app: ApplicationService, deep: boolean) {
  const own = await appSide(app, deep);
  const results = [...(own === null ? [] : [own]), ...(await consoleSide(app, deep))];
  return results.length > 0
    ? results
    : ({
        status: 'skip',
        message: deep
          ? 'No console key to probe (no automatic crypto mode on either side).'
          : 'No consoleCommands and no federated apps with commands.',
      } as const);
}

/** `telescope.console-commands`: the mode each side of the federated console resolves (what boot does). */
export const consoleCommandsDoctorCheck: AgoraDoctorCheck = {
  id: 'telescope.console-commands',
  lib: 'telescope',
  title: 'Federated console commands are authenticated',
  run: (app) => run(app, false),
};

/** `telescope.console-commands-key`: in crypto mode, the console key exists and this process can use it. */
export const consoleCommandsKeyDoctorCheck: AgoraDoctorCheck = {
  id: 'telescope.console-commands-key',
  lib: 'telescope',
  title: 'The console-telescope crypto key is usable',
  cost: 'deep',
  run: (app) => run(app, true),
};
