import type { ConsoleApis } from '../ui/console_apis.js';
import { makeRequest, RecordingResponse, type UiHttpContext } from '../ui/http.js';
import { ConsoleCommandError, type ConsoleCommandHandler } from './console_commands.js';

/**
 * The commands a console may send to an app it reads federated, and what each needs on the
 * owning app (`consoleCommands.actions`). Reads of runtime state (the live queues, the registered
 * schedules, the health checks) need nothing: they run as soon as the app answers commands.
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
 */
export function consoleCommandHandler(options: {
  apis: ConsoleApis;
  actions: ConsoleCommandActions;
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
      options.log?.(
        `[@adonis-agora/telescope] federated console: ${verb}${target ? ` ${target}` : ''} by ${command.actor ?? 'unknown'}`,
      );
    }
    switch (verb) {
      case 'queues.list':
        await apis.queueManagerApi.list(ctx, actions.queues === true);
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
