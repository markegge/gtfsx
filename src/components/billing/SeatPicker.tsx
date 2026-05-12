interface SeatPickerProps {
  seats: number;
  onChange: (seats: number) => void;
  min?: number;
  max?: number;
  perSeatPriceUsd: number;
  interval: 'month' | 'year';
}

export function SeatPicker({
  seats,
  onChange,
  min = 1,
  max = 200,
  perSeatPriceUsd,
  interval,
}: SeatPickerProps) {
  const subtotal = perSeatPriceUsd * seats;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <button
          type="button"
          aria-label="Decrease seats"
          className="grid h-9 w-9 place-items-center rounded-full border border-sand bg-cream text-brown hover:bg-sand disabled:opacity-50"
          disabled={seats <= min}
          onClick={() => onChange(Math.max(min, seats - 1))}
        >
          −
        </button>
        <input
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          value={seats}
          onChange={(e) => {
            const n = parseInt(e.target.value, 10);
            if (Number.isFinite(n)) onChange(Math.max(min, Math.min(max, n)));
          }}
          className="h-9 w-16 rounded-md border border-sand bg-cream text-center font-semibold text-brown focus:border-coral focus:outline-none"
        />
        <button
          type="button"
          aria-label="Increase seats"
          className="grid h-9 w-9 place-items-center rounded-full border border-sand bg-cream text-brown hover:bg-sand disabled:opacity-50"
          disabled={seats >= max}
          onClick={() => onChange(Math.min(max, seats + 1))}
        >
          +
        </button>
        <span className="ml-2 text-sm text-warm-gray">seats</span>
      </div>
      <div className="text-xs text-warm-gray">
        ${perSeatPriceUsd}/seat/{interval} ×{' '}
        <span className="font-semibold text-brown">{seats}</span>
        {' '}={' '}
        <span className="font-semibold text-brown">${subtotal.toLocaleString()}/{interval}</span>
      </div>
    </div>
  );
}
