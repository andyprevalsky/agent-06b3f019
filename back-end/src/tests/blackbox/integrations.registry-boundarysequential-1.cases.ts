import {
  testBoundary_createNoOutbound,
  testBoundary_emailStartNoOutbound,
  testBoundary_validationNoOutbound,
  testBoundary_emailMessagesValidationNoOutbound,
  testBoundary_passwordsRequestSms,
  testBoundary_whatsappConnectNoOutbound,
  testBoundary_telegramConnectNoOutbound,
} from './integrations.lifecycle-boundaries-1.cases';

export function boundarySequentialTestsPart1() {
  return [
    { name: 'boundary -- create makes no outbound calls', fn: testBoundary_createNoOutbound },
    {
      name: 'boundary -- email/start makes no outbound calls',
      fn: testBoundary_emailStartNoOutbound,
    },
    {
      name: 'boundary -- validation failure makes no outbound calls',
      fn: testBoundary_validationNoOutbound,
    },
    {
      name: 'boundary -- email/messages validation no outbound',
      fn: testBoundary_emailMessagesValidationNoOutbound,
    },
    { name: 'boundary -- passwords/request SMS boundary', fn: testBoundary_passwordsRequestSms },
    {
      name: 'boundary -- whatsapp/connect no outbound',
      fn: testBoundary_whatsappConnectNoOutbound,
    },
    {
      name: 'boundary -- telegram/connect no outbound',
      fn: testBoundary_telegramConnectNoOutbound,
    },
  ];
}
