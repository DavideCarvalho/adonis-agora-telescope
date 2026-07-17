import { describe, expect, it } from 'vitest';
import { EntryType } from '../../src/entry.js';
import { DEFAULT_MASK } from '../../src/redaction/redact.js';
import { RedactingTelescopeStore } from '../../src/redaction/redacting_store.js';
import { InMemoryTelescopeStore } from '../../src/stores/memory.js';

describe('RedactingTelescopeStore', () => {
  it('stores a recorded entry with sensitive fields masked', async () => {
    const inner = new InMemoryTelescopeStore();
    const store = new RedactingTelescopeStore(inner);

    await store.record({
      type: EntryType.Request,
      content: {
        url: '/login',
        headers: { authorization: 'Bearer super-secret', accept: 'application/json' },
        body: { password: 'hunter2', email: 'davi@goflip.ai' },
      },
    });

    const [entry] = await inner.list();
    const content = entry.content as {
      url: string;
      headers: Record<string, string>;
      body: Record<string, string>;
    };

    expect(content.url).toBe('/login');
    expect(content.headers.authorization).toBe(DEFAULT_MASK);
    expect(content.headers.accept).toBe('application/json');
    expect(content.body.password).toBe(DEFAULT_MASK);
    expect(content.body.email).toBe('davi@goflip.ai');
  });

  it('masks lucid query bindings (the verbatim-binding leak path)', async () => {
    const inner = new InMemoryTelescopeStore();
    const store = new RedactingTelescopeStore(inner);

    await store.record({
      type: EntryType.Query,
      content: {
        sql: 'insert into users (password) values (?)',
        bindings: { password: 'plaintext' },
      },
    });

    const [entry] = await inner.list();
    const content = entry.content as { bindings: Record<string, string> };
    expect(content.bindings.password).toBe(DEFAULT_MASK);
  });

  it('masks mail content (from/to/subject path)', async () => {
    const inner = new InMemoryTelescopeStore();
    const store = new RedactingTelescopeStore(inner);

    await store.record({
      type: EntryType.Mail,
      content: { from: 'a@b.com', subject: 'Reset', token: 'reset-token-123' },
    });

    const [entry] = await inner.list();
    const content = entry.content as Record<string, string>;
    expect(content.from).toBe('a@b.com');
    expect(content.subject).toBe('Reset');
    expect(content.token).toBe(DEFAULT_MASK);
  });

  it('honours extra configured keys', async () => {
    const inner = new InMemoryTelescopeStore();
    const store = new RedactingTelescopeStore(inner, { keys: ['ssn'] });

    await store.record({ type: EntryType.Cache, content: { ssn: '123-45-6789', op: 'get' } });

    const [entry] = await inner.list();
    const content = entry.content as Record<string, string>;
    expect(content.ssn).toBe(DEFAULT_MASK);
    expect(content.op).toBe('get');
  });

  it('returns the persisted entry from the inner store', async () => {
    const inner = new InMemoryTelescopeStore();
    const store = new RedactingTelescopeStore(inner);

    const entry = await store.record({ type: 'x', content: { password: 'p' } });
    expect(entry.id).toBeTypeOf('string');
    expect(await store.count()).toBe(1);
    expect(await store.get(entry.id)).not.toBeNull();
  });

  it('gives a per-type entry a larger content budget than the global one', async () => {
    const inner = new InMemoryTelescopeStore();
    // Punishingly small global byte budget (protects high-volume request/cache
    // entries); a generous per-type budget for the rare, high-value exception.
    const store = new RedactingTelescopeStore(inner, {
      maxContentBytes: 50,
      perType: { [EntryType.Exception]: { maxContentBytes: 100_000 } },
    });

    // Same payload for both: a long leading field exhausts the tiny global budget,
    // so a trailing field is dropped — UNLESS the per-type budget is larger.
    const payload = { big: 'x'.repeat(400), tail: 'keepme' };
    await store.record({ type: EntryType.Request, familyHash: 'r', content: { ...payload } });
    await store.record({ type: EntryType.Exception, familyHash: 'e', content: { ...payload } });

    const req = (await inner.list({ type: EntryType.Request }))[0]?.content as Record<
      string,
      unknown
    >;
    const exc = (await inner.list({ type: EntryType.Exception }))[0]?.content as Record<
      string,
      unknown
    >;

    // Global budget starved the request's trailing field out.
    expect(req.tail).toBeUndefined();
    // The exception's larger per-type budget preserved it.
    expect(exc.tail).toBe('keepme');
  });

  it('masking (sensitive keys) stays global even for a per-type entry', async () => {
    const inner = new InMemoryTelescopeStore();
    const store = new RedactingTelescopeStore(inner, {
      keys: ['ssn'],
      perType: { [EntryType.Exception]: { maxContentBytes: 100_000 } },
    });
    await store.record({
      type: EntryType.Exception,
      familyHash: 'e',
      content: { ssn: '123-45-6789', note: 'ok' },
    });
    const exc = (await inner.list({ type: EntryType.Exception }))[0]?.content as Record<
      string,
      unknown
    >;
    // The per-type override only widened the numeric budget; the mask still applies.
    expect(exc.ssn).toBe(DEFAULT_MASK);
    expect(exc.note).toBe('ok');
  });

  it('delegates read/maintenance operations unchanged', async () => {
    const inner = new InMemoryTelescopeStore();
    const store = new RedactingTelescopeStore(inner);
    await store.record({ type: 'x', content: 1 });
    await store.record({ type: 'y', content: 2 });

    expect(await store.list({ type: 'x' })).toHaveLength(1);
    await store.clear();
    expect(await store.count()).toBe(0);
  });
});
