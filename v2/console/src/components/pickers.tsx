import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { monthLabel, recentMonths } from "@/lib/format";

export function MonthPicker({
  value,
  onChange,
  months = 12,
}: {
  value: string;
  onChange: (month: string) => void;
  months?: number;
}) {
  const options = recentMonths(months);
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-[180px]" size="sm" aria-label="Month">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((month) => (
          <SelectItem key={month} value={month}>
            {monthLabel(month)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export const RANGES = [
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
] as const;

export function RangePicker({ value, onChange }: { value: string; onChange: (days: string) => void }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-[150px]" size="sm" aria-label="Date range">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {RANGES.map((range) => (
          <SelectItem key={range.value} value={range.value}>
            {range.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
