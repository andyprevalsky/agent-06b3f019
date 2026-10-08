import { isAllowedImageSrc } from './isAllowedImageSrc';

export function MarkdownImage({ src, alt }: { src?: string; alt?: string }) {
  if (!isAllowedImageSrc(src)) return null;
  return <img src={src} alt={alt || ''} className="max-w-full h-auto rounded-lg my-2" />;
}
