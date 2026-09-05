'use client';

export type VoiceStatus = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'reconnecting' | 'mic-off' | 'error';

export interface RealtimeToolCall {
  callId: string;
  name: string;
  arguments: unknown;
}

export interface RealtimeClientEvents {
  onStatus: (status: VoiceStatus) => void;
  onAmplitude: (amplitude: number) => void;
  onTranscript: (role: 'user' | 'assistant', text: string) => void;
  onToolCall: (call: RealtimeToolCall) => Promise<unknown>;
  onInterrupted?: () => void;
  onError: (message: string) => void;
}

export interface RealtimeServerEvent {
  type?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  delta?: string;
  transcript?: string;
  error?: { message?: string };
  response?: {
    status?: 'completed' | 'cancelled' | 'failed' | 'incomplete' | string;
    output?: Array<{
      type?: string;
      status?: string;
      call_id?: string;
      name?: string;
      arguments?: string;
      content?: Array<{ transcript?: string; text?: string }>;
    }>;
  };
}

interface RealtimeConnectionAttempt {
  controller: AbortController;
}

const boundedJson = (text: string): unknown => {
  if (text.length > 32_000) throw new Error('The voice action was too large.');
  return text ? JSON.parse(text) : {};
};

/** Only a completed response may authorize a state-changing function call. */
export const completedFunctionCallsFrom = (event: RealtimeServerEvent): RealtimeToolCall[] => {
  if (event.type !== 'response.done' || event.response?.status !== 'completed') return [];
  return (event.response.output ?? []).flatMap((item) => {
    if (item.type !== 'function_call' || item.status !== 'completed' || !item.call_id || !item.name) return [];
    try {
      return [{ callId: item.call_id, name: item.name, arguments: boundedJson(item.arguments || '{}') }];
    } catch {
      return [];
    }
  });
};

export class KnuflRealtimeClient {
  readonly #events: RealtimeClientEvents;
  #peer?: RTCPeerConnection;
  #channel?: RTCDataChannel;
  #stream?: MediaStream;
  #audio?: HTMLAudioElement;
  #audioContext?: AudioContext;
  #amplitudeFrame?: number;
  #muted = false;
  #voiceSessionId?: string;
  #accessToken?: string;
  #executedCallIds = new Set<string>();
  #eventQueue: Promise<void> = Promise.resolve();
  #lastAssistantTranscript = '';
  #expiryTimer?: number;
  #closing = false;
  #turnStartedAt?: number;
  #connectionAttempt?: RealtimeConnectionAttempt;
  #responseGeneration = 0;

  constructor(events: RealtimeClientEvents) {
    this.#events = events;
  }

  get connected(): boolean {
    return this.#peer?.connectionState === 'connected';
  }

  async connect(accessToken: string): Promise<void> {
    const previousAttempt = this.#connectionAttempt;
    const attempt: RealtimeConnectionAttempt = { controller: new AbortController() };
    this.#connectionAttempt = attempt;
    previousAttempt?.controller.abort();
    this.#closing = true;
    await this.#teardownConnection();
    if (!this.#isActiveAttempt(attempt)) return;

    this.#closing = false;
    this.#accessToken = accessToken;
    this.#executedCallIds.clear();
    this.#eventQueue = Promise.resolve();
    this.#responseGeneration += 1;
    this.#events.onStatus('connecting');

    let stream: MediaStream | undefined;
    let peer: RTCPeerConnection | undefined;
    let channel: RTCDataChannel | undefined;
    let audio: HTMLAudioElement | undefined;
    try {
      const acquiredStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      stream = acquiredStream;
      if (!this.#isActiveAttempt(attempt)) {
        this.#disposeLocalConnection(stream, peer, channel, audio);
        return;
      }
      this.#stream = acquiredStream;

      const createdPeer = new RTCPeerConnection();
      peer = createdPeer;
      this.#peer = createdPeer;
      acquiredStream.getAudioTracks().forEach((track) => {
        track.enabled = !this.#muted;
        createdPeer.addTrack(track, acquiredStream);
      });

      const playbackAudio = document.createElement('audio');
      audio = playbackAudio;
      playbackAudio.autoplay = true;
      playbackAudio.setAttribute('aria-hidden', 'true');
      this.#audio = playbackAudio;
      createdPeer.ontrack = (event) => {
        const [remote] = event.streams;
        if (!remote) return;
        if (!this.#isActiveAttempt(attempt)) {
          remote.getTracks().forEach((track) => track.stop());
          return;
        }
        playbackAudio.srcObject = remote;
        this.#startAmplitudeMeter(remote);
      };

      const dataChannel = createdPeer.createDataChannel('oai-events');
      channel = dataChannel;
      this.#channel = dataChannel;
      dataChannel.addEventListener('open', () => {
        if (this.#isActiveAttempt(attempt)) this.#events.onStatus(this.#muted ? 'mic-off' : 'listening');
      });
      dataChannel.addEventListener('message', (event) => {
        this.#eventQueue = this.#eventQueue
          .then(() => this.#isActiveAttempt(attempt) ? this.#handleEvent(String(event.data), attempt, dataChannel) : undefined)
          .catch((error: unknown) => {
            if (this.#isActiveAttempt(attempt)) {
              this.#events.onError(error instanceof Error ? error.message : 'Voice event handling failed.');
            }
          });
      });
      dataChannel.addEventListener('close', () => {
        if (this.#isActiveAttempt(attempt) && !this.#closing && this.#peer === createdPeer) {
          this.#events.onStatus('reconnecting');
        }
      });

      createdPeer.addEventListener('connectionstatechange', () => {
        if (!this.#isActiveAttempt(attempt) || this.#closing || this.#peer !== createdPeer) return;
        if (createdPeer.connectionState === 'failed' || createdPeer.connectionState === 'disconnected') {
          this.#events.onStatus('reconnecting');
        }
        if (createdPeer.connectionState === 'closed') this.#events.onStatus('idle');
      });

      const offer = await createdPeer.createOffer();
      if (!this.#isActiveAttempt(attempt)) {
        this.#disposeLocalConnection(stream, peer, channel, audio);
        return;
      }
      await createdPeer.setLocalDescription(offer);
      if (!this.#isActiveAttempt(attempt)) {
        this.#disposeLocalConnection(stream, peer, channel, audio);
        return;
      }
      if (!offer.sdp) throw new Error('The browser could not create a voice connection.');

      const response = await fetch('/api/realtime', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/sdp',
        },
        body: offer.sdp,
        signal: attempt.controller.signal,
      });
      if (!this.#isActiveAttempt(attempt)) {
        this.#disposeLocalConnection(stream, peer, channel, audio);
        return;
      }
      this.#voiceSessionId = response.headers.get('X-Knufl-Voice-Session') ?? undefined;
      const answerSdp = await response.text();
      if (!this.#isActiveAttempt(attempt)) {
        this.#disposeLocalConnection(stream, peer, channel, audio);
        return;
      }
      if (!response.ok) {
        let message = 'Voice could not connect.';
        try {
          const parsed = JSON.parse(answerSdp) as { error?: string | { message?: string } };
          if (typeof parsed.error === 'string') message = parsed.error;
          else if (parsed.error?.message) message = parsed.error.message;
        } catch {
          // OpenAI SDP failures are deliberately not echoed into the UI.
        }
        throw new Error(message);
      }
      const expiresAt = response.headers.get('X-Knufl-Voice-Expires-At');
      const expiresIn = expiresAt ? Date.parse(expiresAt) - Date.now() : Number.NaN;
      if (Number.isFinite(expiresIn)) {
        this.#expiryTimer = window.setTimeout(() => {
          if (!this.#isActiveAttempt(attempt)) return;
          void this.disconnect().finally(() => {
            if (!this.#connectionAttempt) this.#events.onStatus('idle');
          });
        }, Math.max(0, expiresIn));
      }
      await createdPeer.setRemoteDescription({ type: 'answer', sdp: answerSdp });
      if (!this.#isActiveAttempt(attempt)) {
        this.#disposeLocalConnection(stream, peer, channel, audio);
      }
    } catch (error) {
      if (!this.#isActiveAttempt(attempt) || attempt.controller.signal.aborted) {
        this.#disposeLocalConnection(stream, peer, channel, audio);
        return;
      }
      const message = error instanceof DOMException && error.name === 'NotAllowedError'
        ? 'Microphone access was denied. You can keep using the keyboard.'
        : error instanceof Error ? error.message : 'Voice could not connect.';
      const teardown = this.disconnect();
      this.#events.onStatus('error');
      this.#events.onError(message);
      await teardown;
      throw error;
    }
  }

  setMuted(muted: boolean): void {
    this.#muted = muted;
    this.#stream?.getAudioTracks().forEach((track) => { track.enabled = !muted; });
    this.#events.onStatus(muted ? 'mic-off' : this.connected ? 'listening' : 'idle');
  }

  sendText(text: string): void {
    const value = text.trim();
    if (!value || this.#channel?.readyState !== 'open') return;
    this.#events.onTranscript('user', value);
    this.#lastAssistantTranscript = '';
    this.#turnStartedAt = performance.now();
    this.#responseGeneration += 1;
    this.#channel.send(JSON.stringify({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: value }] },
    }));
    this.#channel.send(JSON.stringify({ type: 'response.create' }));
    this.#events.onStatus('thinking');
  }

  interrupt(): void {
    this.#responseGeneration += 1;
    if (this.#channel?.readyState === 'open') {
      this.#channel.send(JSON.stringify({ type: 'response.cancel' }));
      this.#channel.send(JSON.stringify({ type: 'output_audio_buffer.clear' }));
    }
    this.#events.onInterrupted?.();
    this.#turnStartedAt = undefined;
    this.#events.onAmplitude(0);
    this.#events.onStatus(this.#muted ? 'mic-off' : this.connected ? 'listening' : 'idle');
  }

  async disconnect(): Promise<void> {
    this.#responseGeneration += 1;
    const attempt = this.#connectionAttempt;
    this.#connectionAttempt = undefined;
    attempt?.controller.abort();
    this.#closing = true;
    await this.#teardownConnection();
  }

  async #teardownConnection(): Promise<void> {
    const voiceSessionId = this.#voiceSessionId;
    const accessToken = this.#accessToken;
    this.#voiceSessionId = undefined;
    this.#accessToken = undefined;
    this.#turnStartedAt = undefined;
    if (this.#expiryTimer !== undefined) window.clearTimeout(this.#expiryTimer);
    this.#expiryTimer = undefined;
    if (this.#amplitudeFrame !== undefined) cancelAnimationFrame(this.#amplitudeFrame);
    this.#amplitudeFrame = undefined;
    this.#audioContext?.close().catch(() => undefined);
    this.#audioContext = undefined;
    this.#audio?.pause();
    if (this.#audio) this.#audio.srcObject = null;
    this.#audio = undefined;
    this.#channel?.close();
    this.#channel = undefined;
    this.#peer?.close();
    this.#peer = undefined;
    this.#stream?.getTracks().forEach((track) => track.stop());
    this.#stream = undefined;
    this.#events.onAmplitude(0);
    if (voiceSessionId && accessToken) {
      await fetch('/api/realtime/close', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ sessionId: voiceSessionId }),
        keepalive: true,
      }).catch(() => undefined);
    }
  }

  async #handleEvent(raw: string, attempt: RealtimeConnectionAttempt, channel: RTCDataChannel): Promise<void> {
    if (!this.#isActiveAttempt(attempt) || this.#channel !== channel) return;
    let event: RealtimeServerEvent;
    try {
      event = boundedJson(raw) as RealtimeServerEvent;
    } catch {
      this.#events.onError('Voice returned an unreadable event.');
      return;
    }

    switch (event.type) {
      case 'input_audio_buffer.speech_started':
        this.#responseGeneration += 1;
        this.#lastAssistantTranscript = '';
        this.#events.onInterrupted?.();
        this.#events.onStatus('listening');
        break;
      case 'input_audio_buffer.speech_stopped':
        this.#turnStartedAt = performance.now();
        this.#events.onStatus('thinking');
        break;
      case 'response.created':
        this.#responseGeneration += 1;
        this.#turnStartedAt ??= performance.now();
        this.#events.onStatus('thinking');
        break;
      case 'output_audio_buffer.started':
        if (this.#turnStartedAt !== undefined) {
          console.info(JSON.stringify({
            event: 'knufl_realtime_first_audio',
            durationMs: Math.max(0, Math.round(performance.now() - this.#turnStartedAt)),
          }));
          this.#turnStartedAt = undefined;
        }
        this.#events.onStatus('speaking');
        break;
      case 'response.output_audio.delta':
        this.#events.onStatus('speaking');
        break;
      case 'output_audio_buffer.stopped':
        this.#events.onStatus(this.#muted ? 'mic-off' : 'listening');
        break;
      case 'response.done':
        this.#events.onStatus(this.#muted ? 'mic-off' : 'listening');
        this.#emitAssistantTranscript(event);
        {
          const responseGeneration = this.#responseGeneration;
          for (const call of completedFunctionCallsFrom(event)) {
            await this.#runTool(call, attempt, channel, responseGeneration);
          }
        }
        break;
      case 'response.audio_transcript.done':
      case 'response.output_audio_transcript.done':
        if (event.transcript?.trim()) this.#emitAssistantText(event.transcript.trim());
        break;
      case 'conversation.item.input_audio_transcription.completed':
        if (event.transcript?.trim()) {
          this.#lastAssistantTranscript = '';
          this.#events.onTranscript('user', event.transcript.trim());
        }
        break;
      case 'response.function_call_arguments.done':
        // This event can arrive for cancelled/incomplete responses. The matching
        // completed response.done output is the mutation authorization boundary.
        break;
      case 'error':
        this.#turnStartedAt = undefined;
        this.#events.onError(event.error?.message || 'The voice session reported an error.');
        break;
      default:
        break;
    }
  }

  async #runTool(
    call: RealtimeToolCall,
    attempt: RealtimeConnectionAttempt,
    channel: RTCDataChannel,
    responseGeneration: number,
  ): Promise<void> {
    if (!this.#isCurrentResponse(attempt, channel, responseGeneration) || this.#executedCallIds.has(call.callId) || channel.readyState !== 'open') return;
    this.#executedCallIds.add(call.callId);
    this.#events.onStatus('thinking');
    let output: unknown;
    try {
      output = await this.#events.onToolCall(call);
    } catch (error) {
      output = { ok: false, error: error instanceof Error ? error.message : 'The action failed.' };
    }
    if (!this.#isCurrentResponse(attempt, channel, responseGeneration) || channel.readyState !== 'open') return;
    channel.send(JSON.stringify({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: call.callId,
        output: JSON.stringify(output),
      },
    }));
    channel.send(JSON.stringify({ type: 'response.create' }));
  }

  #isActiveAttempt(attempt: RealtimeConnectionAttempt): boolean {
    return this.#connectionAttempt === attempt && !attempt.controller.signal.aborted;
  }

  #isCurrentResponse(
    attempt: RealtimeConnectionAttempt,
    channel: RTCDataChannel,
    responseGeneration: number,
  ): boolean {
    return this.#isActiveAttempt(attempt)
      && this.#channel === channel
      && this.#responseGeneration === responseGeneration;
  }

  #disposeLocalConnection(
    stream?: MediaStream,
    peer?: RTCPeerConnection,
    channel?: RTCDataChannel,
    audio?: HTMLAudioElement,
  ): void {
    channel?.close();
    peer?.close();
    stream?.getTracks().forEach((track) => track.stop());
    audio?.pause();
    if (audio) audio.srcObject = null;
  }

  #emitAssistantTranscript(event: RealtimeServerEvent): void {
    const text = event.response?.output
      ?.flatMap((item) => item.content ?? [])
      .map((content) => content.transcript || content.text || '')
      .join(' ')
      .trim();
    if (text) this.#emitAssistantText(text);
  }

  #emitAssistantText(text: string): void {
    if (text === this.#lastAssistantTranscript) return;
    this.#lastAssistantTranscript = text;
    this.#events.onTranscript('assistant', text);
  }

  #startAmplitudeMeter(stream: MediaStream): void {
    const audioContext = new AudioContext();
    this.#audioContext = audioContext;
    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    const samples = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) {
        const centred = (sample - 128) / 128;
        sum += centred * centred;
      }
      this.#events.onAmplitude(Math.min(1, Math.sqrt(sum / samples.length) * 3.2));
      this.#amplitudeFrame = requestAnimationFrame(tick);
    };
    tick();
  }
}
