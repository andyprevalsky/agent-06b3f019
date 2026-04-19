import { useEffect, useState } from 'react';

interface ScrollOffset {
  x: number;
  y: number;
}

export function useScrollOffset(): ScrollOffset {
  const [offset, setOffset] = useState<ScrollOffset>({ x: 0, y: 0 });

  useEffect(() => {
    const handleScroll = () => {
      setOffset((prev) =>
        prev.x === window.scrollX && prev.y === window.scrollY
          ? prev
          : { x: window.scrollX, y: window.scrollY },
      );
    };
    handleScroll();
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  return offset;
}
