export const CHARACTER_STATES = [
  'idle',
  'greeting',
  'listening',
  'thinking',
  'speaking',
  'ready',
  'resting',
  'celebrating',
  'comforting',
  'farewell',
] as const;

export type CharacterState = (typeof CHARACTER_STATES)[number];

export const CHARACTER_VISEMES = [
  'sil',
  'PP',
  'FF',
  'TH',
  'DD',
  'kk',
  'CH',
  'SS',
  'nn',
  'RR',
  'aa',
  'E',
  'ih',
  'oh',
  'ou',
] as const;

export type CharacterViseme = (typeof CHARACTER_VISEMES)[number];

export const CHARACTER_GESTURES = [
  'idle-breathe',
  'idle-weight-shift',
  'idle-self-check',
  'greeting-wave',
  'greeting-paw-to-heart',
  'listening-head-tilt',
  'listening-small-nod',
  'thinking-paw-to-chin',
  'thinking-small-wobble',
  'speaking-conversational-paw',
  'speaking-small-nod',
  'ready-paw-tap',
  'ready-settle',
  'resting-breathe',
  'resting-timer-glance',
  'celebrating-paw-tap',
  'celebrating-little-mountain',
  'comforting-paw-to-heart',
  'comforting-gentle-nod',
  'farewell-wave',
  'farewell-small-bow',
  'interrupt-settle',
  'reconnect-attentive',
  'reduced-settle',
  'reduced-emphasis',
] as const;

export type CharacterGesture = (typeof CHARACTER_GESTURES)[number];
export type CharacterConnectionState =
  | 'offline'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'error';
export type CharacterMotionMode = 'full' | 'reduced';

export interface CharacterGaze {
  /** -1 looks fully left; 1 looks fully right. */
  horizontal: number;
  /** -1 looks fully down; 1 looks fully up. */
  vertical: number;
}

export interface CharacterGestureCue {
  id: string;
  name: CharacterGesture;
  startedAt: number;
  durationMs: number;
  intensity: number;
  source: 'state' | 'event' | 'recovery';
}

export interface CharacterControllerError {
  code: string;
  message: string;
  retryable: boolean;
  at: number;
}

export interface CharacterControllerSnapshot {
  state: CharacterState;
  connection: CharacterConnectionState;
  motionMode: CharacterMotionMode;
  gaze: CharacterGaze;
  speechAmplitude: number;
  visemes: Partial<Record<CharacterViseme, number>>;
  energy: number;
  gesture?: CharacterGestureCue;
  /** Increments only when a state is entered, including the initial idle state. */
  stateEntryCounts: Record<CharacterState, number>;
  /** Operation keys make achievement/tool retries animation-idempotent. */
  handledGestureOperationKeys: string[];
  interruptedAt?: number;
  lastError?: CharacterControllerError;
  reconnectAttempt: number;
  updatedAt: number;
  revision: number;
}

type TimedEvent = { at?: number };

export type CharacterControllerEvent = TimedEvent &
  (
    | { type: 'state.changed'; state: CharacterState }
    | { type: 'gaze.changed'; horizontal: number; vertical: number }
    | { type: 'energy.changed'; value: number }
    | { type: 'speech.amplitude'; value: number }
    | { type: 'speech.visemes'; weights: Partial<Record<CharacterViseme, number>> }
    | {
        type: 'gesture.triggered';
        gesture: CharacterGesture;
        operationKey: string;
        intensity?: number;
      }
    | { type: 'conversation.interrupted' }
    | { type: 'connection.connecting' }
    | { type: 'connection.connected' }
    | { type: 'connection.reconnecting'; attempt: number }
    | {
        type: 'connection.failed';
        code: string;
        message: string;
        retryable: boolean;
      }
    | { type: 'connection.offline' }
    | { type: 'motion.preference'; reduced: boolean }
    | { type: 'clock.tick' }
  );

export type CharacterControllerListener = (
  snapshot: Readonly<CharacterControllerSnapshot>,
  event: Readonly<CharacterControllerEvent>,
) => void;

const STATE_GESTURES: Record<CharacterState, readonly CharacterGesture[]> = {
  idle: ['idle-breathe', 'idle-weight-shift', 'idle-self-check'],
  greeting: ['greeting-wave', 'greeting-paw-to-heart'],
  listening: ['listening-head-tilt', 'listening-small-nod'],
  thinking: ['thinking-paw-to-chin', 'thinking-small-wobble'],
  speaking: ['speaking-conversational-paw', 'speaking-small-nod'],
  ready: ['ready-paw-tap', 'ready-settle'],
  resting: ['resting-breathe', 'resting-timer-glance'],
  celebrating: ['celebrating-paw-tap', 'celebrating-little-mountain'],
  comforting: ['comforting-paw-to-heart', 'comforting-gentle-nod'],
  farewell: ['farewell-wave', 'farewell-small-bow'],
};

const GESTURE_DURATIONS: Record<CharacterGesture, number> = {
  'idle-breathe': 2_400,
  'idle-weight-shift': 1_600,
  'idle-self-check': 1_400,
  'greeting-wave': 1_600,
  'greeting-paw-to-heart': 1_200,
  'listening-head-tilt': 900,
  'listening-small-nod': 700,
  'thinking-paw-to-chin': 1_300,
  'thinking-small-wobble': 1_000,
  'speaking-conversational-paw': 1_200,
  'speaking-small-nod': 700,
  'ready-paw-tap': 1_000,
  'ready-settle': 800,
  'resting-breathe': 2_400,
  'resting-timer-glance': 900,
  'celebrating-paw-tap': 1_400,
  'celebrating-little-mountain': 2_400,
  'comforting-paw-to-heart': 1_200,
  'comforting-gentle-nod': 800,
  'farewell-wave': 1_400,
  'farewell-small-bow': 1_000,
  'interrupt-settle': 240,
  'reconnect-attentive': 700,
  'reduced-settle': 180,
  'reduced-emphasis': 280,
};

const EMPTY_STATE_ENTRY_COUNTS = (): Record<CharacterState, number> => ({
  idle: 0,
  greeting: 0,
  listening: 0,
  thinking: 0,
  speaking: 0,
  ready: 0,
  resting: 0,
  celebrating: 0,
  comforting: 0,
  farewell: 0,
});

const clamp = (value: number, minimum = 0, maximum = 1): number => {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
};

const cue = (
  name: CharacterGesture,
  at: number,
  id: string,
  source: CharacterGestureCue['source'],
  intensity = 1,
): CharacterGestureCue => ({
  id,
  name,
  startedAt: at,
  durationMs: GESTURE_DURATIONS[name],
  intensity: clamp(intensity),
  source,
});

const stateCue = (
  state: CharacterState,
  entry: number,
  at: number,
  motionMode: CharacterMotionMode,
): CharacterGestureCue => {
  if (motionMode === 'reduced') {
    return cue('reduced-settle', at, `state:${state}:${entry}:reduced`, 'state', 0.12);
  }

  const choices = STATE_GESTURES[state];
  const name = choices[(entry - 1) % choices.length];
  return cue(name, at, `state:${state}:${entry}`, 'state');
};

const stopSpeech = (
  snapshot: CharacterControllerSnapshot,
): Pick<CharacterControllerSnapshot, 'speechAmplitude' | 'visemes'> =>
  snapshot.speechAmplitude === 0 && Object.keys(snapshot.visemes).length === 0
    ? { speechAmplitude: snapshot.speechAmplitude, visemes: snapshot.visemes }
    : { speechAmplitude: 0, visemes: {} };

const commit = (
  snapshot: CharacterControllerSnapshot,
  at: number,
  updates: Partial<CharacterControllerSnapshot>,
): CharacterControllerSnapshot => ({
  ...snapshot,
  ...updates,
  updatedAt: at,
  revision: snapshot.revision + 1,
});

const enterState = (
  snapshot: CharacterControllerSnapshot,
  state: CharacterState,
  at: number,
  additional: Partial<CharacterControllerSnapshot> = {},
): CharacterControllerSnapshot => {
  const entry = snapshot.stateEntryCounts[state] + 1;
  const stateEntryCounts = { ...snapshot.stateEntryCounts, [state]: entry };

  return commit(snapshot, at, {
    state,
    stateEntryCounts,
    gesture: stateCue(state, entry, at, snapshot.motionMode),
    ...(state === 'speaking' ? {} : stopSpeech(snapshot)),
    ...additional,
  });
};

export const createInitialCharacterSnapshot = (
  options: { reducedMotion?: boolean; at?: number } = {},
): CharacterControllerSnapshot => {
  const at = options.at ?? 0;
  const stateEntryCounts = EMPTY_STATE_ENTRY_COUNTS();
  stateEntryCounts.idle = 1;
  const motionMode = options.reducedMotion ? 'reduced' : 'full';

  return {
    state: 'idle',
    connection: 'offline',
    motionMode,
    gaze: { horizontal: 0, vertical: 0 },
    speechAmplitude: 0,
    visemes: {},
    energy: 0.5,
    gesture: stateCue('idle', 1, at, motionMode),
    stateEntryCounts,
    handledGestureOperationKeys: [],
    reconnectAttempt: 0,
    updatedAt: at,
    revision: 0,
  };
};

/**
 * Pure renderer/provider-independent state transition. Supplying event.at makes
 * recordings replay exactly; CharacterController stamps events with its clock.
 */
export const reduceCharacterController = (
  snapshot: CharacterControllerSnapshot,
  event: CharacterControllerEvent,
): CharacterControllerSnapshot => {
  const at = event.at ?? snapshot.updatedAt;

  switch (event.type) {
    case 'state.changed':
      return event.state === snapshot.state ? snapshot : enterState(snapshot, event.state, at);

    case 'gaze.changed': {
      const gaze = {
        horizontal: clamp(event.horizontal, -1, 1),
        vertical: clamp(event.vertical, -1, 1),
      };
      if (
        gaze.horizontal === snapshot.gaze.horizontal &&
        gaze.vertical === snapshot.gaze.vertical
      ) {
        return snapshot;
      }
      return commit(snapshot, at, { gaze });
    }

    case 'energy.changed': {
      const energy = clamp(event.value);
      return energy === snapshot.energy ? snapshot : commit(snapshot, at, { energy });
    }

    case 'speech.amplitude': {
      const speechAmplitude = snapshot.state === 'speaking' ? clamp(event.value) : 0;
      return speechAmplitude === snapshot.speechAmplitude
        ? snapshot
        : commit(snapshot, at, { speechAmplitude });
    }

    case 'speech.visemes': {
      if (snapshot.state !== 'speaking') return snapshot;
      const visemes = Object.fromEntries(
        Object.entries(event.weights)
          .filter((entry): entry is [CharacterViseme, number] =>
            CHARACTER_VISEMES.includes(entry[0] as CharacterViseme),
          )
          .map(([name, weight]) => [name, clamp(weight)]),
      ) as Partial<Record<CharacterViseme, number>>;
      return commit(snapshot, at, { visemes });
    }

    case 'gesture.triggered': {
      if (snapshot.handledGestureOperationKeys.includes(event.operationKey)) return snapshot;
      const handledGestureOperationKeys = [
        ...snapshot.handledGestureOperationKeys.slice(-127),
        event.operationKey,
      ];
      const reduced = snapshot.motionMode === 'reduced';
      const gesture = cue(
        reduced ? 'reduced-emphasis' : event.gesture,
        at,
        `event:${event.operationKey}`,
        'event',
        reduced ? 0.14 : (event.intensity ?? 1),
      );
      return commit(snapshot, at, { gesture, handledGestureOperationKeys });
    }

    case 'conversation.interrupted':
      return enterState(snapshot, 'listening', at, {
        interruptedAt: at,
        gesture: cue('interrupt-settle', at, `interrupt:${at}`, 'recovery', 0.25),
        ...stopSpeech(snapshot),
      });

    case 'connection.connecting':
      return commit(snapshot, at, {
        connection: 'connecting',
        lastError: undefined,
        reconnectAttempt: 0,
      });

    case 'connection.connected': {
      const needsRecovery =
        snapshot.connection === 'reconnecting' || snapshot.connection === 'error';
      if (!needsRecovery) {
        return commit(snapshot, at, {
          connection: 'connected',
          lastError: undefined,
          reconnectAttempt: 0,
        });
      }
      return enterState(snapshot, 'ready', at, {
        connection: 'connected',
        lastError: undefined,
        reconnectAttempt: 0,
        gesture: cue(
          snapshot.motionMode === 'reduced' ? 'reduced-settle' : 'reconnect-attentive',
          at,
          `reconnected:${at}`,
          'recovery',
          snapshot.motionMode === 'reduced' ? 0.12 : 0.5,
        ),
      });
    }

    case 'connection.reconnecting':
      return enterState(snapshot, 'ready', at, {
        connection: 'reconnecting',
        reconnectAttempt: Math.max(1, Math.trunc(event.attempt)),
        gesture: cue(
          snapshot.motionMode === 'reduced' ? 'reduced-settle' : 'reconnect-attentive',
          at,
          `reconnecting:${Math.max(1, Math.trunc(event.attempt))}:${at}`,
          'recovery',
          snapshot.motionMode === 'reduced' ? 0.12 : 0.5,
        ),
        ...stopSpeech(snapshot),
      });

    case 'connection.failed':
      return enterState(snapshot, event.retryable ? 'ready' : 'comforting', at, {
        connection: 'error',
        lastError: {
          code: event.code,
          message: event.message,
          retryable: event.retryable,
          at,
        },
        gesture: cue(
          snapshot.motionMode === 'reduced'
            ? 'reduced-settle'
            : event.retryable
              ? 'reconnect-attentive'
              : 'comforting-gentle-nod',
          at,
          `error:${event.code}:${at}`,
          'recovery',
          snapshot.motionMode === 'reduced' ? 0.12 : 0.45,
        ),
        ...stopSpeech(snapshot),
      });

    case 'connection.offline':
      return enterState(snapshot, 'idle', at, {
        connection: 'offline',
        reconnectAttempt: 0,
        ...stopSpeech(snapshot),
      });

    case 'motion.preference': {
      const motionMode: CharacterMotionMode = event.reduced ? 'reduced' : 'full';
      if (motionMode === snapshot.motionMode) return snapshot;
      const currentEntry = Math.max(1, snapshot.stateEntryCounts[snapshot.state]);
      return commit(snapshot, at, {
        motionMode,
        gesture: stateCue(snapshot.state, currentEntry, at, motionMode),
      });
    }

    case 'clock.tick':
      if (
        !snapshot.gesture ||
        at < snapshot.gesture.startedAt + snapshot.gesture.durationMs
      ) {
        return snapshot;
      }
      return commit(snapshot, at, { gesture: undefined });
  }
};

export class CharacterController {
  #snapshot: CharacterControllerSnapshot;
  #listeners = new Set<CharacterControllerListener>();
  readonly #clock: () => number;

  constructor(options: { reducedMotion?: boolean; clock?: () => number } = {}) {
    this.#clock = options.clock ?? Date.now;
    this.#snapshot = createInitialCharacterSnapshot({
      reducedMotion: options.reducedMotion,
      at: this.#clock(),
    });
  }

  get snapshot(): Readonly<CharacterControllerSnapshot> {
    return this.#snapshot;
  }

  dispatch(event: CharacterControllerEvent): Readonly<CharacterControllerSnapshot> {
    const stampedEvent = event.at === undefined ? { ...event, at: this.#clock() } : event;
    const next = reduceCharacterController(this.#snapshot, stampedEvent);
    if (next === this.#snapshot) return this.#snapshot;

    this.#snapshot = next;
    for (const listener of this.#listeners) listener(this.#snapshot, stampedEvent);
    return this.#snapshot;
  }

  subscribe(listener: CharacterControllerListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
