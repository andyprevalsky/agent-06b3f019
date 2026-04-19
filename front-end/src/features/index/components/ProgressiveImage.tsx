/**
 * STATE MACHINE: ProgressiveImage
 *
 * [LOW_RES] --> lowSrc loaded, src=lowSrc
 *   |
 *   | (medSrc loaded)
 *   v
 * [MED_RES] --> src=medSrc
 *   |
 *   | (highSrc loaded)
 *   v
 * [HIGH_RES] --> src=highSrc
 *
 * State:
 * - src: string (current image source, progresses through quality levels)
 */

import { useProgressiveImageSrc } from '../hooks';
import type { ProgressiveImageProps } from '../types';

const ProgressiveImage: React.FC<ProgressiveImageProps> = ({
  lowSrc,
  medSrc,
  highSrc,
  alt,
  className = '',
  style = {},
  fetchPriority = 'auto',
}) => {
  const currentSrc = useProgressiveImageSrc({ lowSrc, medSrc, highSrc, fetchPriority });

  return (
    <img
      src={currentSrc}
      alt={alt}
      className={`w-full h-full object-cover transition-all duration-500 ease-out ${className}`}
      style={style}
      loading="eager"
      {...({ fetchpriority: fetchPriority } as { fetchpriority: string })}
    />
  );
};

export default ProgressiveImage;
