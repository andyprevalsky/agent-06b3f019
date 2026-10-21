import { afterEach, expect, it } from 'vitest';
import { http, passthrough } from 'msw';
import { server as requestServer } from '../blackbox/msw/server';
import { RealtimeClient } from '@supabase/realtime-js';
import { WebSocket, WebSocketServer } from 'ws';
import { PRODUCTION_API_PREVIEW_DEFINES } from '../../lib/productionApiPreview';
import { shouldUsePrivateRealtimeChannels } from '../../lib/realtimeConfig';

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

it('receives production private broadcasts in the production API preview, even though Vite is DEV', async () => {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.on('listening', resolve));
  const address = server.address();
  if (typeof address === 'string' || address === null)
    throw new Error('Missing local socket address');
  requestServer.use(http.get(`http://127.0.0.1:${address.port}/*`, () => passthrough()));
  const joins: boolean[] = [];
  server.on('connection', (socket) => {
    let joinedPrivate = false;
    socket.on('message', (raw) => {
      const [joinRef, ref, topic, event, payload] = JSON.parse(String(raw));
      const message = { ref, topic, event, payload };
      const send = (event: string, payload: object) =>
        socket.send(JSON.stringify([joinRef, ref, topic, event, payload]));
      if (message.event === 'phx_join') {
        joinedPrivate = message.payload.config.private;
        joins.push(joinedPrivate);
      }
      // Production broadcaster sets private:true. A public listener is a different namespace.
      if (message.event === 'broadcast' && joinedPrivate)
        send('broadcast', { event: 'INSERT', payload: { message_id: 'canonical-new-message' } });
      send('phx_reply', { status: 'ok', response: {} });
    });
  });
  const client = new RealtimeClient(`ws://127.0.0.1:${address.port}/realtime/v1`, {
    transport: WebSocket,
    params: { apikey: 'offline-fixture-key' },
    encode: (message, callback) =>
      callback(
        JSON.stringify([
          message.join_ref,
          message.ref,
          message.topic,
          message.event,
          message.payload,
        ]),
      ),
  });
  cleanup = async () => {
    await client.removeAllChannels();
    client.disconnect();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  const encoded = PRODUCTION_API_PREVIEW_DEFINES['import.meta.env.VITE_REALTIME_PRIVATE'];
  const setting = encoded === undefined ? undefined : JSON.parse(encoded);
  const channel = client.channel('agent:owned-fixture', {
    config: {
      private: shouldUsePrivateRealtimeChannels(setting, true),
      broadcast: { ack: true },
    },
  });
  const messages: string[] = [];
  channel.on('broadcast', { event: 'INSERT' }, (event) => {
    messages.push(event.payload.message_id);
  });
  await new Promise<void>((resolve, reject) =>
    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') resolve();
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') reject(new Error(status));
    }),
  );
  // Server frames are ordered: the INSERT is dispatched before the acknowledgement resolves.
  expect(await channel.send({ type: 'broadcast', event: 'diagnostic-probe', payload: {} })).toBe(
    'ok',
  );
  expect(joins).toEqual([true]);
  expect(messages).toEqual(['canonical-new-message']);
});
