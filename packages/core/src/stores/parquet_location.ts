import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';

/** One immutable object (a Parquet file) in a cold location. */
export interface ColdObject {
  /** Location-relative key, always `/`-separated. */
  key: string;
  /** Size in bytes. */
  size: number;
}

/**
 * The byte-level surface the Parquet cold store needs from where its files live.
 * Two ship ({@link DirectoryLocation}, {@link S3Location}); anything else (GCS,
 * Azure, a test double) implements these five calls.
 *
 * Files are written once and never modified, so implementations need no locking:
 * a key either exists with its final bytes or does not exist.
 */
export interface ColdObjectStore {
  /** Every object whose key starts with `prefix` (location-relative). */
  list(prefix: string): Promise<ColdObject[]>;
  /** Bytes `[start, end)` of an object. `end` omitted means "to the end". */
  read(key: string, start: number, end?: number): Promise<Uint8Array>;
  /** Write a whole object. Must be atomic: readers never see a partial file. */
  write(key: string, bytes: Uint8Array): Promise<void>;
  /** Delete objects. Missing keys are not an error. */
  delete(keys: string[]): Promise<void>;
  /**
   * The object's path on the local filesystem, when it has one. Engines that read
   * files by path (DuckDB) use it directly; for remote locations they copy the
   * object into a local cache first.
   */
  localPath?(key: string): string;
  /** The directory every {@link localPath} lives under, when the location is local. */
  readonly localRoot?: string;
}

/** A directory on the local filesystem (or a mounted volume). */
export class DirectoryLocation implements ColdObjectStore {
  readonly localRoot: string;

  constructor(private readonly root: string) {
    this.localRoot = root;
  }

  async list(prefix: string): Promise<ColdObject[]> {
    const out: ColdObject[] = [];
    // Walk only the deepest existing directory the prefix names, not the whole root.
    const slash = prefix.lastIndexOf('/');
    const start = slash >= 0 ? prefix.slice(0, slash) : '';
    await this.walk(join(this.root, start), prefix, out);
    return out;
  }

  private async walk(dir: string, prefix: string, out: ColdObject[]): Promise<void> {
    let names: import('node:fs').Dirent[];
    try {
      names = await readdir(dir, { withFileTypes: true });
    } catch (error: unknown) {
      if (isNotFound(error)) return;
      throw error;
    }
    for (const dirent of names) {
      const full = join(dir, dirent.name);
      if (dirent.isDirectory()) {
        await this.walk(full, prefix, out);
        continue;
      }
      if (!dirent.isFile() || !dirent.name.endsWith('.parquet')) continue;
      const key = relative(this.root, full).split(sep).join('/');
      if (!key.startsWith(prefix)) continue;
      try {
        out.push({ key, size: (await stat(full)).size });
      } catch (error: unknown) {
        // Deleted between readdir and stat (retention or compaction on another tick).
        if (!isNotFound(error)) throw error;
      }
    }
  }

  async read(key: string, start: number, end?: number): Promise<Uint8Array> {
    const { open } = await import('node:fs/promises');
    const handle = await open(this.localPath(key), 'r');
    try {
      const last = end ?? (await handle.stat()).size;
      const length = Math.max(0, last - start);
      const buffer = new Uint8Array(length);
      let offset = 0;
      while (offset < length) {
        const { bytesRead } = await handle.read(buffer, offset, length - offset, start + offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      return offset === length ? buffer : buffer.subarray(0, offset);
    } finally {
      await handle.close();
    }
  }

  async write(key: string, bytes: Uint8Array): Promise<void> {
    const target = this.localPath(key);
    await mkdir(dirname(target), { recursive: true });
    // Write-then-rename so a concurrent reader's directory walk never sees a partial file
    // (the temp name does not end in `.parquet`, so `list` skips it).
    const temp = `${target}.${process.pid}.tmp`;
    await writeFile(temp, bytes);
    await rename(temp, target);
  }

  async delete(keys: string[]): Promise<void> {
    for (const key of keys) {
      await rm(this.localPath(key), { force: true });
    }
  }

  localPath(key: string): string {
    return join(this.root, ...key.split('/'));
  }

  /** Whole-file read, used by tests and tooling. */
  readAll(key: string): Promise<Uint8Array> {
    return readFile(this.localPath(key));
  }
}

/**
 * The slice of `@aws-sdk/client-s3`'s `S3Client` the S3 location uses. The host
 * passes its own configured client, so credentials, region, endpoint (GovCloud, a
 * VPC endpoint, MinIO) and retry policy are the host's.
 */
export interface S3ClientLike {
  send(command: unknown): Promise<unknown>;
}

/** Options for {@link S3Location}. */
export interface S3LocationOptions {
  /** The host's `S3Client`. */
  client: S3ClientLike;
  bucket: string;
  /** Key prefix every file goes under, e.g. `telescope/v1`. A trailing `/` is added. */
  prefix?: string;
}

type S3Commands = typeof import('@aws-sdk/client-s3');

/**
 * An S3 bucket (or any S3-compatible store) through the host's own client. Reads are
 * ranged `GetObject` calls, so a footer or a row group is fetched without the file.
 */
export class S3Location implements ColdObjectStore {
  private readonly prefix: string;
  private commands: S3Commands | null = null;

  constructor(private readonly options: S3LocationOptions) {
    const raw = options.prefix ?? '';
    this.prefix = raw === '' || raw.endsWith('/') ? raw : `${raw}/`;
  }

  private async sdk(): Promise<S3Commands> {
    if (this.commands === null) {
      this.commands = await importOptionalPeer(
        '@aws-sdk/client-s3',
        'the S3 location of storage.parquet()',
        () => import('@aws-sdk/client-s3'),
      );
    }
    return this.commands;
  }

  async list(prefix: string): Promise<ColdObject[]> {
    const { ListObjectsV2Command } = await this.sdk();
    const out: ColdObject[] = [];
    let token: string | undefined;
    do {
      const page = (await this.options.client.send(
        new ListObjectsV2Command({
          Bucket: this.options.bucket,
          Prefix: this.prefix + prefix,
          ...(token !== undefined ? { ContinuationToken: token } : {}),
        }),
      )) as {
        Contents?: Array<{ Key?: string; Size?: number }>;
        IsTruncated?: boolean;
        NextContinuationToken?: string;
      };
      for (const object of page.Contents ?? []) {
        if (object.Key === undefined || !object.Key.endsWith('.parquet')) continue;
        out.push({ key: object.Key.slice(this.prefix.length), size: object.Size ?? 0 });
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token !== undefined);
    return out;
  }

  async read(key: string, start: number, end?: number): Promise<Uint8Array> {
    const { GetObjectCommand } = await this.sdk();
    if (end !== undefined && end <= start) return new Uint8Array(0);
    const range = end === undefined ? `bytes=${start}-` : `bytes=${start}-${end - 1}`;
    const response = (await this.options.client.send(
      new GetObjectCommand({ Bucket: this.options.bucket, Key: this.prefix + key, Range: range }),
    )) as { Body?: { transformToByteArray(): Promise<Uint8Array> } };
    if (!response.Body) return new Uint8Array(0);
    return response.Body.transformToByteArray();
  }

  async write(key: string, bytes: Uint8Array): Promise<void> {
    const { PutObjectCommand } = await this.sdk();
    await this.options.client.send(
      new PutObjectCommand({
        Bucket: this.options.bucket,
        Key: this.prefix + key,
        Body: bytes,
        ContentType: 'application/vnd.apache.parquet',
      }),
    );
  }

  async delete(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    const { DeleteObjectsCommand } = await this.sdk();
    for (let i = 0; i < keys.length; i += 1000) {
      await this.options.client.send(
        new DeleteObjectsCommand({
          Bucket: this.options.bucket,
          Delete: { Objects: keys.slice(i, i + 1000).map((key) => ({ Key: this.prefix + key })) },
        }),
      );
    }
  }
}

/**
 * Import an optional peer dependency, turning "module not found" into an error
 * that names the package and the config that needs it. Anything else (a broken
 * native binding, a syntax error) is rethrown as-is.
 */
export async function importOptionalPeer<T>(
  name: string,
  neededBy: string,
  importer: () => Promise<T>,
): Promise<T> {
  try {
    return await importer();
  } catch (error: unknown) {
    if (isModuleNotFound(error, name)) {
      throw new Error(
        `@adonis-agora/telescope: ${neededBy} needs the optional peer dependency "${name}", which is not installed. Install it (e.g. \`npm install ${name}\`) or choose a different option.`,
        { cause: error },
      );
    }
    throw error;
  }
}

function isModuleNotFound(error: unknown, name: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  const message = String((error as { message?: unknown }).message ?? '');
  return (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') && message.includes(name);
}

export function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, name } = error as { code?: unknown; name?: unknown };
  return code === 'ENOENT' || name === 'NoSuchKey' || name === 'NotFound';
}

/** Make sure a directory exists (used for the DuckDB local file cache). */
export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}
