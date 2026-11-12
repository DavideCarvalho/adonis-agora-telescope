/**
 * The dev-tools registration contract (version 1), declared locally: `@adonis-agora/agent`'s
 * `mcp_provider` binds a hub at `'agora.devTools'` and serves every registered tool on one dev MCP
 * endpoint (`/mcp/agora`). Telescope never imports the agent; these shapes match it structurally.
 */

/** The container binding the hub lives at. */
export const DEV_TOOLS_BINDING = 'agora.devTools';

export interface DevToolsHub {
  readonly version: number;
  register(lib: DevToolsLib): void;
}

export interface DevToolsLib {
  lib: string;
  title: string;
  /** The console gate, resolved. Never throws. */
  authorize(ctx: unknown): Promise<DevToolsDecision>;
  tools: DevTool[];
}

export type DevToolsDecision =
  | { allowed: true }
  | { allowed: false; reason: 'unauthenticated' | 'forbidden'; redirectTo?: string };

export interface DevToolInputProperty {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array';
  description?: string;
  enum?: readonly string[];
  items?: { type: 'string' };
  minimum?: number;
  maximum?: number;
}

export interface DevToolInputSchema {
  type: 'object';
  properties: Record<string, DevToolInputProperty>;
  required?: string[];
}

export interface DevToolCall {
  ctx: unknown;
  caller: { id: string; via: string };
  limits: { maxRows: number; maxBytes: number };
}

export interface DevTool {
  name: string;
  kind: 'read' | 'action';
  description: string;
  input: DevToolInputSchema;
  destructive?: boolean;
  available?(): boolean | Promise<boolean>;
  run(input: Record<string, unknown>, call: DevToolCall): Promise<unknown>;
}
