interface Swatch {
  hex: string;
  label: string;
  bordered?: boolean;
}

const SWATCHES: Swatch[] = [
  { hex: '#010203', label: 'Midnight Black' },
  { hex: '#F0F0FF', label: 'Pearl White', bordered: true },
];

/** Renders the "Available in 2 colors" swatch row. */
export default function ColorSwatches() {
  return (
    <div className="text-center mt-8 mb-8 reveal-up reveal-delay-2">
      <p className="text-sm text-muted-foreground mb-3">Available in 2 colors</p>
      <div className="flex justify-center space-x-6">
        {SWATCHES.map(({ hex, label, bordered }) => (
          <div key={label} className="group relative flex flex-col items-center">
            <div
              className={`w-3 h-3 rounded-full transition-transform duration-200 hover:scale-140 cursor-pointer ${
                bordered ? 'border border-gray-300' : ''
              }`}
              style={{ backgroundColor: hex }}
              title={label}
            ></div>
            <span className="absolute top-6 text-xs text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity duration-300 whitespace-nowrap">
              {label}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
