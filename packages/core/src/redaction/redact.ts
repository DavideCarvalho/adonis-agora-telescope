// packages/core/src/redaction/redact.ts
//
// Framework-agnostic, sensitive-data REDACTION. Ported from `nestjs-telescope`'s
// `redaction/redact.ts`: a bounded, never-throwing, cycle-safe deep clone that
// masks sensitive keys (case-insensitive) before content is persisted. Telescope
// wires it once at the store boundary so NO watcher can leak a secret into storage.

/**
 * The default set of sensitive key names masked by {@link redact}. Matched
 * case-insensitively at any depth. Mirrors the NestJS original 1:1.
 */
export const DEFAULT_REDACT_KEYS: readonly string[] = [
  'authorization',
  'cookie',
  'set-cookie',
  'password',
  'passwd',
  'secret',
  'token',
  'access_token',
  'refresh_token',
  'api-key',
  'api_key',
  'apikey',
  'x-api-key',
  'client_secret',
  'private_key',
];

/**
 * Hard, on-by-default bounds that cap how much {@link redact} clones from a single
 * input. A captured payload (a request body, an ORM entity reachable from query
 * bindings, a mail context) can be an arbitrarily large or deep graph; cloning it
 * whole would let a single entry retain an unbounded snapshot. These defaults are
 * generous enough that a NORMAL entry is cloned byte-identically and only bite on
 * pathological mega-graphs.
 */
const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_STRING_LENGTH = 8_192;
const DEFAULT_MAX_ARRAY_LENGTH = 200;
const DEFAULT_MAX_NODES = 5_000;
const DEFAULT_MAX_CONTENT_BYTES = 16_384;
/** Approximate per-node overhead charged against `maxContentBytes` (keys,
 *  punctuation, numbers — a coarse stand-in for serialized size). */
const NODE_BYTE_OVERHEAD = 8;

/** Marker substituted for a subtree pruned because it exceeded `maxDepth`. */
const DEPTH_MARKER = '[Truncated: depth]';
/** Suffix appended to a string clipped to `maxStringLength`. */
const STRING_TRUNCATION_SUFFIX = '…[truncated]';
/** Marker substituted for a subtree pruned because the node/byte budget ran out. */
const SIZE_MARKER = '[Truncated: size]';
/** The default replacement for a masked sensitive leaf. */
export const DEFAULT_MASK = '[REDACTED]';

export interface RedactOptions {
  /** Extra keys to mask (merged with {@link DEFAULT_REDACT_KEYS}, case-insensitive). */
  keys?: string[];
  /**
   * Exact dot-paths to mask regardless of key name, e.g. `'body.ssn'`.
   * Unlike `keys` (which match that key at any depth), a path must match the
   * full traversal location from the root of the value passed to {@link redact}.
   */
  paths?: string[];
  /** Replacement string. Defaults to {@link DEFAULT_MASK}. */
  mask?: string;
  /**
   * Maximum object/array nesting depth to clone. Beyond it, the subtree is
   * replaced with `'[Truncated: depth]'`. ON BY DEFAULT (8).
   */
  maxDepth?: number;
  /**
   * Maximum cloned string length. Longer strings are clipped to the first N
   * chars plus a `'…[truncated]'` suffix. ON BY DEFAULT (8_192).
   */
  maxStringLength?: number;
  /**
   * Maximum number of array items to clone. Longer arrays keep the first N items
   * and append a final `'[Truncated: N of M items]'` marker element. ON BY
   * DEFAULT (200).
   */
  maxArrayLength?: number;
  /**
   * Per-call walked-node budget: every object, array, and leaf visited counts
   * against it. Once exhausted, remaining subtrees become `'[Truncated: size]'`.
   * ON BY DEFAULT (5_000).
   */
  maxNodes?: number;
  /**
   * Approximate serialized-byte budget per cloned content: every string charges
   * its length, every visited node a small fixed overhead. Once exhausted,
   * remaining subtrees become `'[Truncated: size]'`. ON BY DEFAULT (16_384).
   */
  maxContentBytes?: number;
  /**
   * Per-entry-type overrides of the numeric bounds above, keyed by the entry's
   * `type` (e.g. `'exception'`, `'client_exception'`). A listed type's bounds are
   * merged OVER the top-level bounds for that entry only; unlisted types use the
   * top-level bounds unchanged. The masking spec (`keys`/`paths`/`mask`) is never
   * per-type — it stays uniform (and is compiled once).
   *
   * Motivation: the content-byte budget is really an OOM guard on HIGH-VOLUME
   * entries (request/query/cache clone big live graphs). Rare, high-value entries
   * — exceptions and client exceptions, whose stacks/componentStacks are
   * legitimately many KB — can be given a bigger budget WITHOUT loosening the
   * guard on the noisy ones.
   */
  perType?: Record<string, RedactBounds>;
}

/**
 * The numeric memory bounds of {@link RedactOptions} — the subset overridable
 * PER ENTRY TYPE via {@link RedactOptions.perType}. The masking spec
 * (`keys`/`paths`/`mask`) is deliberately excluded: masking is a security
 * invariant that stays uniform across every entry.
 */
export type RedactBounds = Pick<
  RedactOptions,
  'maxDepth' | 'maxStringLength' | 'maxArrayLength' | 'maxNodes' | 'maxContentBytes'
>;

/** Result of a bounded redaction: the detached clone plus whether anything was clipped. */
export interface RedactBoundedResult {
  /** The detached, masked, bounded clone. */
  value: unknown;
  /** True when any bound (depth/string/array/node/byte) clipped some content. */
  truncated: boolean;
}

/**
 * The masking decision derived from {@link RedactOptions}, compiled ONCE so the
 * per-entry hot path never rebuilds these Sets. `keySet` holds the lowercased
 * union of {@link DEFAULT_REDACT_KEYS} and `options.keys`; `paths` holds the exact
 * dot-paths. Build it via {@link compileRedactSpec} at boot and feed it to
 * {@link redactBoundedWith}.
 */
export interface CompiledRedactSpec {
  /** Lowercased union of default + configured keys, matched at any depth. */
  keySet: ReadonlySet<string>;
  /** Exact dot-paths to mask regardless of key name. */
  paths: ReadonlySet<string>;
}

/**
 * Precompiles the immutable key/path Sets from {@link RedactOptions}. Call once
 * (config is immutable after boot) and reuse the result across every entry.
 */
export function compileRedactSpec(options: RedactOptions): CompiledRedactSpec {
  return {
    keySet: new Set(
      [...DEFAULT_REDACT_KEYS, ...(options.keys ?? [])].map((key) => key.toLowerCase()),
    ),
    paths: new Set(options.paths ?? []),
  };
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Bounded, never-throwing, SYNCHRONOUS deep clone of `value` with sensitive
 * leaves masked. Same key/path masking semantics as {@link redact}, plus the
 * hard memory bounds in {@link RedactOptions} (all defaulted on). Returns the
 * clone AND whether truncation happened.
 */
export function redactBounded(value: unknown, options: RedactOptions = {}): RedactBoundedResult {
  return redactBoundedWith(value, options, compileRedactSpec(options));
}

/**
 * Bounded redaction using an ALREADY-COMPILED {@link CompiledRedactSpec}, so the
 * per-entry hot path never rebuilds the key/path Sets. Identical behaviour to
 * {@link redactBounded}; only the `keys`/`paths` of `options` are ignored in
 * favour of the prebuilt `spec` (the remaining bound options are still read).
 */
export function redactBoundedWith(
  value: unknown,
  options: RedactOptions,
  spec: CompiledRedactSpec,
): RedactBoundedResult {
  const mask = options.mask ?? DEFAULT_MASK;
  const keySet = spec.keySet;
  const paths = spec.paths;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxStringLength = options.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH;
  const maxArrayLength = options.maxArrayLength ?? DEFAULT_MAX_ARRAY_LENGTH;
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  const maxContentBytes = options.maxContentBytes ?? DEFAULT_MAX_CONTENT_BYTES;
  const seen = new WeakSet<object>();

  // Mutable walk state: node + byte budgets and a truncation flag. Kept in the
  // closure (not threaded through args) so the per-call accounting stays cheap.
  let nodesRemaining = maxNodes;
  let bytesRemaining = maxContentBytes;
  let truncated = false;

  const walk = (node: unknown, path: string, depth: number): unknown => {
    // Every visited node (object, array, or leaf) costs one node unit and a small
    // byte overhead; strings additionally charge their length. Once either budget
    // is gone, prune the rest of the graph regardless of its shape.
    if (nodesRemaining <= 0 || bytesRemaining <= 0) {
      truncated = true;
      return SIZE_MARKER;
    }
    nodesRemaining -= 1;
    bytesRemaining -= NODE_BYTE_OVERHEAD;

    if (typeof node === 'string') {
      const kept = node.length > maxStringLength ? maxStringLength : node.length;
      bytesRemaining -= kept;
      if (node.length > maxStringLength) {
        truncated = true;
        return `${node.slice(0, maxStringLength)}${STRING_TRUNCATION_SUFFIX}`;
      }
      return node;
    }

    // `seen` tracks only the current ancestor path (added on the way down, removed
    // on the way up), so genuine cycles are caught while a non-cyclic shared
    // reference appearing in two sibling positions is NOT a false hit.
    if (Array.isArray(node)) {
      if (seen.has(node)) return '[Circular]';
      if (depth >= maxDepth) {
        truncated = true;
        return DEPTH_MARKER;
      }
      seen.add(node);
      const limit = Math.min(node.length, maxArrayLength);
      const mapped: unknown[] = [];
      for (let index = 0; index < limit; index++) {
        // Stop iterating the moment a budget runs out: ONE trailing marker, not
        // one marker per remaining item (markers themselves cost bytes).
        if (nodesRemaining <= 0 || bytesRemaining <= 0) {
          truncated = true;
          mapped.push(SIZE_MARKER);
          break;
        }
        mapped.push(walk(node[index], path ? `${path}.${index}` : String(index), depth + 1));
      }
      if (node.length > maxArrayLength) {
        truncated = true;
        mapped.push(`[Truncated: ${maxArrayLength} of ${node.length} items]`);
      }
      seen.delete(node);
      return mapped;
    }

    // Binary blobs (Buffer, TypedArrays, DataView, ArrayBuffer) are opaque
    // bytes, not a traversable graph — summarize them as a bounded marker
    // instead of walking them. This is load-bearing: a Buffer is `typeof
    // 'object'` and not an Array, so without this it satisfies isPlainObject()
    // and `Object.entries()` EAGERLY materializes one [index, byte] pair per
    // byte BEFORE the node/byte budget is ever consulted. On a multi-MB body
    // (e.g. a raw file-upload chunk) that is seconds of synchronous CPU and
    // hundreds of MB allocated on the event loop — the budgets never get a
    // chance to bite. O(1) here.
    if (ArrayBuffer.isView(node)) {
      truncated = true;
      const name = node.constructor?.name ?? 'Binary';
      return `[${name}: ${node.byteLength} bytes]`;
    }
    if (node instanceof ArrayBuffer) {
      truncated = true;
      return `[ArrayBuffer: ${node.byteLength} bytes]`;
    }

    if (isPlainObject(node)) {
      if (seen.has(node)) return '[Circular]';
      if (depth >= maxDepth) {
        truncated = true;
        return DEPTH_MARKER;
      }
      seen.add(node);
      const result: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node)) {
        // Stop iterating the moment a budget runs out: ONE trailing marker, not
        // one marker per remaining field (keys + markers themselves cost bytes).
        if (nodesRemaining <= 0 || bytesRemaining <= 0) {
          truncated = true;
          result['…'] = SIZE_MARKER;
          break;
        }
        // Object keys are real serialized bytes — charge them too.
        bytesRemaining -= key.length;
        const childPath = path ? `${path}.${key}` : key;
        if (keySet.has(key.toLowerCase()) || paths.has(childPath)) {
          result[key] = mask;
        } else {
          result[key] = walk(child, childPath, depth + 1);
        }
      }
      seen.delete(node);
      return result;
    }

    return node;
  };

  return { value: walk(value, '', 0), truncated };
}

/**
 * Returns a deep clone of `value` with sensitive leaves replaced by the mask.
 * Never mutates the input. Memory-bounded by default (see {@link RedactOptions});
 * delegates to {@link redactBounded} and discards the truncation flag.
 */
export function redact(value: unknown, options: RedactOptions = {}): unknown {
  return redactBounded(value, options).value;
}
