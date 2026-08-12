import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './primitives/select.js';

/** A small trailing-window picker (5m … 7d) shared by the Pulse and Exceptions views. */
const WINDOWS: { label: string; ms: number }[] = [
  { label: '5m', ms: 300_000 },
  { label: '15m', ms: 900_000 },
  { label: '1h', ms: 3_600_000 },
  { label: '6h', ms: 21_600_000 },
  { label: '24h', ms: 86_400_000 },
  { label: '7d', ms: 604_800_000 },
];

export function WindowSelect({
  value,
  onChange,
}: {
  value: number;
  onChange: (ms: number) => void;
}) {
  return (
    <Select
      value={String(value)}
      onValueChange={(next) => {
        if (typeof next === 'string') onChange(Number(next));
      }}
    >
      <SelectTrigger aria-label="time window">
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        {WINDOWS.map((w) => (
          <SelectItem key={w.ms} value={String(w.ms)}>
            {w.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
