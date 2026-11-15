/** The ingest wire format version. */
export const WIRE_VERSION = 1;

/** One entry as a tenant sends it. */
export interface WireEntry {
  /** The id the tenant gave it: the server drops an id it already stored for this app. */
  id: string;
  type: string;
  familyHash: string | null;
  content: unknown;
  tags: string[];
  durationMs: number | null;
  origin: string;
  traceId: string | null;
  /** When the tenant recorded it (ISO 8601). */
  createdAt: string;
}

/** `POST <prefix>/ingest` body. */
export interface IngestBatch {
  version: typeof WIRE_VERSION;
  entries: WireEntry[];
}

/** `POST <prefix>/ingest` answer (`202`). */
export interface IngestResult {
  accepted: number;
  duplicates: number;
  rejected: number;
}

/** The header naming the sender's app (advisory: the token decides). */
export const APP_HEADER = 'x-telescope-app';
