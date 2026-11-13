import { useState } from 'react';
import { EmptyState } from '../agora-kit/blocks/empty-state';
import { Badge } from '../agora-kit/ui/badge';
import { Button } from '../agora-kit/ui/button';
import { Textarea } from '../agora-kit/ui/textarea';
import { formatCount } from '../client/format.js';
import type { QueueJobDetail, QueueSummary } from '../client/types.js';
import { QueueIcon } from './icons.js';
import { Input } from './primitives/input.js';
import { AsyncBlock, Empty, PageHeader, Panel, SectionTitle } from './ui.js';
import { useLiveQueues, useMeta, useTelescopeClient } from './use-telescope.js';

function QueueCounts({ queue }: { queue: QueueSummary }) {
  const { counts } = queue;
  return (
    <div className="mono mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10.5px] text-faint">
      <span>
        pending <b className="tnum font-medium text-fg">{formatCount(counts.pending)}</b>
      </span>
      <span title="This driver cannot report this count — see the docs for what @boringnode/queue's public API actually exposes.">
        active <b className="tnum">{counts.active === null ? '—' : formatCount(counts.active)}</b>
      </span>
      <span title="This driver cannot report this count.">
        delayed{' '}
        <b className="tnum">{counts.delayed === null ? '—' : formatCount(counts.delayed)}</b>
      </span>
      <span title="This driver cannot report this count.">
        failed{' '}
        <b className={counts.failed ? 'tnum font-medium text-bad' : 'tnum'}>
          {counts.failed === null ? '—' : formatCount(counts.failed)}
        </b>
      </span>
      <span title="This driver cannot report this count.">
        completed{' '}
        <b className="tnum">{counts.completed === null ? '—' : formatCount(counts.completed)}</b>
      </span>
    </div>
  );
}

function JobDetail({
  job,
  canRetry,
  onRetry,
  retrying,
  retryMessage,
}: {
  job: QueueJobDetail;
  canRetry: boolean;
  onRetry: () => void;
  retrying: boolean;
  retryMessage: string | null;
}) {
  return (
    <div className="agora-rise space-y-3 rounded-lg border border-border bg-panel-2 p-3.5 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="mono text-[12.5px] text-fg">{job.name ?? '(unnamed)'}</div>
          <div className="mono text-[10.5px] text-faint">id: {job.id}</div>
        </div>
        <div className="flex items-center gap-2">
          {job.state && (
            <Badge variant={job.state === 'failed' ? 'destructive' : 'neutral'}>{job.state}</Badge>
          )}
          {canRetry && (
            <Button size="sm" variant="brand" disabled={retrying} onClick={onRetry}>
              {retrying ? 'Retrying…' : 'Retry'}
            </Button>
          )}
        </div>
      </div>
      {job.failedReason && (
        <div className="mono rounded-md border border-bad/25 bg-bad/5 p-2.5 text-[11.5px] text-bad">
          {job.failedReason}
        </div>
      )}
      <div className="mono grid grid-cols-1 gap-2 text-[10.5px] text-dim sm:grid-cols-2">
        <span>
          attempts: {job.attemptsMade ?? '—'} / {job.maxAttempts ?? '—'}
        </span>
        <span>created: {job.createdAt ?? '—'}</span>
        <span>processed: {job.processedAt ?? '—'}</span>
        <span>finished: {job.finishedAt ?? '—'}</span>
      </div>
      <div>
        <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-faint">
          Payload
        </div>
        <pre className="mono max-h-40 overflow-auto rounded-md border border-border bg-sunken/30 p-2.5 text-[11px] text-fg-2">
          {JSON.stringify(job.payload, null, 2)}
        </pre>
      </div>
      {retryMessage && <p className="text-bad">{retryMessage}</p>}
    </div>
  );
}

function EnqueueForm({ queue }: { queue: string }) {
  const client = useTelescopeClient();
  const [name, setName] = useState('');
  const [payload, setPayload] = useState('{}');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const submit = async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      setMessage({ ok: false, text: 'Payload must be valid JSON.' });
      return;
    }
    setBusy(true);
    const outcome = await client.enqueueJob(queue, parsed, name || undefined);
    setBusy(false);
    setMessage(
      outcome.ok
        ? { ok: true, text: `Enqueued${outcome.id ? ` as ${outcome.id}` : ''}.` }
        : { ok: false, text: outcome.message },
    );
  };

  return (
    <div className="space-y-2.5 rounded-lg border border-border bg-panel-2 p-3.5">
      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-faint">
        Enqueue a job on <span className="mono normal-case tracking-normal text-fg">{queue}</span>
      </div>
      <Input
        placeholder="job name (optional)"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <Textarea
        value={payload}
        onChange={(e) => setPayload(e.target.value)}
        rows={4}
        aria-label="job payload (JSON)"
        className="mono min-h-24 text-xs md:text-xs"
        placeholder="{}"
      />
      <div className="flex items-center gap-2">
        <Button size="sm" variant="brand" disabled={busy} onClick={submit}>
          {busy ? 'Enqueuing…' : 'Enqueue'}
        </Button>
        {message && (
          <span className={message.ok ? 'text-[11px] text-good' : 'text-[11px] text-bad'}>
            {message.text}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Live Queue Manager: list/inspect/retry/enqueue over `@adonisjs/queue` (powered by
 * `@boringnode/queue`). Deliberately a SMALLER console than the NestJS sibling's BullMQ-backed
 * queue manager — `@boringnode/queue`'s public API has no per-state job listing, no remove, and no
 * promote (confirmed against the published `Adapter` interface; see the core package's
 * `src/watchers/queue_manager.ts` for the full research trail). What IS here — a pending count,
 * single-job lookup by id, retry-by-id, and enqueue — is genuinely supported, not faked.
 */
export function QueueManagerSection() {
  const meta = useMeta();
  const { data, loading, error, reload } = useLiveQueues();
  const client = useTelescopeClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [jobIdInput, setJobIdInput] = useState('');
  const [job, setJob] = useState<QueueJobDetail | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [retryMessage, setRetryMessage] = useState<string | null>(null);

  const enabled = meta.data?.queueManager?.enabled ?? false;

  const header = (
    <PageHeader
      title="Queues"
      description="Pending counts per queue, job lookup by id, retry and enqueue."
    />
  );

  if (!enabled) {
    return (
      <div className="flex flex-col gap-4">
        {header}
        <Panel>
          <SectionTitle title="Queue Manager" />
          <Empty>
            The live queue manager is not configured. Enable the{' '}
            <code className="mono rounded-sm bg-panel-2 px-1 text-brand">queue-manager</code>{' '}
            watcher and set{' '}
            <code className="mono rounded-sm bg-panel-2 px-1 text-brand">
              telescope_watchers.queueManager.queues
            </code>{' '}
            to the queue names you want surfaced — <code className="mono">@boringnode/queue</code>{' '}
            has no queue-enumeration API, so there is nothing to auto-discover.
          </Empty>
        </Panel>
      </div>
    );
  }

  const queues = data?.queues ?? [];
  const capabilities = data?.capabilities;
  const selectedSummary = queues.find((q) => q.queue === selected);
  const canRetry = capabilities?.mutationsEnabled && capabilities.actions.includes('retry');
  const canEnqueue = capabilities?.mutationsEnabled && capabilities.actions.includes('enqueue');

  const lookupJob = async () => {
    if (!selected || !jobIdInput) return;
    setJobError(null);
    setRetryMessage(null);
    const found = await client.queueJob(selected, jobIdInput);
    if (found === null) {
      setJob(null);
      setJobError('No job with that id.');
    } else {
      setJob(found);
    }
  };

  const retry = async () => {
    if (!selected || !job) return;
    setRetrying(true);
    const outcome = await client.retryJob(selected, job.id);
    setRetrying(false);
    setRetryMessage(outcome.ok ? null : outcome.message);
    if (outcome.ok) await lookupJob();
  };

  return (
    <div className="flex flex-col gap-4">
      {header}
      <Panel>
        <SectionTitle
          title="Queue Manager"
          hint={
            capabilities && !capabilities.mutationsEnabled
              ? 'read-only · set telescope_ui.queueActions.enabled to allow retry/enqueue'
              : undefined
          }
        />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[240px_minmax(0,1fr)]">
          <aside className="space-y-2">
            <AsyncBlock
              state={{ data: data ? queues : null, loading, error, reload }}
              isEmpty={(rows) => rows.length === 0}
              empty="No queues configured."
            >
              {(rows) => (
                <div className="space-y-1.5">
                  {rows.map((q) => (
                    <button
                      type="button"
                      key={q.queue}
                      aria-pressed={selected === q.queue}
                      onClick={() => {
                        setSelected(q.queue);
                        setJob(null);
                        setJobIdInput('');
                        setJobError(null);
                      }}
                      className={`w-full rounded-md border px-3 py-2 text-left text-xs transition-colors ${
                        selected === q.queue
                          ? 'border-brand-border bg-brand-soft'
                          : 'border-border hover:bg-hover'
                      }`}
                    >
                      <div className="mono text-[12.5px] text-fg">{q.queue}</div>
                      <QueueCounts queue={q} />
                    </button>
                  ))}
                </div>
              )}
            </AsyncBlock>
          </aside>

          <section className="min-w-0 space-y-3">
            {!selectedSummary ? (
              <EmptyState
                className="rounded-lg border border-dashed border-line-strong"
                icon={<QueueIcon />}
                title="No queue selected"
                description="Select a queue to look up or enqueue a job."
              />
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <Input
                    placeholder="job id"
                    value={jobIdInput}
                    onChange={(e) => setJobIdInput(e.target.value)}
                    className="max-w-xs"
                  />
                  <Button size="sm" variant="outline" onClick={lookupJob}>
                    Look up
                  </Button>
                </div>
                {jobError && <p className="text-xs text-bad">{jobError}</p>}
                {job && (
                  <JobDetail
                    job={job}
                    canRetry={Boolean(canRetry)}
                    onRetry={retry}
                    retrying={retrying}
                    retryMessage={retryMessage}
                  />
                )}
                {canEnqueue && <EnqueueForm queue={selectedSummary.queue} />}
              </>
            )}
          </section>
        </div>
      </Panel>
    </div>
  );
}
