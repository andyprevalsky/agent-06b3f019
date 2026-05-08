export const DEFAULT_THINKING_ANIMATION_URL = '/thinking_animations.txt';
const DEFAULT_THINKING_ANIMATION_FILE = 'thinking_animations.txt';

const isAbsoluteUrl = (value: string) => /^[a-z][a-z\d+\-.]*:/i.test(value);

export const resolveAnimationUrl = (
  dataUrl: string,
  baseHref = globalThis.location?.href ?? '',
) => {
  if (!baseHref.startsWith('file:')) {
    return dataUrl === `./${DEFAULT_THINKING_ANIMATION_FILE}`
      ? DEFAULT_THINKING_ANIMATION_URL
      : dataUrl;
  }

  if (isAbsoluteUrl(dataUrl)) {
    return dataUrl;
  }

  const fileRelativePath =
    dataUrl === DEFAULT_THINKING_ANIMATION_URL
      ? DEFAULT_THINKING_ANIMATION_FILE
      : dataUrl.replace(/^\//, '');

  return new URL(fileRelativePath, baseHref).toString();
};
