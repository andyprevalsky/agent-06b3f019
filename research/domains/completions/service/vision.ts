/**
 * Vision transforms
 *
 * Turns the magic `__screenshot_base64__` marker emitted by tool responses into
 * proper multimodal OpenAI-style messages for vision-capable models. Used by
 * the streaming + non-streaming LLM call paths before hitting the provider.
 */

// deno-lint-ignore-file no-explicit-any

import { VISION_CAPABLE_MODELS } from '../config.ts';

export function isVisionCapable(model: string): boolean {
  return VISION_CAPABLE_MODELS.has(model);
}

/** True when any tool message carries a `__screenshot_base64__` payload. */
export function hasScreenshotMarkers(messages: any[]): boolean {
  for (const msg of messages) {
    if (msg.role === 'tool' && typeof msg.content === 'string') {
      if (msg.content.includes('__screenshot_base64__')) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Expand tool-message screenshot markers into a trailing user image_url
 * message. OpenAI/OpenRouter do not accept image_url directly on tool
 * messages, so we keep the cleaned tool message AND append a synthetic user
 * message carrying the image.
 */
export function transformMessagesForVision(messages: any[]): any[] {
  const transformed: any[] = [];

  for (const msg of messages) {
    const isToolMessage = msg.role === 'tool' &&
      typeof msg.content === 'string' &&
      msg.content.includes('__screenshot_base64__');

    if (!isToolMessage) {
      transformed.push(msg);
      continue;
    }

    try {
      const parsed = JSON.parse(msg.content);
      const base64Data = parsed.__screenshot_base64__;
      if (!base64Data) {
        transformed.push(msg);
        continue;
      }

      const toolContent = { ...parsed };
      delete toolContent.__screenshot_base64__;
      toolContent.screenshot_attached = true;

      transformed.push({ ...msg, content: JSON.stringify(toolContent) });
      transformed.push({
        role: 'user',
        content: [
          { type: 'text', text: '[Screenshot from browser]' },
          {
            type: 'image_url',
            image_url: { url: `data:image/png;base64,${base64Data}` },
          },
        ],
      });
    } catch (_e) {
      transformed.push(msg);
    }
  }

  return transformed;
}

/**
 * Select the right messages array for a given model — transformed for vision
 * models, raw for everything else.
 */
export function getMessagesForModel(messages: any[], model: string): any[] {
  if (isVisionCapable(model) && hasScreenshotMarkers(messages)) {
    return transformMessagesForVision(messages);
  }
  return messages;
}
