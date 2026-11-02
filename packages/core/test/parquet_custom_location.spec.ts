import { describe, expect, it } from 'vitest';
import { storage } from '../src/stores/factory.js';
import type { ColdObjectStore } from '../src/stores/parquet_location.js';

class HostLocation implements ColdObjectStore {
  readonly s3 = { bucket: 'kept-by-the-host' };
  readonly written: string[] = [];
  async list() {
    return [];
  }
  async read() {
    return new Uint8Array(0);
  }
  async write(key: string) {
    this.written.push(key);
  }
  async delete() {}
}

describe('storage.parquet location', () => {
  it('keeps a ready-made location even when it has a field named s3', async () => {
    const location = new HostLocation();
    const cold = await storage.parquet({ location, engine: 'hyparquet', instanceId: 'pod' })(
      {} as never,
    );

    expect((cold as unknown as { location: unknown }).location).toBe(location);
  });
});
