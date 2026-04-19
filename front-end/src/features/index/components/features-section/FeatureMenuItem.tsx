import type { FeatureItem } from '../../types';

interface FeatureMenuItemProps {
  feature: FeatureItem;
  index: number;
  isActive: boolean;
  onSelect: (index: number) => void;
}

/**
 * One entry in the desktop Features menu: a title button that expands
 * into a bullet list when active, with an animated gradient border.
 */
export default function FeatureMenuItem({
  feature,
  index,
  isActive,
  onSelect,
}: FeatureMenuItemProps) {
  return (
    <div className="relative">
      <div className="relative overflow-hidden transition-all duration-500 border-2 border-transparent rounded-lg">
        {isActive && (
          <div className="absolute inset-0 bg-gradient-to-r from-[#FE7503] via-[#FC585C] via-[#FD5776] via-[#E062CC] via-[#A76CED] to-[#7A6BEC] bg-[length:200%_200%] animate-gradient-rotate rounded-lg p-[2px]">
            <div className="w-full h-full bg-background rounded-md"></div>
          </div>
        )}

        <button
          onClick={() => onSelect(index)}
          className={`relative w-full text-left p-4 transition-all duration-500 ${
            isActive
              ? 'text-foreground'
              : 'hover:bg-muted/50 text-muted-foreground hover:text-foreground'
          }`}
        >
          <h4 className="relative font-medium text-sm leading-tight">{feature.title}</h4>
        </button>

        <div
          className={`relative overflow-hidden transition-all duration-700 ease-in-out ${
            isActive ? 'max-h-96 opacity-100 delay-700' : 'max-h-0 opacity-0 delay-0'
          }`}
        >
          <div className="relative px-4 pb-4">
            {feature.details.length > 0 && (
              <ul className="space-y-3">
                {feature.details.map((detail, detailIndex) => (
                  <li key={detailIndex} className="flex items-start space-x-3">
                    <div className="w-1.5 h-1.5 rounded-full mt-2 flex-shrink-0 bg-gradient-to-r from-[#FE7503] via-[#FC585C] via-[#FD5776] via-[#E062CC] via-[#A76CED] to-[#7A6BEC]"></div>
                    <span className="text-sm text-foreground/80 leading-relaxed">{detail}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
