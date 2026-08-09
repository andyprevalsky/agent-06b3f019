/**
 * WhatsApp Webhook Domain Config
 *
 * Constants for Meta WhatsApp Cloud API webhook processing. Secrets are read
 * through the shared provider (`getWhatsAppConfig`); only environment-shape
 * flags live here.
 */

export const IS_PRODUCTION = process.env.NODE_ENV === 'production';
