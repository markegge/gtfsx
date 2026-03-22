

const DAYS = [
  { key: 'monday', label: 'M' },
  { key: 'tuesday', label: 'T' },
  { key: 'wednesday', label: 'W' },
  { key: 'thursday', label: 'Th' },
  { key: 'friday', label: 'F' },
  { key: 'saturday', label: 'Sa' },
  { key: 'sunday', label: 'Su' },
] as const;

interface DayToggleProps {
  values: Record<string, 0 | 1>;
  onChange: (day: string, value: 0 | 1) => void;
}

export function DayToggle({ values, onChange }: DayToggleProps) {
  return (
    <div className="flex gap-1">
      {DAYS.map(({ key, label }) => {
        const active = values[key] === 1;
        return (
          <button
            key={key}
            onClick={() => onChange(key, active ? 0 : 1)}
            className={`w-9 h-9 rounded-full text-xs font-bold transition-colors
              ${active
                ? 'bg-coral text-white'
                : 'bg-sand text-warm-gray hover:bg-coral-light hover:text-coral'
              }`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
