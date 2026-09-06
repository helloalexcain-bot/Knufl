import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KnuflRealtimeClient,
  completedFunctionCallsFrom,
  type RealtimeClientEvents,
  type VoiceStatus,
} from './realtime-client.ts';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

type ChannelListener = (event: { data?: unknown }) => void;

class FakeDataChannel {
  readyState: RTCDataChannelState = 'connecting';
  readonly sent: string[] = [];
  closeCalls = 0;
  readonly #listeners = new Map<string, ChannelListener[]>();

  addEventListener(type: string, listener: ChannelListener): void {
    const listeners = this.#listeners.get(type) ?? [];
    listeners.push(listener);
    this.#listeners.set(type, listeners);
  }

  emit(type: string, event: { data?: unknown } = {}): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }

  open(): void {
    this.readyState = 'open';
    this.emit('open');
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = 'closed';
    this.emit('close');
  }

  send(value: string): void {
    this.sent.push(value);
  }
}

class FakePeerConnection {
  connectionState: RTCPeerConnectionState = 'new';
  ontrack?: (event: { streams: MediaStream[] }) => void;
  readonly channel = new FakeDataChannel();
  closeCalls = 0;
  remoteDescription?: RTCSessionDescriptionInit;
  readonly createOfferResult: () => Promise<RTCSessionDescriptionInit>;
  readonly setLocalResult: () => Promise<void>;

  constructor(
    createOfferResult: () => Promise<RTCSessionDescriptionInit> = async () => ({ type: 'offer', sdp: 'offer-sdp' }),
    setLocalResult: () => Promise<void> = async () => undefined,
  ) {
    this.createOfferResult = createOfferResult;
    this.setLocalResult = setLocalResult;
  }

  addTrack(): void {}
  addTransceiver(): void {}
  createDataChannel(): RTCDataChannel { return this.channel as unknown as RTCDataChannel; }
  addEventListener(): void {}
  createOffer(): Promise<RTCSessionDescriptionInit> { return this.createOfferResult(); }
  setLocalDescription(): Promise<void> { return this.setLocalResult(); }
  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = description;
  }
  close(): void {
    this.closeCalls += 1;
    this.connectionState = 'closed';
  }
}

const fakeStream = () => {
  const track = {
    enabled: true,
    stopCalls: 0,
    stop() { this.stopCalls += 1; },
  };
  const stream = {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;
  return { stream, track };
};

const replaceGlobal = (name: string, value: unknown): (() => void) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  return () => {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  };
};

const installBrowserMocks = ({
  getUserMedia,
  createPeer,
  fetch: fetchImplementation,
}: {
  getUserMedia: () => Promise<MediaStream>;
  createPeer: () => FakePeerConnection;
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}): (() => void) => {
  const restore = [
    replaceGlobal('navigator', { mediaDevices: { getUserMedia } }),
    replaceGlobal('document', {
      createElement: () => ({
        autoplay: false,
        srcObject: null,
        setAttribute() {},
        pause() {},
      }),
    }),
    replaceGlobal('RTCPeerConnection', function MockRTCPeerConnection() { return createPeer(); }),
    replaceGlobal('fetch', fetchImplementation),
  ];
  return () => restore.reverse().forEach((restoreGlobal) => restoreGlobal());
};

const clientEvents = () => {
  const statuses: VoiceStatus[] = [];
  const errors: string[] = [];
  const events: RealtimeClientEvents = {
    onStatus: (status) => statuses.push(status),
    onAmplitude: () => undefined,
    onTranscript: () => undefined,
    onToolCall: async () => ({}),
    onError: (message) => errors.push(message),
  };
  return { events, statuses, errors };
};

test('playout, not response generation, holds the speaking state; mute does not stop the mouth', async()=>{
  const peer=new FakePeerConnection();
  const restore=installBrowserMocks({getUserMedia:async()=>fakeStream().stream,createPeer:()=>peer,fetch:async()=>new Response('answer-sdp')});
  const {events,statuses}=clientEvents();const client=new KnuflRealtimeClient(events);
  try{
    await client.connect('test');peer.channel.open();
    peer.channel.emit('message',{data:JSON.stringify({type:'output_audio_buffer.started'})});
    await new Promise(r=>setImmediate(r));
    peer.channel.emit('message',{data:JSON.stringify({type:'response.done',response:{status:'completed',output:[]}})});
    await new Promise(r=>setImmediate(r));
    assert.equal(statuses.at(-1),'speaking');client.setMuted(true);assert.equal(statuses.at(-1),'speaking');
    client.interrupt();assert.equal(statuses.at(-1),'mic-off');
    await client.disconnect();
  }finally{restore();}
});

test('an audition opens no microphone and selects a fresh server-checked voice',async()=>{
  const peer=new FakePeerConnection();let microphone=0;const urls:string[]=[];
  const restore=installBrowserMocks({getUserMedia:async()=>{microphone++;return fakeStream().stream;},createPeer:()=>peer,fetch:async(url)=>{urls.push(String(url));return new Response('answer-sdp');}});
  const client=new KnuflRealtimeClient(clientEvents().events);
  try{await client.connect('test',{microphone:false,auditionVoice:'cedar'});peer.channel.open();
    assert.equal(microphone,0);assert.equal(urls[0],'/api/realtime?audition=cedar');
    assert.ok(peer.channel.sent.some(s=>s.includes('Read the audition lines now')));await client.disconnect();
  }finally{restore();}
});

test('old audio ending does not signal a completed turn while the next response is generating', async () => {
  const peer = new FakePeerConnection();
  const restore = installBrowserMocks({getUserMedia: async () => fakeStream().stream,
    createPeer: () => peer, fetch: async () => new Response('answer-sdp')});
  const {events, statuses} = clientEvents();
  const client = new KnuflRealtimeClient(events);
  try {
    await client.connect('test'); peer.channel.open();
    client.sendText('What is my progress?');
    peer.channel.emit('message', {data: JSON.stringify({type:'output_audio_buffer.stopped'})});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(statuses.at(-1), 'thinking');
    await client.disconnect();
  } finally { restore(); }
});

test('a connected peer is not ready for commands until the data channel opens', async () => {
  const peer = new FakePeerConnection();
  const restore = installBrowserMocks({
    getUserMedia: async () => fakeStream().stream,
    createPeer: () => peer,
    fetch: async () => new Response('answer-sdp'),
  });
  const client = new KnuflRealtimeClient(clientEvents().events);
  try {
    await client.connect('test');
    peer.connectionState = 'connected';
    assert.equal(client.connected, false);
    peer.channel.open();
    assert.equal(client.connected, true);
    await client.disconnect();
    assert.equal(client.connected, false);
  } finally { restore(); }
});

test('cancelled and incomplete Realtime responses cannot authorize tools', () => {
  for (const status of ['cancelled', 'incomplete', 'failed']) {
    assert.deepEqual(completedFunctionCallsFrom({
      type: 'response.done',
      response: {
        status,
        output: [{
          type: 'function_call',
          status: 'completed',
          call_id: 'call-1',
          name: 'record_set',
          arguments: '{"reps":8}',
        }],
      },
    }), []);
  }
});

test('only completed function-call output is exposed for execution', () => {
  assert.deepEqual(completedFunctionCallsFrom({
    type: 'response.done',
    response: {
      status: 'completed',
      output: [
        { type: 'message', status: 'completed' },
        { type: 'function_call', status: 'incomplete', call_id: 'call-1', name: 'record_set', arguments: '{"reps":7}' },
        { type: 'function_call', status: 'completed', call_id: 'call-2', name: 'record_set', arguments: '{"reps":8}' },
      ],
    },
  }), [{ callId: 'call-2', name: 'record_set', arguments: { reps: 8 } }]);
});

test('malformed completed function arguments fail closed', () => {
  assert.deepEqual(completedFunctionCallsFrom({
    type: 'response.done',
    response: {
      status: 'completed',
      output: [{ type: 'function_call', status: 'completed', call_id: 'call-1', name: 'record_set', arguments: '{' }],
    },
  }), []);
});

test('disconnect while microphone permission is pending disposes the late stream', async () => {
  const microphone = deferred<MediaStream>();
  const microphoneStarted = deferred<void>();
  const { stream, track } = fakeStream();
  const peers: FakePeerConnection[] = [];
  let fetchCalls = 0;
  const restore = installBrowserMocks({
    getUserMedia: () => {
      microphoneStarted.resolve();
      return microphone.promise;
    },
    createPeer: () => {
      const peer = new FakePeerConnection();
      peers.push(peer);
      return peer;
    },
    fetch: async () => {
      fetchCalls += 1;
      return new Response('answer-sdp');
    },
  });
  const { events, statuses, errors } = clientEvents();
  const client = new KnuflRealtimeClient(events);

  try {
    const connecting = client.connect('user-token');
    await microphoneStarted.promise;
    await client.disconnect();
    microphone.resolve(stream);
    await connecting;

    assert.ok(track.stopCalls >= 1, 'the late microphone track must be stopped');
    assert.equal(peers.length, 0);
    assert.equal(fetchCalls, 0);
    assert.deepEqual(errors, []);
    assert.equal(statuses.includes('listening'), false);
    assert.equal(statuses.includes('error'), false);
  } finally {
    restore();
  }
});

test('disconnect during offer creation closes setup and ignores late channel events', async () => {
  const offer = deferred<RTCSessionDescriptionInit>();
  const offerStarted = deferred<void>();
  const { stream, track } = fakeStream();
  const peers: FakePeerConnection[] = [];
  let fetchCalls = 0;
  const restore = installBrowserMocks({
    getUserMedia: async () => stream,
    createPeer: () => {
      const peer = new FakePeerConnection(() => {
        offerStarted.resolve();
        return offer.promise;
      });
      peers.push(peer);
      return peer;
    },
    fetch: async () => {
      fetchCalls += 1;
      return new Response('answer-sdp');
    },
  });
  const { events, statuses, errors } = clientEvents();
  const client = new KnuflRealtimeClient(events);

  try {
    const connecting = client.connect('user-token');
    await offerStarted.promise;
    await client.disconnect();
    offer.resolve({ type: 'offer', sdp: 'late-offer-sdp' });
    await connecting;
    peers[0]?.channel.open();

    assert.ok(track.stopCalls >= 1);
    assert.ok((peers[0]?.closeCalls ?? 0) >= 1);
    assert.equal(fetchCalls, 0);
    assert.deepEqual(errors, []);
    assert.equal(statuses.includes('listening'), false);
    assert.equal(statuses.includes('error'), false);
  } finally {
    restore();
  }
});

test('disconnect aborts an in-flight SDP request without surfacing an error', async () => {
  const requestStarted = deferred<void>();
  const { stream, track } = fakeStream();
  const peers: FakePeerConnection[] = [];
  let requestSignal: AbortSignal | undefined;
  const restore = installBrowserMocks({
    getUserMedia: async () => stream,
    createPeer: () => {
      const peer = new FakePeerConnection();
      peers.push(peer);
      return peer;
    },
    fetch: async (_input, init) => {
      requestSignal = init?.signal ?? undefined;
      requestStarted.resolve();
      return await new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
        if (requestSignal?.aborted) abort();
        else requestSignal?.addEventListener('abort', abort, { once: true });
      });
    },
  });
  const { events, statuses, errors } = clientEvents();
  const client = new KnuflRealtimeClient(events);

  try {
    const connecting = client.connect('user-token');
    await requestStarted.promise;
    await client.disconnect();
    await connecting;
    peers[0]?.channel.open();

    assert.equal(requestSignal?.aborted, true);
    assert.ok(track.stopCalls >= 1);
    assert.ok((peers[0]?.closeCalls ?? 0) >= 1);
    assert.deepEqual(errors, []);
    assert.equal(statuses.includes('listening'), false);
    assert.equal(statuses.includes('error'), false);
  } finally {
    restore();
  }
});

test('a successful connection still reaches listening and closes its server session', async () => {
  const { stream, track } = fakeStream();
  const peers: FakePeerConnection[] = [];
  const fetchPaths: string[] = [];
  const restore = installBrowserMocks({
    getUserMedia: async () => stream,
    createPeer: () => {
      const peer = new FakePeerConnection();
      peers.push(peer);
      return peer;
    },
    fetch: async (input) => {
      fetchPaths.push(String(input));
      if (String(input) === '/api/realtime/close') return new Response(null, { status: 204 });
      return new Response('answer-sdp', {
        status: 200,
        headers: { 'X-Knufl-Voice-Session': 'voice-session-1' },
      });
    },
  });
  const { events, statuses, errors } = clientEvents();
  const client = new KnuflRealtimeClient(events);

  try {
    await client.connect('user-token');
    peers[0]?.channel.open();

    assert.deepEqual(peers[0]?.remoteDescription, { type: 'answer', sdp: 'answer-sdp' });
    assert.equal(statuses.includes('connecting'), true);
    assert.equal(statuses.includes('listening'), true);
    assert.deepEqual(errors, []);

    await client.disconnect();
    assert.ok(track.stopCalls >= 1);
    assert.deepEqual(fetchPaths, ['/api/realtime', '/api/realtime/close']);
  } finally {
    restore();
  }
});

test('interrupt invalidates a slow tool result before it can request more speech', async () => {
  const { stream } = fakeStream();
  const peers: FakePeerConnection[] = [];
  const toolStarted = deferred<void>();
  const toolCompletion = deferred<unknown>();
  const restore = installBrowserMocks({
    getUserMedia: async () => stream,
    createPeer: () => {
      const peer = new FakePeerConnection();
      peers.push(peer);
      return peer;
    },
    fetch: async () => new Response('answer-sdp'),
  });
  const { events, statuses, errors } = clientEvents();
  events.onToolCall = async () => {
    toolStarted.resolve();
    return await toolCompletion.promise;
  };
  const client = new KnuflRealtimeClient(events);

  try {
    await client.connect('user-token');
    const peer = peers[0];
    assert.ok(peer);
    peer.connectionState = 'connected';
    peer.channel.open();
    peer.channel.emit('message', {
      data: JSON.stringify({
        type: 'response.done',
        response: {
          status: 'completed',
          output: [{
            type: 'function_call',
            status: 'completed',
            call_id: 'slow-call',
            name: 'record_set',
            arguments: '{"reps":8}',
          }],
        },
      }),
    });
    await toolStarted.promise;

    client.interrupt();
    toolCompletion.resolve({ ok: true, message: 'Set saved.' });
    await new Promise<void>((resolve) => setImmediate(resolve));

    const sentTypes = peer.channel.sent.map((value) => (JSON.parse(value) as { type: string }).type);
    assert.deepEqual(sentTypes, ['output_audio_buffer.clear'], 'the completed tool response needs no invalid generation cancellation');
    assert.equal(sentTypes.includes('conversation.item.create'), false);
    assert.equal(sentTypes.filter((type) => type === 'response.create').length, 0);
    assert.equal(statuses.at(-1), 'listening');
    assert.deepEqual(errors, []);
  } finally {
    await client.disconnect();
    restore();
  }
});

test('a rapid second connect supersedes a pending first connect on the same client', async () => {
  const firstMicrophone = deferred<MediaStream>();
  const firstMicrophoneStarted = deferred<void>();
  const first = fakeStream();
  const second = fakeStream();
  const peers: FakePeerConnection[] = [];
  let microphoneCalls = 0;
  let realtimeCalls = 0;
  const restore = installBrowserMocks({
    getUserMedia: () => {
      microphoneCalls += 1;
      if (microphoneCalls === 1) {
        firstMicrophoneStarted.resolve();
        return firstMicrophone.promise;
      }
      return Promise.resolve(second.stream);
    },
    createPeer: () => {
      const peer = new FakePeerConnection();
      peers.push(peer);
      return peer;
    },
    fetch: async () => {
      realtimeCalls += 1;
      return new Response('answer-sdp');
    },
  });
  const { events, statuses, errors } = clientEvents();
  const client = new KnuflRealtimeClient(events);

  try {
    const firstConnection = client.connect('first-token');
    await firstMicrophoneStarted.promise;
    const secondConnection = client.connect('second-token');
    await secondConnection;

    firstMicrophone.resolve(first.stream);
    await firstConnection;

    assert.equal(microphoneCalls, 2);
    assert.equal(peers.length, 1);
    assert.equal(realtimeCalls, 1);
    assert.ok(first.track.stopCalls >= 1);
    assert.equal(second.track.stopCalls, 0);

    peers[0]?.channel.open();
    assert.equal(statuses.filter((status) => status === 'listening').length, 1);
    assert.deepEqual(errors, []);

    await client.disconnect();
    assert.ok(second.track.stopCalls >= 1);
  } finally {
    restore();
  }
});
