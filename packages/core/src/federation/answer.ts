import type { ConsoleApis } from '../ui/console_apis.js';
import { makeRequest, RecordingResponse, type UiHttpContext } from '../ui/http.js';
import { type ConsoleCapabilityTable, consoleCapabilityAllows } from './console_capabilities.js';
import {
  CAPABILITIES_REQUIRED,
  CAPABILITIES_REQUIRED_MESSAGE,
  ConsoleCommandError,
  type ConsoleCommandHandler,
} from './console_commands.js';

/**
 * The commands a console may send to an app it reads federated, and what each needs on the
 * owning app (`consoleCommands.actions`). Reads of runtime state (the live queues, the registered
 * schedules, the health checks) need no opt-in, only `telescope:console:read`.
 */
export const CONSOLE_COMMAND_VERBS = {
  'queues.list': null,
  'queues.job': null,
  'queues.retry': 'queues',
  'queues.enqueue': 'queues',
  'schedules.live': null,
  health: null,
  replay: 'replay',
} as const;

export type ConsoleCommandVerb = keyof typeof CONSOLE_COMMAND_VERBS;

/**
 * The capabilities a console's token (token mode, resource `urn:agora:telescope`) needs for each
 * verb. Wildcards work as everywhere in Agora (`telescope:console:*`, `telescope:*`, `*`). The
 * owning app's `consoleCommands.actions` still has to allow the actions.
 */
export const CONSOLE_COMMAND_CAPABILITIES = {
  read: 'telescope:console:read',
  /** Alias of every console capability (write implies read), like every Agora lib's. */
  write: 'telescope:console:write',
  queues: 'telescope:console:queues',
  replay: 'telescope:console:replay',
} as const;

/** Every console capability: what a console sends when its `authorize` does not narrow the viewer. */
export const ALL_CONSOLE_COMMAND_CAPABILITIES: readonly string[] = Object.values(
  CONSOLE_COMMAND_CAPABILITIES,
);

/**
 * Telescope's console capabilities for the shared matcher ({@link consoleCapabilityAllows},
 * `console_capabilities.ts`): `read` the live views, `queues` and `replay` the actions.
 * `telescope:console:write` covers every one of them (write implies read), `telescope:console:read`
 * the read, and `*`, `telescope:*`, `telescope:console:*` everything.
 */
export const TELESCOPE_CONSOLE_CAPABILITIES: ConsoleCapabilityTable = {
  [CONSOLE_COMMAND_CAPABILITIES.read]: 'read',
  [CONSOLE_COMMAND_CAPABILITIES.queues]: 'write',
  [CONSOLE_COMMAND_CAPABILITIES.replay]: 'write',
};

/** Whether `granted` allows telescope's console capability `needed` (the shared matcher). */
export function telescopeConsoleAllows(granted: readonly unknown[] | undefined, needed: string) {
  return consoleCapabilityAllows(granted, needed, TELESCOPE_CONSOLE_CAPABILITIES);
}

/**
 * What the console sends for a viewer: exactly what `authorize` granted, narrowed to the entries
 * that reach a telescope console capability (`telescope:console:*`, `*`, …); every console
 * capability when `authorize` named none. `access: 'read'` keeps only `telescope:console:read`.
 */
export function viewerConsoleCapabilities(
  granted: readonly string[] | undefined,
  access?: 'read' | 'write',
): string[] {
  const kept =
    granted === undefined
      ? [...ALL_CONSOLE_COMMAND_CAPABILITIES]
      : granted.filter(
          (capability) =>
            typeof capability === 'string' &&
            ALL_CONSOLE_COMMAND_CAPABILITIES.some((needed) =>
              telescopeConsoleAllows([capability], needed),
            ),
        );
  if (access !== 'read') return kept;
  return telescopeConsoleAllows(kept, CONSOLE_COMMAND_CAPABILITIES.read)
    ? [CONSOLE_COMMAND_CAPABILITIES.read]
    : [];
}

export { CAPABILITIES_REQUIRED } from './console_commands.js';

function capabilityFor(verb: ConsoleCommandVerb): string {
  const needs = CONSOLE_COMMAND_VERBS[verb];
  return needs === null ? CONSOLE_COMMAND_CAPABILITIES.read : CONSOLE_COMMAND_CAPABILITIES[needs];
}

/** The actions an owning app lets consoles run (`consoleCommands.actions`). */
export interface ConsoleCommandActions {
  /** Replay a captured request against this app. Default `false`. */
  replay?: boolean;
  /** Retry and enqueue jobs on this app's queues. Default `false`. */
  queues?: boolean;
}

/**
 * Run each command through this app's own console handlers (the same validation and capability
 * checks its own console has), answering with their status and body. `log` gets one line per
 * action (a command that changes something).
 *
 * Every command must carry the viewer's capabilities (the console always sends them): one without
 * is refused with `403`, never read as "everything". Every verb, reads included, needs its
 * capability ({@link CONSOLE_COMMAND_CAPABILITIES}).
 *
 * Token mode (the channel set `command.verified`): a service-tenant token's `partition` must be
 * `app`, this app's name (an authkit app-call token is bound by its audience instead), and the
 * effective capabilities are the token's ∩ the message's. An ingest token
 * (`telescope:ingest`) holds no console capability, so it runs nothing here.
 */
export function consoleCommandHandler(options: {
  apis: ConsoleApis;
  actions: ConsoleCommandActions;
  /** This app's partition (token mode): a classic token for any other partition is refused. */
  partition?: string | undefined;
  log?: (line: string) => void;
}): ConsoleCommandHandler {
  const { apis, actions } = options;
  return async (command) => {
    if (!Object.hasOwn(CONSOLE_COMMAND_VERBS, command.verb)) {
      throw new ConsoleCommandError(
        `this app does not answer the console command ${command.verb}`,
        'unsupported-request',
      );
    }
    const verb = command.verb as ConsoleCommandVerb;
    const needs = CONSOLE_COMMAND_VERBS[verb];
    const response = new RecordingResponse();
    const ctx: UiHttpContext = { request: makeRequest('GET'), response };
    const done = () => ({ status: response.statusCode, body: response.body });
    const verified = command.verified;
    if (!Array.isArray(command.capabilities)) {
      response.status(403).send({
        error: CAPABILITIES_REQUIRED_MESSAGE,
        code: CAPABILITIES_REQUIRED,
      });
      return done();
    }
    const capabilities = command.capabilities;
    const allows = (capability: string): boolean =>
      (verified === undefined || telescopeConsoleAllows(verified.capabilities, capability)) &&
      telescopeConsoleAllows(capabilities, capability);
    if (!allows(capabilityFor(verb))) {
      response.status(403).send({
        error:
          verified !== undefined &&
          !telescopeConsoleAllows(verified.capabilities, capabilityFor(verb))
            ? `The console's token lacks ${capabilityFor(verb)}.`
            : `The viewer lacks ${capabilityFor(verb)}.`,
      });
      return done();
    }
    // A service-tenant token names the app it is for in its partition; an authkit app-call token
    // is bound to this app by its audience (its partition is the calling console).
    if (
      verified !== undefined &&
      verified.appCall !== true &&
      (options.partition === undefined || verified.partition !== options.partition)
    ) {
      response.status(403).send({
        error:
          options.partition === undefined
            ? 'This app does not know its own partition, so it takes no token (consoleCommands.partition in its config/telescope.ts).'
            : `The console's token is for "${verified.partition}", not "${options.partition}".`,
      });
      return done();
    }
    if (needs !== null && actions[needs] !== true) {
      response.status(403).send({
        error: `This app does not let other consoles run this action (consoleCommands.actions.${needs} in its config/telescope.ts).`,
      });
      return done();
    }
    const [first, second] = command.args;
    const text = (value: unknown) => (typeof value === 'string' ? value : String(value ?? ''));
    if (needs !== null) {
      const target = command.args
        .filter((arg) => typeof arg === 'string')
        .join('/')
        .slice(0, 200);
      // `actor` is what the console says; `verified` (token mode) is who the console proved to be.
      const via = verified ? ` (console ${verified.clientId ?? verified.partition})` : '';
      options.log?.(
        `[@adonis-agora/telescope] federated console: ${verb}${target ? ` ${target}` : ''} by ${command.actor ?? 'unknown'}${via}`,
      );
    }
    switch (verb) {
      case 'queues.list':
        await apis.queueManagerApi.list(
          ctx,
          actions.queues === true && allows(CONSOLE_COMMAND_CAPABILITIES.queues),
        );
        break;
      case 'queues.job':
        await apis.queueManagerApi.job(ctx, text(first), text(second));
        break;
      case 'queues.retry':
        await apis.queueManagerApi.retry(ctx, text(first), text(second));
        break;
      case 'queues.enqueue':
        await apis.queueManagerApi.enqueue(
          ctx,
          text(first),
          second !== null && typeof second === 'object' ? (second as Record<string, unknown>) : {},
        );
        break;
      case 'schedules.live':
        await apis.schedulesApi.live(ctx);
        break;
      case 'health':
        await apis.fleetApi.health(ctx, false);
        break;
      case 'replay':
        await apis.api.replayRequest(ctx, text(first));
        break;
    }
    return done();
  };
}
