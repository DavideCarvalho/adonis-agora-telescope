import { useState } from 'react';
import { formatRelative } from '../client/format.js';
import type { CpuProfileContent, EntrySummary, HotFrame } from '../client/types.js';
import { Flamegraph } from './Flamegraph.js';
import { formatProfileMs } from './flamegraph.js';
import { Badge } from './primitives/badge.js';
import { Button } from './primitives/button.js';
import { Input } from './primitives/input.js';
import { AsyncBlock, Empty, Panel, SectionTitle } from './ui.js';
import {
  useArmProfile,
  useMeta,
  useProfile,
  useProfilerStatus,
  useProfiles,
} from './use-telescope.js';

/** Sidebar row for one captured profile. */
function ProfileRow({
  profile,
  selected,
  onSelect,
}: {
  profile: EntrySummary;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex w-full flex-col gap-0.5 border-b border-line-soft px-3 py-2 text-left hover:bg-panel ${
        selected ? 'bg-panel' : ''
      }`}
    >
      <span
        className="mono truncate text-xs text-foreground"
        title={profile.familyHash ?? profile.id}
      >
        {profile.familyHash ?? '(unlabelled)'}
      </span>
      <span className="flex items-center gap-2 text-[10px] text-muted-foreground">
        <span>{profile.durationMs !== null ? formatProfileMs(profile.durationMs) : '—'}</span>
        {profile.tags.includes('manual') && <Badge variant="warn">manual</Badge>}
        {profile.tags.includes('sampled') && <Badge variant="brand">sampled</Badge>}
        <span className="ml-auto">{formatRelative(profile.createdAt)}</span>
      </span>
    </button>
  );
}

/** "Hot functions" table (by self time), mirroring Sentry/Clinic profile views. */
function HotFunctions({ hot }: { hot: HotFrame[] }) {
  if (hot.length === 0) return <p className="text-xs text-muted-foreground">No hot frames.</p>;
  return (
    <div className="rounded-lg border border-line bg-panel/40">
      <div className="flex items-center gap-2 border-b border-line px-3 py-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
        <span className="flex-1">Function</span>
        <span className="w-16 text-right">Self</span>
        <span className="w-12 text-right">%</span>
      </div>
      {hot.map((frame) => (
        <div
          key={`${frame.name}:${frame.file}`}
          className="flex items-center gap-2 border-b border-line-soft px-3 py-1 text-[11px] last:border-0"
        >
          <span
            className="mono min-w-0 flex-1 truncate text-foreground"
            title={`${frame.name} ${frame.file}`}
          >
            {frame.name}
            {frame.file && <span className="ml-1 text-muted-foreground">{frame.file}</span>}
          </span>
          <span className="tnum w-16 text-right text-foreground">
            {formatProfileMs(frame.selfMs)}
          </span>
          <span className="tnum w-12 text-right text-warn">{frame.selfPct.toFixed(1)}</span>
        </div>
      ))}
    </div>
  );
}

/** The flamegraph + hot-functions detail for one selected profile. */
function ProfileDetail({ id }: { id: string }) {
  const { data, loading } = useProfile(id);
  if (loading && !data) return <p className="text-muted-foreground">Loading profile…</p>;
  if (!data) return <p className="text-muted-foreground">Profile not found.</p>;
  const content = data.content as CpuProfileContent;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h3 className="mono text-sm text-foreground">{content.label ?? '(unlabelled)'}</h3>
        <span className="text-xs text-muted-foreground">
          {formatProfileMs(content.durationMs)} · {content.sampleCount} samples · {content.reason}
        </span>
      </div>
      <Flamegraph tree={content.tree} />
      <HotFunctions hot={content.hot} />
    </div>
  );
}

/** A small control to arm an on-demand capture of the next N requests. */
function ArmControl({ pendingManual }: { pendingManual: number }) {
  const [count, setCount] = useState(1);
  const [label, setLabel] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [arming, setArming] = useState(false);
  const arm = useArmProfile();

  const submit = async () => {
    setArming(true);
    const outcome = await arm(count, label || undefined);
    setArming(false);
    setMessage(
      outcome.ok
        ? { ok: true, text: `${outcome.pendingManual} pending` }
        : { ok: false, text: outcome.message },
    );
  };

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-panel/40 px-3 py-2">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
        Capture next
      </span>
      <Input
        type="number"
        min={1}
        value={count}
        onChange={(e) => setCount(Math.max(1, Number(e.target.value)))}
        className="w-14"
      />
      <span className="text-[10px] text-muted-foreground">request(s) matching</span>
      <Input
        type="text"
        placeholder="any route (e.g. GET /users/:id)"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        className="w-56"
      />
      <Button variant="brand" disabled={arming} onClick={submit}>
        {arming ? 'Arming…' : 'Arm capture'}
      </Button>
      {pendingManual > 0 && <Badge variant="warn">{pendingManual} pending</Badge>}
      {message && (
        <span className={message.ok ? 'text-[10px] text-good' : 'text-[10px] text-bad'}>
          {message.text}
        </span>
      )}
    </div>
  );
}

/**
 * CPU profiling: capture + inspect real V8 flamegraphs. Ported from `nestjs-telescope`'s
 * `ProfilesPage` — the sidebar/flamegraph/hot-functions/arm-control layout is unchanged (the
 * underlying `node:inspector` capture is genuinely framework-agnostic, see the core package's
 * `src/profiling/*`); only the data source (`GET <path>/api/profiles*`) and styling primitives
 * are AdonisJS-specific.
 */
export function ProfilesSection() {
  const meta = useMeta();
  const status = useProfilerStatus();
  const { data: profiles, loading } = useProfiles(100);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const enabled = meta.data?.profiling?.enabled ?? false;
  const list = profiles ?? [];
  const activeId = selectedId ?? list[0]?.id ?? null;

  if (!enabled) {
    return (
      <Panel>
        <SectionTitle title="CPU Profiles" />
        <Empty>
          CPU profiling is not installed for this dashboard. Enable it with the{' '}
          <code className="mono rounded-sm bg-panel-2 px-1 text-brand">
            @adonis-agora/telescope/cpu_profiling
          </code>{' '}
          provider. It is opt-in because it carries real CPU overhead; when off there is zero cost
          on the request path.
        </Empty>
      </Panel>
    );
  }

  return (
    <Panel>
      <SectionTitle
        title="CPU Profiles"
        hint={
          status.data && (
            <span>
              sampling {(status.data.sampleRate * 100).toFixed(0)}% · {status.data.active} active
            </span>
          )
        }
      />
      <div className="mb-4">
        <ArmControl pendingManual={status.data?.pendingManual ?? 0} />
      </div>
      <div className="flex gap-4">
        <div className="w-64 shrink-0 rounded-lg border border-line">
          <AsyncBlock
            state={{ data: profiles, loading, error: null }}
            isEmpty={(rows) => rows.length === 0}
            empty="No profiles captured yet."
          >
            {(rows) =>
              rows.map((profile) => (
                <ProfileRow
                  key={profile.id}
                  profile={profile}
                  selected={profile.id === activeId}
                  onSelect={() => setSelectedId(profile.id)}
                />
              ))
            }
          </AsyncBlock>
        </div>
        <div className="min-w-0 flex-1">
          {activeId ? (
            <ProfileDetail id={activeId} />
          ) : (
            <p className="text-xs text-muted-foreground">
              Select a profile to view its flamegraph.
            </p>
          )}
        </div>
      </div>
    </Panel>
  );
}
