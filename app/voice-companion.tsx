'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Session, SupabaseClient } from '@supabase/supabase-js';
import { Brand, Button, Character } from './components';
import { ArticulatedCharacter } from './character-stage';
import { AUDITION_VOICES, type AuditionVoice } from '@/lib/voice-audition';
import {
  CharacterController,
  createInitialCharacterSnapshot,
  type CharacterControllerSnapshot,
} from '@/lib/character-controller';
import {
  currentSession,
  getSupabaseBrowserClient,
  loadPublicAppConfig,
  type PublicAppConfig,
} from '@/lib/cloud-config';
import {
  DEMO_STORAGE_KEY,
  exportDemoState,
  importLegacyFile,
  isDevelopmentDemoExport,
  loadDemoState,
  localDate,
  previewLegacyFile,
  runDemoTool,
  saveDemoState,
  type DemoState,
  type ToolName,
  type ToolResult,
} from '@/lib/demo-engine';
import { interpretManualCommand, type ManualAction } from '@/lib/manual-command';
import {
  clearPendingOperations,
  enqueuePendingOperation,
  markPendingConflict,
  readPendingOperations,
  removePendingOperation,
  type PendingToolOperation,
} from '@/lib/pending-queue';
import { projectPendingToolOperation } from '@/lib/pending-context';
import { KnuflRealtimeClient, type VoiceStatus } from '@/lib/realtime-client';
import { trainingContextFrom, resolvedSetArguments } from '@/lib/training-context';
import { STORAGE_KEY } from '@/lib/storage';
import {
  activeSessionFrom,
  exercisesFrom,
  importConflictCount,
  isCloudAccountExport,
  panelForTool,
  panelFromContract,
  parseCloudImportResponse,
  parseCloudRestorePreview,
  planFrom,
  restTimerFrom,
  setsFrom,
  targetSetToActiveContext,
  type ClientPanelKind,
  type ClientPlanSummary,
} from '@/lib/client-contract';

type AppMode = 'cloud' | 'demo';
type DrawerSection = 'account' | 'plan' | 'history' | 'progress' | 'memories' | 'settings';
type PanelKind = ClientPanelKind;

interface ConversationTurn {
  id: string;
  role: 'user' | 'assistant';
  text: string;
}

interface ImportPreviewState {
  kind: 'legacy' | 'cloud-account';
  alreadyImported: boolean;
  companionName: string;
  sessions: number;
  memories: number;
  milestones: number;
  duplicateSessions: number;
  conflicts: number;
  sourceDigest: string;
  text: string;
}

interface PlannedWorkout {
  title: string;
  exercises: Array<Record<string, unknown>>;
  superset?: boolean;
}

interface MemoryDraft {
  id?: string;
  title: string;
  note: string;
  version?: number;
}

interface AccountOperationScope {
  generation: number;
  identity?: string;
}

interface ImportRequestContext {
  scope: AccountOperationScope;
  requestToken: symbol;
}

class StaleAccountOperationError extends Error {
  constructor() {
    super('The account changed before that action completed.');
    this.name = 'StaleAccountOperationError';
  }
}

const MUTATING_TOOLS = new Set<ToolName>([
  'start_workout', 'select_exercise', 'record_set', 'correct_set', 'undo_last_action',
  'start_rest_timer', 'finish_workout', 'record_cardio',
]);

const TOOL_NAMES = new Set<ToolName>([
  'get_session_context', 'draft_workout', 'start_workout', 'select_exercise', 'record_set', 'correct_set',
  'undo_last_action', 'start_rest_timer', 'get_rest_status', 'finish_workout',
  'record_cardio', 'get_progress', 'show_panel', 'close_panel',
]);

const makeId = (): string => crypto.randomUUID();
const localTimezone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const records = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.map(asRecord).filter((item): item is Record<string, unknown> => Boolean(item)) : [];

const firstRecordAt = (source: Record<string, unknown>, ...keys: string[]): Record<string, unknown> | undefined => {
  for (const key of keys) {
    const direct = asRecord(source[key]);
    if (direct) return direct;
    const first = records(source[key])[0];
    if (first) return first;
  }
  const active = asRecord(source.active);
  if (active) return firstRecordAt(active, ...keys);
  const nested = asRecord(source.context);
  if (nested) return firstRecordAt(nested, ...keys);
  return undefined;
};

const arrayAt = (source: Record<string, unknown>, ...keys: string[]): Record<string, unknown>[] => {
  for (const key of keys) {
    const found = records(source[key]);
    if (found.length) return found;
  }
  const active = asRecord(source.active);
  if (active) return arrayAt(active, ...keys);
  const nested = asRecord(source.context);
  if (nested) return arrayAt(nested, ...keys);
  return [];
};

const stringValue = (source: Record<string, unknown> | undefined, ...keys: string[]): string | undefined => {
  for (const key of keys) {
    if (typeof source?.[key] === 'string' && source[key]) return String(source[key]);
  }
  return undefined;
};

const numberValue = (source: Record<string, unknown> | undefined, ...keys: string[]): number | undefined => {
  for (const key of keys) {
    if (typeof source?.[key] === 'number' && Number.isFinite(source[key])) return Number(source[key]);
  }
  return undefined;
};

const progressPointLabel = (point: Record<string, unknown>, index: number): string => {
  const completedAt = stringValue(point, 'completedAt', 'completed_at');
  const date = completedAt ? completedAt.slice(0, 10) : `result ${index + 1}`;
  const duration = numberValue(point, 'durationSeconds', 'duration_seconds');
  const distance = numberValue(point, 'distance');
  const distanceUnit = stringValue(point, 'distanceUnit', 'distance_unit');
  if (duration !== undefined) {
    const clock = `${Math.floor(duration / 60)}:${String(Math.round(duration % 60)).padStart(2, '0')}`;
    return `${date}: ${distance !== undefined ? `${distance} ${distanceUnit ?? ''} in ` : ''}${clock}`;
  }
  const reps = numberValue(point, 'reps');
  const load = numberValue(point, 'load');
  const loadUnit = stringValue(point, 'loadUnit', 'load_unit');
  return `${date}: ${reps ?? 'unknown'} reps${load !== undefined ? ` at ${load} ${loadUnit ?? ''}` : ' at bodyweight'}`;
};

const milestoneIdsFrom = (source: Record<string, unknown>): Set<string> => new Set(
  (Array.isArray(source.milestones) ? source.milestones : []).flatMap((value) => {
    if (typeof value === 'string' && value) return [value];
    const record = asRecord(value);
    const id = stringValue(record, 'milestoneId', 'milestone_id', 'id');
    return id ? [id] : [];
  }),
);

const hasIdentifier = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const canQueueOperation = (name: ToolName, args: Record<string, unknown>): boolean => {
  if (name === 'start_workout') return Array.isArray(args.exercises) && args.exercises.length > 0;
  if (name === 'record_set') {
    return hasIdentifier(args.sessionId)
      && hasIdentifier(args.exerciseInstanceId)
      && typeof args.reps === 'number';
  }
  if (name === 'correct_set') {
    return hasIdentifier(args.setId) && Number.isInteger(args.expectedVersion);
  }
  if (name === 'start_rest_timer') {
    return hasIdentifier(args.sessionId) && typeof args.durationSeconds === 'number';
  }
  if (name === 'finish_workout') {
    return hasIdentifier(args.sessionId) && Number.isInteger(args.expectedVersion);
  }
  if (name === 'record_cardio') {
    return hasIdentifier(args.activity)
      && typeof args.distance === 'number'
      && typeof args.durationSeconds === 'number';
  }
  return false;
};

const ensureCloudPreferences = async (
  client: SupabaseClient,
  userId: string,
): Promise<void> => {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const { error } = await client.from('preferences').upsert(
    {
      user_id: userId,
      timezone: localTimezone(),
      reduced_motion: reducedMotion,
    },
    { onConflict: 'user_id', ignoreDuplicates: true },
  );
  if (error) throw error;
};

const describeResult = (tool: ToolName, value: Record<string, unknown>): string => {
  for (const key of ['message', 'summary', 'confirmation', 'spokenSummary', 'spoken_summary']) {
    if (typeof value[key] === 'string' && value[key]) return String(value[key]);
  }
  const set = firstRecordAt(value, 'set', 'completedSet', 'completed_set');
  if (tool === 'record_set' && set) {
    const reps = numberValue(set, 'reps');
    const load = numberValue(set, 'load');
    const unit = stringValue(set, 'loadUnit', 'load_unit');
    return `${reps ?? 'Set'}${load !== undefined ? ` at ${load} ${unit ?? ''}` : ' reps'}, saved.`;
  }
  const fallback: Record<ToolName, string> = {
    get_session_context: 'Saved workout context loaded.',
    draft_workout: 'Workout drafted. Nothing has been logged as completed.',
    start_workout: 'Workout started. Ready when you are.',
    select_exercise: 'Active exercise updated.',
    record_set: 'Set saved.',
    correct_set: 'Set corrected.',
    undo_last_action: 'Last action undone.',
    start_rest_timer: 'Rest timer started.',
    get_rest_status: 'Rest timer checked.',
    finish_workout: 'Workout finished and saved.',
    record_cardio: 'Cardio saved.',
    get_progress: 'Saved progress loaded.',
    show_panel: 'Panel opened.',
    close_panel: 'Panel closed.',
  };
  return fallback[tool];
};

class RemoteToolError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

const digestText = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

const downloadJson = (filename: string, value: unknown): void => {
  const content = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const href = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = href;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(href);
};

const statusLabel = (status: VoiceStatus): string => ({
  idle: 'Mic off', connecting: 'Connecting', listening: 'Listening', thinking: 'Thinking',
  speaking: 'Speaking', reconnecting: 'Reconnecting', 'mic-off': 'Mic off', error: 'Mic off',
})[status];

const focusableIn = (container: HTMLElement): HTMLElement[] =>
  [...container.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
  )].filter((element) => element.getClientRects().length > 0);

const containDialogFocus = (
  container: HTMLElement,
  onClose: () => void,
): (() => void) => {
  const returnTarget = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  const frame = window.requestAnimationFrame(() => focusableIn(container)[0]?.focus());
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = focusableIn(container);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  container.addEventListener('keydown', onKeyDown);
  return () => {
    window.cancelAnimationFrame(frame);
    container.removeEventListener('keydown', onKeyDown);
    returnTarget?.focus();
  };
};

export default function VoiceCompanionApp() {
  const [config, setConfig] = useState<PublicAppConfig>();
  const [authChecked, setAuthChecked] = useState(false);
  const [mode, setMode] = useState<AppMode>();
  const [session, setSession] = useState<Session | null>(null);
  const [supabase, setSupabase] = useState<SupabaseClient>();
  const [profileChecked, setProfileChecked] = useState(false);
  const [profileReady, setProfileReady] = useState(false);
  const [profileVersion, setProfileVersion] = useState<number>();
  const [companionName, setCompanionName] = useState('Knufl');
  const [nameDraft, setNameDraft] = useState('Knufl');
  const [nameSaving, setNameSaving] = useState(false);
  const [email, setEmail] = useState('');
  const [emailSent, setEmailSent] = useState(false);
  const [onboardingStep, setOnboardingStep] = useState<'import' | 'name'>('import');
  const [importPreview, setImportPreview] = useState<ImportPreviewState>();
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState('');
  const [demoState, setDemoState] = useState<DemoState>();
  const demoStateRef = useRef<DemoState | undefined>(undefined);
  const [drawer, setDrawer] = useState<DrawerSection>();
  const [panel, setPanel] = useState<PanelKind>(null);
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>('idle');
  const [voiceClientActive, setVoiceClientActive] = useState(false);
  const [micDisclosure, setMicDisclosure] = useState(false);
  const [muted, setMuted] = useState(false);
  const [manualText, setManualText] = useState('');
  const [manualBusy, setManualBusy] = useState(false);
  const [caption, setCaption] = useState('Tap me when you want to talk. I warmed up my enthusiasm.');
  const [, setTurns] = useState<ConversationTurn[]>([]);
  const [toolResult, setToolResult] = useState<ToolResult>();
  const [context, setContext] = useState<Record<string, unknown>>({});
  const contextRef = useRef<Record<string, unknown>>({});
  const [plannedWorkout, setPlannedWorkout] = useState<PlannedWorkout>();
  const plannedWorkoutRef = useRef<PlannedWorkout | undefined>(undefined);
  const [pending, setPending] = useState<PendingToolOperation[]>([]);
  const [restRemaining, setRestRemaining] = useState(0);
  const [notice, setNotice] = useState('');
  const [fatalError, setFatalError] = useState('');
  const [deleteArmed, setDeleteArmed] = useState(false);
  const voiceClientRef = useRef<KnuflRealtimeClient | undefined>(undefined);
  const pushToTalkActiveRef = useRef(false);
  const activeIdentityRef = useRef<string | undefined>(undefined);
  const accountGenerationRef = useRef(0);
  const nameSaveInFlightRef = useRef<symbol | undefined>(undefined);
  const importRequestRef = useRef<symbol | undefined>(undefined);
  const menuDialogRef = useRef<HTMLElement | null>(null);
  const micDialogRef = useRef<HTMLElement | null>(null);
  const importDialogRef = useRef<HTMLElement | null>(null);
  const controllerRef = useRef<CharacterController>(new CharacterController());
  const [character, setCharacter] = useState<CharacterControllerSnapshot>(() => createInitialCharacterSnapshot({ at: Date.now() }));
  const accountId = mode === 'cloud' ? session?.user.id : mode === 'demo' ? 'development-demonstrator' : undefined;
  const drawerOpen = drawer !== undefined;

  const captureAccountScope = useCallback((): AccountOperationScope => ({
    generation: accountGenerationRef.current,
    identity: activeIdentityRef.current,
  }), []);
  const accountScopeIsCurrent = useCallback((scope: AccountOperationScope): boolean => (
    scope.generation === accountGenerationRef.current
    && scope.identity === activeIdentityRef.current
  ), []);
  const requireCurrentAccountScope = useCallback((scope: AccountOperationScope): void => {
    if (!accountScopeIsCurrent(scope)) throw new StaleAccountOperationError();
  }, [accountScopeIsCurrent]);

  const resetAccountBoundState = useCallback(() => {
    accountGenerationRef.current += 1;
    void voiceClientRef.current?.disconnect();
    voiceClientRef.current = undefined;
    pushToTalkActiveRef.current = false;
    nameSaveInFlightRef.current = undefined;
    importRequestRef.current = undefined;
    contextRef.current = {};
    plannedWorkoutRef.current = undefined;
    demoStateRef.current = undefined;
    setContext({});
    setPlannedWorkout(undefined);
    setToolResult(undefined);
    setPanel(null);
    setDrawer(undefined);
    setImportPreview(undefined);
    setImportBusy(false);
    setImportError('');
    setPending([]);
    setRestRemaining(0);
    setDeleteArmed(false);
    setDemoState(undefined);
    setProfileChecked(false);
    setProfileReady(false);
    setProfileVersion(undefined);
    setCompanionName('Knufl');
    setNameDraft('Knufl');
    setNameSaving(false);
    setOnboardingStep('import');
    setNotice('');
    setFatalError('');
    setTurns([]);
    setManualText('');
    setManualBusy(false);
    setVoiceStatus('idle');
    setVoiceClientActive(false);
    setMuted(false);
    setEmailSent(false);
    setEmail('');
    setCaption('Tap me when you want to talk. I warmed up my enthusiasm.');
    controllerRef.current?.dispatch({ type: 'connection.offline' });
  }, []);

  useEffect(() => {
    if (!drawerOpen || !menuDialogRef.current) return;
    return containDialogFocus(menuDialogRef.current, () => setDrawer(undefined));
  }, [drawerOpen]);

  useEffect(() => {
    if (!micDisclosure || !micDialogRef.current) return;
    return containDialogFocus(micDialogRef.current, () => setMicDisclosure(false));
  }, [micDisclosure]);

  useEffect(() => {
    if (!profileReady || !importPreview || !importDialogRef.current) return;
    return containDialogFocus(importDialogRef.current, () => setImportPreview(undefined));
  }, [importPreview, profileReady]);

  useEffect(() => controllerRef.current?.subscribe((snapshot) => setCharacter({ ...snapshot })), []);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => controllerRef.current?.dispatch({ type: 'motion.preference', reduced: media.matches });
    update();
    media.addEventListener('change', update);
    const timer = window.setInterval(() => controllerRef.current?.dispatch({ type: 'clock.tick' }), 250);
    return () => { media.removeEventListener('change', update); window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | undefined;
    void (async () => {
      const loaded = await loadPublicAppConfig();
      if (!active) return;
      setConfig(loaded);
      let client: SupabaseClient | undefined;
      try {
        client = getSupabaseBrowserClient(loaded);
      } catch {
        setConfig({
          ...loaded,
          cloudConfigured: false,
          realtimeConfigured: false,
          providers: { google: false, apple: false, emailOtp: false },
        });
        setFatalError('Cloud sign-in configuration is invalid. The development demonstrator is still available.');
      }
      if (!client) { setAuthChecked(true); return; }
      setSupabase(client);
      try {
        const existing = await currentSession(client);
        if (!active) return;
        const nextIdentity = existing?.user.id;
        if (activeIdentityRef.current !== nextIdentity) resetAccountBoundState();
        activeIdentityRef.current = nextIdentity;
        setSession(existing);
        if (existing) setMode('cloud');
      } catch (error) {
        if (active) setFatalError(error instanceof Error ? error.message : 'Sign-in could not be checked.');
      } finally {
        if (active) setAuthChecked(true);
      }
      const { data } = client.auth.onAuthStateChange((event, nextSession) => {
        if (!nextSession && activeIdentityRef.current === 'development-demonstrator' && event !== 'SIGNED_IN') return;
        const nextIdentity = nextSession?.user.id;
        if (activeIdentityRef.current !== nextIdentity) resetAccountBoundState();
        activeIdentityRef.current = nextIdentity;
        setSession(nextSession);
        setMode(nextSession ? 'cloud' : undefined);
      });
      unsubscribe = () => data.subscription.unsubscribe();
    })();
    return () => { active = false; unsubscribe?.(); };
  }, [resetAccountBoundState]);

  useEffect(() => {
    if (mode !== 'cloud' || !supabase || !session) return;
    let active = true;
    void (async () => {
      try {
        const { data, error } = await supabase.from('profiles').select('companion_name,version').eq('user_id', session.user.id).maybeSingle();
        if (error) throw error;
        if (!active) return;
        if (data?.companion_name) {
          setCompanionName(data.companion_name);
          setNameDraft(data.companion_name);
          setProfileVersion(data.version);
          setProfileReady(true);
          try {
            await ensureCloudPreferences(supabase, session.user.id);
          } catch (preferenceError) {
            if (active) setNotice(preferenceError instanceof Error ? preferenceError.message : 'Cloud preferences will be retried later.');
          }
          if (!active) return;
        } else {
          setOnboardingStep('import');
          setProfileReady(false);
        }
        setPending(readPendingOperations(session.user.id));
      } catch (error) {
        if (active) setFatalError(error instanceof Error ? error.message : 'Cloud profile could not be loaded.');
      } finally {
        if (active) setProfileChecked(true);
      }
    })();
    return () => { active = false; };
  }, [mode, session, supabase]);

  const addTurn = useCallback((role: ConversationTurn['role'], text: string) => {
    if (!text.trim()) return;
    setTurns((current) => [...current.slice(-7), { id: makeId(), role, text: text.trim() }]);
  }, []);

  const rawToolCall = useCallback(async (name: ToolName, args: Record<string, unknown>, operationId: string): Promise<ToolResult> => {
    if (mode === 'demo') {
      const current = demoStateRef.current ?? loadDemoState();
      const output = runDemoTool(current, { name, arguments: args, operationId });
      demoStateRef.current = output.state;
      setDemoState(output.state);
      saveDemoState(output.state);
      return output.result;
    }
    if (!session) throw new RemoteToolError('unauthorized', 'Sign in again before saving workout data.');
    let response: Response;
    try {
      response = await fetch('/api/tools', {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ name, arguments: args }),
      });
    } catch {
      throw new RemoteToolError('network', 'The network is unavailable.');
    }
    const payload: unknown = await response.json().catch(() => null);
    const envelope = asRecord(payload);
    if (!response.ok || envelope?.ok !== true) {
      const error = asRecord(envelope?.error);
      throw new RemoteToolError(stringValue(error, 'code') || `http_${response.status}`, stringValue(error, 'message') || 'The action was not accepted.');
    }
    const value = asRecord(envelope.result) ?? {};
    const directive = asRecord(value.clientDirective);
    const panel = name === 'show_panel'
      ? panelFromContract(directive?.panel)
      : name === 'close_panel'
        ? null
        : panelForTool(name);
    return { ok: true, tool: name, message: describeResult(name, value), data: value, panel, duplicate: value.duplicate === true };
  }, [mode, session]);

  const refreshContext = useCallback(async (): Promise<Record<string, unknown>> => {
    const scope = captureAccountScope();
    const result = await rawToolCall('get_session_context', {}, `context:${makeId()}`);
    requireCurrentAccountScope(scope);
    const next = result.data ?? {};
    contextRef.current = next;
    setContext(next);
    const training = trainingContextFrom(next);
    if (mode === 'cloud') {
      const draft = training.draft;
      plannedWorkoutRef.current = draft ? { title: String(draft.title || 'Training session'), exercises: draft.exercises, superset: draft.superset } : undefined;
      setPlannedWorkout(plannedWorkoutRef.current);
    }
    voiceClientRef.current?.updateTrainingContext(training);
    const timer = restTimerFrom(next);
    const endsAt = stringValue(timer, 'endsAt', 'ends_at');
    setRestRemaining(endsAt ? Math.max(0, Math.ceil((Date.parse(endsAt) - Date.now()) / 1000)) : numberValue(timer, 'remainingSeconds', 'remaining_seconds') ?? 0);
    return next;
  }, [captureAccountScope, mode, rawToolCall, requireCurrentAccountScope]);

  useEffect(() => {
    if (!profileReady || !mode) return;
    // Context is fetched from browser/cloud storage when the active account becomes ready.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshContext().catch((error) => setNotice(error instanceof Error ? error.message : 'Saved context could not be loaded.'));
  }, [mode, profileReady, refreshContext]);

  useEffect(() => {
    if (mode !== 'cloud' || !profileReady) return;
    let running = false;
    const recover = () => {
      if (document.visibilityState !== 'visible' || running) return;
      running = true;
      void refreshContext().catch(() => undefined).finally(() => { running = false; });
    };
    window.addEventListener('focus', recover);
    window.addEventListener('online', recover);
    document.addEventListener('visibilitychange', recover);
    return () => {
      window.removeEventListener('focus', recover);
      window.removeEventListener('online', recover);
      document.removeEventListener('visibilitychange', recover);
    };
  }, [mode, profileReady, refreshContext]);

  useEffect(() => {
    const timer = restTimerFrom(context);
    const endsAt = stringValue(timer, 'endsAt', 'ends_at') || stringValue(toolResult?.data, 'endsAt', 'ends_at');
    if (!endsAt) return;
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((Date.parse(endsAt) - Date.now()) / 1000));
      setRestRemaining(remaining);
      if (remaining === 0 && controllerRef.current?.snapshot.state === 'resting') {
        controllerRef.current.dispatch({ type: 'state.changed', state: 'ready' });
      }
    };
    tick();
    const interval = window.setInterval(tick, 250);
    return () => window.clearInterval(interval);
  }, [context, toolResult]);

  const enrichArguments = useCallback((name: ToolName, supplied: Record<string, unknown>, operationId: string): Record<string, unknown> => {
    let args = { ...supplied };
    const ctx = contextRef.current;
    const sessionRecord = activeSessionFrom(ctx);
    const latestSet = setsFrom(ctx).at(-1);
    const operation = MUTATING_TOOLS.has(name) ? { operationKey: operationId } : {};
    if (name === 'start_workout') return { ...args, ...operation, localDate: localDate(), timezone: localTimezone(), title: args.title ?? plannedWorkoutRef.current?.title ?? 'Training session', exercises: args.exercises ?? plannedWorkoutRef.current?.exercises ?? [], superset: args.superset ?? plannedWorkoutRef.current?.superset ?? false };
    if (name === 'record_set') {
      if (mode === 'cloud') return { ...resolvedSetArguments(args, ctx), ...operation, completedAt: new Date().toISOString() };
      if (args.sameAgain) {
        if (!latestSet) throw new Error('Which completed set should I repeat?');
        const latestExerciseId = stringValue(latestSet, 'exerciseInstanceId', 'exercise_instance_id');
        const latestExercise = exercisesFrom(ctx).find((item) => stringValue(item, 'id') === latestExerciseId);
        if (!latestExerciseId || !latestExercise) {
          throw new Error('Which exercise should I use for “same again”?');
        }
        args.reps = latestSet.reps; args.load = latestSet.load;
        args.loadUnit = latestSet.loadUnit ?? latestSet.load_unit;
        args.loadMode = latestSet.loadMode ?? latestSet.load_mode;
        args.exerciseInstanceId = latestExerciseId;
      }
      delete args.sameAgain;
      const targetedArguments = targetSetToActiveContext(args, ctx);
      if (!targetedArguments) {
        throw new Error(exercisesFrom(ctx).length > 1
          ? 'Which exercise did you complete?'
          : 'Start a workout before logging a set.');
      }
      args = targetedArguments;
      const targetExercise = exercisesFrom(ctx).find((item) => stringValue(item, 'id') === args.exerciseInstanceId);
      return { ...args, ...operation, load: args.load ?? targetExercise?.plannedLoad ?? targetExercise?.planned_load, loadUnit: args.loadUnit ?? targetExercise?.plannedLoadUnit ?? targetExercise?.planned_load_unit, loadMode: args.loadMode ?? targetExercise?.plannedLoadMode ?? targetExercise?.planned_load_mode, completedAt: new Date().toISOString() };
    }
    if (name === 'correct_set') return { ...args, ...operation, setId: args.setId ?? stringValue(latestSet, 'id'), expectedVersion: args.expectedVersion ?? numberValue(latestSet, 'version') };
    if (name === 'undo_last_action') return { ...args, ...operation };
    if (name === 'start_rest_timer') return { ...args, ...operation, sessionId: args.sessionId ?? stringValue(sessionRecord, 'id'), startedAt: new Date().toISOString() };
    if (name === 'finish_workout') return { ...args, ...operation, sessionId: args.sessionId ?? stringValue(sessionRecord, 'id'), expectedVersion: args.expectedVersion ?? numberValue(sessionRecord, 'version'), localDate: stringValue(sessionRecord, 'localDate', 'local_date') ?? localDate(), timezone: stringValue(sessionRecord, 'timezone') ?? localTimezone() };
    if (name === 'record_cardio') {
      const resolvedSessionId = args.sessionId ?? stringValue(sessionRecord, 'id');
      const usesActiveSession = hasIdentifier(resolvedSessionId)
        && resolvedSessionId === stringValue(sessionRecord, 'id');
      return {
      ...args,
      ...operation,
      sessionId: resolvedSessionId,
      localDate: usesActiveSession ? stringValue(sessionRecord, 'localDate', 'local_date') ?? localDate() : localDate(),
      timezone: usesActiveSession ? stringValue(sessionRecord, 'timezone') ?? localTimezone() : localTimezone(),
      completedAt: new Date().toISOString(),
      };
    }
    return { ...args, ...operation };
  }, [mode]);

  const executeTool = useCallback(async (
    name: ToolName,
    supplied: Record<string, unknown>,
    options: { source: 'manual' | 'voice' | 'replay'; operationId?: string } = { source: 'manual' },
  ): Promise<ToolResult> => {
    const scope = captureAccountScope();
    const operationId = options.operationId ?? `${options.source}:${makeId()}`;
    const args = enrichArguments(name, supplied, operationId);
    const milestonesBefore = milestoneIdsFrom(contextRef.current);
    try {
      const result = await rawToolCall(name, args, operationId);
      requireCurrentAccountScope(scope);
      const isPanelDirective = name === 'show_panel' || name === 'close_panel';
      if (!isPanelDirective) setToolResult(result);
      if (isPanelDirective) {
        if (result.panel !== undefined) setPanel(result.panel);
      } else {
        setPanel(result.panel ?? panelForTool(name));
      }
      if (!isPanelDirective) setCaption(result.message);
      if (name === 'draft_workout') {
        const exercises = Array.isArray(args.exercises)
          ? args.exercises.map(asRecord).filter((item): item is Record<string, unknown> => Boolean(item))
          : [];
        const draft = { title: String(args.title || 'Training session'), exercises, superset: args.superset === true };
        plannedWorkoutRef.current = draft;
        setPlannedWorkout(draft);
      }
      if (name === 'record_set' && !result.duplicate) {
        controllerRef.current?.dispatch({ type: 'state.changed', state: 'ready' });
        controllerRef.current?.dispatch({ type: 'gesture.triggered', gesture: 'ready-paw-tap', operationKey: operationId });
      } else if (name === 'start_rest_timer') controllerRef.current?.dispatch({ type: 'state.changed', state: 'resting' });
      const refreshed = MUTATING_TOOLS.has(name) || (name === 'draft_workout' && mode === 'cloud') ? await refreshContext() : undefined;
      if (refreshed && result.data) result.data.trainingContext = trainingContextFrom(refreshed);
      requireCurrentAccountScope(scope);
      if (name === 'finish_workout' && !result.duplicate) {
        const milestonesAfter = milestoneIdsFrom(refreshed ?? result.data ?? {});
        const unlockedLittleMountain = !milestonesBefore.has('little-mountain') && milestonesAfter.has('little-mountain');
        controllerRef.current?.dispatch({ type: 'state.changed', state: 'celebrating' });
        controllerRef.current?.dispatch({
          type: 'gesture.triggered',
          gesture: unlockedLittleMountain ? 'celebrating-little-mountain' : 'celebrating-paw-tap',
          operationKey: operationId,
        });
        if (unlockedLittleMountain) setCaption('Little Mountain unlocked. Steadier than expected; still gloriously wobbly.');
      }
      return result;
    } catch (error) {
      if (error instanceof RemoteToolError && ['network', 'provider_error'].includes(error.code) && mode === 'cloud' && accountId && options.source !== 'replay' && MUTATING_TOOLS.has(name)) {
        if (!canQueueOperation(name, args)) {
          throw new RemoteToolError(
            'dependency_pending',
            name === 'undo_last_action'
              ? 'Undo cannot be queued safely while offline. Reconnect, check the latest saved action, then undo it.'
              : 'That action depends on workout data that has not synced yet. Reconnect, then try it again.',
          );
        }
        let queued: PendingToolOperation[];
        try {
          queued = enqueuePendingOperation(accountId, { id: operationId, name, arguments: args });
        } catch (queueError) {
          const message = queueError instanceof Error
            ? queueError.message
            : 'The offline queue is full. Reconnect before recording another change.';
          setCaption(message);
          controllerRef.current?.dispatch({ type: 'connection.failed', code: 'queue_full', message, retryable: true });
          throw new RemoteToolError('queue_full', message);
        }
        const projectedContext = await projectPendingToolOperation(
          accountId,
          contextRef.current,
          name,
          args,
          operationId,
        );
        requireCurrentAccountScope(scope);
        setPending(queued);
        if (projectedContext !== contextRef.current) {
          contextRef.current = projectedContext;
          setContext(projectedContext);
        }
        const pendingRest = name === 'start_rest_timer'
          ? {
              startedAt: stringValue(args, 'startedAt') ?? new Date().toISOString(),
              endsAt: new Date(
                Date.parse(stringValue(args, 'startedAt') ?? new Date().toISOString())
                  + (numberValue(args, 'durationSeconds') ?? 0) * 1000,
              ).toISOString(),
            }
          : undefined;
        const pendingBaseSet = name === 'correct_set'
          ? setsFrom(contextRef.current).find((item) => stringValue(item, 'id') === stringValue(args, 'setId'))
          : undefined;
        const pendingSet = name === 'record_set'
          ? {
              id: `pending:${operationId}`,
              exercise_instance_id: args.exerciseInstanceId,
              reps: args.reps,
              load: args.load,
              load_unit: args.loadUnit,
              load_mode: args.loadMode,
            }
          : name === 'correct_set' && pendingBaseSet
            ? {
                ...pendingBaseSet,
                reps: args.reps ?? pendingBaseSet.reps,
                load: args.load ?? pendingBaseSet.load,
                load_unit: args.loadUnit ?? pendingBaseSet.load_unit ?? pendingBaseSet.loadUnit,
                load_mode: args.loadMode ?? pendingBaseSet.load_mode ?? pendingBaseSet.loadMode,
              }
            : undefined;
        const pendingResult: ToolResult = {
          ok: false,
          tool: name,
          message: pendingRest
            ? 'Rest is running on this device and queued to sync.'
            : 'Not synced yet. I kept that confirmed action in this account’s pending queue.',
          data: { pending: true, operationId, ...pendingRest, ...(pendingSet ? { set: pendingSet } : {}) },
          panel: panelForTool(name),
        };
        setToolResult(pendingResult); setCaption(pendingResult.message);
        if (pendingRest) {
          setRestRemaining(Math.max(0, Math.ceil((Date.parse(pendingRest.endsAt) - Date.now()) / 1000)));
          controllerRef.current?.dispatch({ type: 'state.changed', state: 'resting' });
        }
        return pendingResult;
      }
      if (error instanceof StaleAccountOperationError) throw error;
      const message = error instanceof Error ? error.message : 'That action did not complete.';
      setCaption(message);
      controllerRef.current?.dispatch({ type: 'connection.failed', code: 'tool', message, retryable: true });
      throw error;
    }
  }, [accountId, captureAccountScope, enrichArguments, mode, rawToolCall, refreshContext, requireCurrentAccountScope]);

  useEffect(() => {
    if (mode !== 'cloud' || !accountId || !session || !pending.some((item) => item.status === 'pending')) return;
    const scope = captureAccountScope();
    const replay = async () => {
      if (!navigator.onLine || !accountScopeIsCurrent(scope)) return;
      for (const operation of readPendingOperations(accountId).filter((item) => item.status === 'pending')) {
        if (!accountScopeIsCurrent(scope)) return;
        if (!canQueueOperation(operation.name, operation.arguments)) {
          setPending(markPendingConflict(accountId, operation.id, 'This queued action is missing a synced workout dependency.'));
          continue;
        }
        try {
          await rawToolCall(operation.name, operation.arguments, operation.id);
          if (!accountScopeIsCurrent(scope)) return;
          setPending(removePendingOperation(accountId, operation.id));
        } catch (error) {
          if (!accountScopeIsCurrent(scope)) return;
          if (error instanceof RemoteToolError && error.code === 'conflict') setPending(markPendingConflict(accountId, operation.id, error.message));
        }
      }
      if (!accountScopeIsCurrent(scope)) return;
      await refreshContext().catch(() => undefined);
    };
    window.addEventListener('online', replay);
    void replay();
    return () => window.removeEventListener('online', replay);
  }, [accountId, accountScopeIsCurrent, captureAccountScope, mode, pending, rawToolCall, refreshContext, session]);

  const runManualAction = useCallback(async (
    action: ManualAction,
    options: { source: 'manual' | 'voice'; operationId?: string } = { source: 'manual' },
  ): Promise<ToolResult> => {
    if (action.name === 'record_set' && !activeSessionFrom(contextRef.current)) {
      if (!plannedWorkoutRef.current) throw new Error('Describe or start a workout before logging a set.');
      const startOperationId = options.operationId ? `${options.operationId}:start` : `${options.source}:${makeId()}`;
      const started = await executeTool(
        'start_workout',
        { title: plannedWorkoutRef.current.title, exercises: plannedWorkoutRef.current.exercises, superset: plannedWorkoutRef.current.superset },
        { source: options.source, operationId: startOperationId },
      );
      const pendingStart = !started.ok && accountId && mode === 'cloud' && asRecord(started.data)?.pending;
      if (!started.ok && !pendingStart) return started;

      const targetedArguments = mode === 'cloud' ? resolvedSetArguments(action.arguments, contextRef.current) : targetSetToActiveContext(action.arguments, contextRef.current);
      if (!targetedArguments) throw new Error('The started workout context could not be recovered.');
      return executeTool(action.name, targetedArguments, options);
    }
    return executeTool(action.name, action.arguments, options);
  }, [accountId, executeTool, mode]);

  const submitManual = useCallback(async (value = manualText) => {
    const text = value.trim();
    if (!text) return;
    if (voiceClientRef.current?.connected) {
      setManualText('');
      voiceClientRef.current.sendText(text);
      return;
    }
    setManualText(''); setManualBusy(true); addTurn('user', text);
    controllerRef.current?.dispatch({ type: 'state.changed', state: 'thinking' });
    const interpretation = interpretManualCommand(text);
    if (interpretation.status !== 'actions') {
      setCaption(interpretation.message); addTurn('assistant', interpretation.message);
      controllerRef.current?.dispatch({ type: 'state.changed', state: interpretation.status === 'conversation' ? 'comforting' : 'ready' });
      setManualBusy(false); return;
    }
    try {
      let latest = '';
      for (const action of interpretation.actions) {
        const result = await runManualAction(action);
        latest = result.message;
        if (!result.ok) break;
      }
      addTurn('assistant', latest); setManualBusy(false);
      if (!['resting', 'celebrating'].includes(controllerRef.current?.snapshot.state ?? '')) controllerRef.current?.dispatch({ type: 'state.changed', state: 'ready' });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'That did not complete.';
      setCaption(message); addTurn('assistant', message); setManualBusy(false);
    }
  }, [addTurn, manualText, runManualAction]);

  const onVoiceStatus = useCallback((status: VoiceStatus) => {
    setVoiceStatus(status);
    if (status === 'connecting') controllerRef.current?.dispatch({ type: 'connection.connecting' });
    if (status === 'listening') { controllerRef.current?.dispatch({ type: 'connection.connected' }); controllerRef.current?.dispatch({ type: 'state.changed', state: 'listening' }); }
    if (status === 'thinking') controllerRef.current?.dispatch({ type: 'state.changed', state: 'thinking' });
    if (status === 'speaking') controllerRef.current?.dispatch({ type: 'state.changed', state: 'speaking' });
    if (status === 'reconnecting') controllerRef.current?.dispatch({ type: 'connection.reconnecting', attempt: 1 });
    if (status === 'mic-off') controllerRef.current?.dispatch({ type: 'state.changed', state: 'ready' });
    if (status === 'idle') controllerRef.current?.dispatch({ type: 'connection.offline' });
    if (status === 'error') controllerRef.current?.dispatch({ type: 'connection.failed', code: 'realtime', message: 'Voice connection failed.', retryable: true });
  }, []);

  const connectVoice = useCallback(async (auditionVoice?: AuditionVoice) => {
    if (voiceClientRef.current) {
      if (!auditionVoice) return;
      await voiceClientRef.current.disconnect();
      voiceClientRef.current = undefined;
    }
    setMicDisclosure(false);
    if (mode !== 'cloud' || !session || !config?.realtimeConfigured) {
      setNotice('Live voice needs the configured Supabase and OpenAI preview. The keyboard demonstrator is ready now.');
      return;
    }
    const client = new KnuflRealtimeClient({
      onStatus: (status) => {
        onVoiceStatus(status);
        if (auditionVoice && status === 'idle') {
          if (voiceClientRef.current === client) { voiceClientRef.current = undefined; setVoiceClientActive(false); }
        }
      },
      onAmplitude: (amplitude) => controllerRef.current?.dispatch({ type: 'speech.amplitude', value: amplitude }),
      onTranscript: (role, text) => { addTurn(role, text); if (role === 'assistant') setCaption(text); },
      onInterrupted: () => controllerRef.current?.dispatch({ type: 'conversation.interrupted' }),
      onToolCall: async (call) => {
        if (!TOOL_NAMES.has(call.name as ToolName)) return { ok: false, error: 'Unknown tool.' };
        const result = await runManualAction(
          { name: call.name as ToolName, arguments: asRecord(call.arguments) ?? {} },
          { source: 'voice', operationId: `voice:${call.callId}` },
        );
        return { ok: result.ok, message: result.message, ...result.data };
      },
      onError: (message) => setNotice(message),
    });
    voiceClientRef.current = client;
    setVoiceClientActive(true);
    client.setMuted(true);
    setMuted(true);
    try {
      await refreshContext();
      await client.connect(session.access_token, auditionVoice ? { auditionVoice, microphone: false } : {});
    } catch {
      if (voiceClientRef.current === client) {
        voiceClientRef.current = undefined;
        setVoiceClientActive(false);
      }
      // The client surfaced a privacy-safe error.
    }
  }, [addTurn, config?.realtimeConfigured, mode, onVoiceStatus, refreshContext, runManualAction, session]);

  useEffect(() => () => { void voiceClientRef.current?.disconnect(); }, []);
  useEffect(() => {
    const failClosedPushToTalk = () => {
      if (!pushToTalkActiveRef.current) return;
      pushToTalkActiveRef.current = false;
      setMuted(true);
      voiceClientRef.current?.setMuted(true);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') failClosedPushToTalk();
    };
    window.addEventListener('blur', failClosedPushToTalk);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('blur', failClosedPushToTalk);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);
  const stopVoice = async () => {
    const scope = captureAccountScope();
    const client = voiceClientRef.current;
    await client?.disconnect();
    if (!accountScopeIsCurrent(scope) || (voiceClientRef.current && voiceClientRef.current !== client)) return;
    voiceClientRef.current = undefined; setVoiceClientActive(false); setMuted(false);
    pushToTalkActiveRef.current = false;
    onVoiceStatus('idle'); setCaption('Mic off. The keyboard stays ready.');
  };

  const beginDemo = () => {
    resetAccountBoundState();
    activeIdentityRef.current = 'development-demonstrator';
    const existing = window.localStorage.getItem(DEMO_STORAGE_KEY);
    const loaded = loadDemoState();
    const recovered = runDemoTool(loaded, {
      name: 'get_session_context',
      arguments: {},
      operationId: `context:${makeId()}`,
    });
    demoStateRef.current = recovered.state;
    setDemoState(recovered.state);
    contextRef.current = recovered.result.data ?? {};
    setContext(recovered.result.data ?? {});
    setMode('demo');
    setCompanionName(loaded.companionName); setNameDraft(loaded.companionName);
    setProfileReady(Boolean(existing)); setProfileChecked(true); setOnboardingStep('import');
    controllerRef.current?.dispatch({ type: 'state.changed', state: 'greeting' });
  };

  const signIn = async (provider: 'google' | 'apple') => {
    if (!supabase) return;
    const redirectTo = new URL(import.meta.env.BASE_URL || '/', window.location.origin).toString();
    const { error } = await supabase.auth.signInWithOAuth({ provider, options: { redirectTo } });
    if (error) setFatalError(error.message);
  };

  const signInWithEmail = async () => {
    if (!supabase || !email.trim()) return;
    const emailRedirectTo = new URL(import.meta.env.BASE_URL || '/', window.location.origin).toString();
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo, shouldCreateUser: true },
    });
    if (error) setFatalError(error.message);
    else setEmailSent(true);
  };

  const saveName = async () => {
    const name = nameDraft.trim();
    if (!name || nameSaveInFlightRef.current) return;
    const scope = captureAccountScope();
    const saveToken = Symbol('name-save');
    nameSaveInFlightRef.current = saveToken;
    setNameSaving(true);
    let savedCloudIdentity: { client: SupabaseClient; userId: string } | undefined;
    try {
      if (mode === 'cloud') {
        if (!supabase || !session) return;
        if (profileVersion === undefined) {
          const { data, error } = await supabase.from('profiles').insert({ user_id: session.user.id, companion_name: name }).select('version').single();
          requireCurrentAccountScope(scope);
          if (error) throw error;
          setProfileVersion(data.version);
        } else {
          const { data, error } = await supabase.from('profiles').update({ companion_name: name }).eq('user_id', session.user.id).eq('version', profileVersion).select('version');
          requireCurrentAccountScope(scope);
          if (error) throw error;
          if (!data?.length) { setNotice('The companion name changed on another device. Refresh before saving.'); return; }
          setProfileVersion(data[0].version);
        }
        savedCloudIdentity = { client: supabase, userId: session.user.id };
      } else {
        const next = { ...(demoStateRef.current ?? loadDemoState()), companionName: name };
        demoStateRef.current = next; setDemoState(next); saveDemoState(next);
      }
      requireCurrentAccountScope(scope);
      setCompanionName(name); setProfileReady(true); setProfileChecked(true);
      setCaption(`Hello, teammate. I’m ${name}. Coordination pending; enthusiasm ready.`);
      controllerRef.current?.dispatch({ type: 'state.changed', state: 'greeting' });
      if (savedCloudIdentity) {
        try {
          await ensureCloudPreferences(savedCloudIdentity.client, savedCloudIdentity.userId);
          requireCurrentAccountScope(scope);
        } catch (error) {
          if (error instanceof StaleAccountOperationError) return;
          if (accountScopeIsCurrent(scope)) {
            setNotice('Name saved. Display preferences will retry the next time this account loads.');
          }
        }
      }
    } catch (error) {
      if (error instanceof StaleAccountOperationError || !accountScopeIsCurrent(scope)) return;
      setFatalError(error instanceof Error ? error.message : 'The companion name could not be saved.');
    } finally {
      if (nameSaveInFlightRef.current === saveToken) {
        nameSaveInFlightRef.current = undefined;
        if (accountScopeIsCurrent(scope)) setNameSaving(false);
      }
    }
  };

  async function prepareImport(text: string, request?: ImportRequestContext): Promise<void> {
    const scope = request?.scope ?? captureAccountScope();
    const requestToken = request?.requestToken ?? Symbol('import-preview');
    importRequestRef.current = requestToken;
    setImportBusy(true); setImportError('');
    try {
      const payload: unknown = JSON.parse(text);
      const sourceDigest = await digestText(text);
      requireCurrentAccountScope(scope);
      if (importRequestRef.current !== requestToken) return;
      if (isDevelopmentDemoExport(payload) && mode === 'cloud') {
        throw new Error('Development demonstrator archives can be restored only in the demonstrator. Export a cloud account archive here for cross-device recovery.');
      }
      if (isCloudAccountExport(payload)) {
        if (mode !== 'cloud' || !supabase) {
          throw new Error('A cloud account archive can only be restored after signing in to a configured cloud preview.');
        }
        const { data, error } = await supabase.rpc('preview_account_restore', {
          p_payload: payload,
          p_source_digest: sourceDigest,
        });
        requireCurrentAccountScope(scope);
        if (importRequestRef.current !== requestToken) return;
        if (error) throw error;
        const preview = parseCloudRestorePreview(data);
        if (!preview.valid || preview.action === 'unknown') {
          throw new Error('That file is not a supported Knufl cloud account archive.');
        }
        setImportPreview({
          kind: 'cloud-account',
          alreadyImported: preview.action === 'duplicate',
          companionName: preview.companionName,
          sessions: preview.sessions,
          memories: preview.memories,
          milestones: preview.milestones,
          duplicateSessions: 0,
          conflicts: preview.conflicts,
          sourceDigest,
          text,
        });
        if (profileReady) setDrawer(undefined);
        return;
      }

      const localPreview = previewLegacyFile(text, demoStateRef.current ?? loadDemoState());
      let conflicts = localPreview.conflicts;
      if (mode === 'cloud' && supabase) {
        const { data, error } = await supabase.rpc('preview_legacy_import', { p_payload: payload, p_source_digest: sourceDigest });
        requireCurrentAccountScope(scope);
        if (importRequestRef.current !== requestToken) return;
        if (error) throw error;
        conflicts = importConflictCount(data);
      }
      setImportPreview({
        kind: 'legacy',
        alreadyImported: false,
        companionName: localPreview.companionName,
        sessions: localPreview.sessions,
        memories: localPreview.memories,
        milestones: localPreview.milestoneIds.length,
        duplicateSessions: localPreview.duplicateSessions,
        sourceDigest,
        text,
        conflicts,
      });
      if (profileReady) setDrawer(undefined);
    } catch (error) {
      if (error instanceof StaleAccountOperationError || !accountScopeIsCurrent(scope) || importRequestRef.current !== requestToken) return;
      setImportPreview(undefined); setImportError(error instanceof Error ? error.message : 'That file is not a valid Knufl export.');
    } finally {
      if (accountScopeIsCurrent(scope) && importRequestRef.current === requestToken) setImportBusy(false);
    }
  }

  const prepareImportFile = (file: File): void => {
    const request: ImportRequestContext = {
      scope: captureAccountScope(),
      requestToken: Symbol('import-file'),
    };
    importRequestRef.current = request.requestToken;
    setImportBusy(true);
    setImportError('');
    void file.text()
      .then((text) => {
        requireCurrentAccountScope(request.scope);
        if (importRequestRef.current !== request.requestToken) return;
        return prepareImport(text, request);
      })
      .catch((error) => {
        if (error instanceof StaleAccountOperationError
          || !accountScopeIsCurrent(request.scope)
          || importRequestRef.current !== request.requestToken) return;
        setImportPreview(undefined);
        setImportError(error instanceof Error ? error.message : 'That file could not be read.');
        setImportBusy(false);
      });
  };

  useEffect(() => {
    if (!accountId || profileReady || onboardingStep !== 'import' || importPreview) return;
    const raw = window.localStorage.getItem(STORAGE_KEY);
    // Legacy progress can only be discovered from the current browser after onboarding opens.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (raw) void prepareImport(raw);
  // prepareImport reads current account state only while onboarding.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, onboardingStep, profileReady]);

  const confirmImport = async () => {
    if (!importPreview) return;
    const scope = captureAccountScope();
    const requestToken = Symbol('import-confirm');
    importRequestRef.current = requestToken;
    setImportBusy(true); setImportError('');
    let restoredCloudIdentity: { client: SupabaseClient; userId: string } | undefined;
    try {
      if (mode === 'cloud') {
        if (!supabase) return;
        const payload: unknown = JSON.parse(importPreview.text);
        const rpcName = importPreview.kind === 'cloud-account'
          ? 'restore_account_data'
          : 'import_legacy_progress';
        const { data, error } = await supabase.rpc(rpcName, {
          p_payload: payload,
          p_source_digest: importPreview.sourceDigest,
        });
        requireCurrentAccountScope(scope);
        if (importRequestRef.current !== requestToken) return;
        if (error) throw error;
        const outcome = parseCloudImportResponse(data);
        if (outcome.status === 'conflict' || outcome.conflictCount > 0) {
          throw new Error('Import stopped because this account already contains different records. Nothing was overwritten.');
        }
        if (!outcome.completed) throw new Error('Import did not return a completed result.');
        const { data: importedProfile, error: profileError } = await supabase.from('profiles').select('companion_name,version').eq('user_id', session?.user.id ?? '').single();
        requireCurrentAccountScope(scope);
        if (importRequestRef.current !== requestToken) return;
        if (profileError) throw profileError;
        if (session) restoredCloudIdentity = { client: supabase, userId: session.user.id };
        setProfileVersion(importedProfile.version);
        setCompanionName(importedProfile.companion_name); setNameDraft(importedProfile.companion_name);
      } else {
        const next = importLegacyFile(importPreview.text, demoStateRef.current ?? loadDemoState());
        demoStateRef.current = next; setDemoState(next); saveDemoState(next);
        setCompanionName(next.companionName); setNameDraft(next.companionName);
      }
      setProfileReady(true); setProfileChecked(true); setImportPreview(undefined);
      setNotice('Existing progress imported. Repeating this import will not duplicate it.');
      if (restoredCloudIdentity) {
        try {
          await ensureCloudPreferences(restoredCloudIdentity.client, restoredCloudIdentity.userId);
          requireCurrentAccountScope(scope);
          if (importRequestRef.current !== requestToken) return;
        } catch {
          if (accountScopeIsCurrent(scope)) {
            setNotice('Existing progress imported. Display preferences will retry the next time this account loads.');
          }
        }
      }
    } catch (error) {
      if (error instanceof StaleAccountOperationError || !accountScopeIsCurrent(scope) || importRequestRef.current !== requestToken) return;
      setImportError(error instanceof Error ? error.message : 'Import did not complete.');
    } finally {
      if (accountScopeIsCurrent(scope) && importRequestRef.current === requestToken) setImportBusy(false);
    }
  };

  const exportAccount = async () => {
    const scope = captureAccountScope();
    try {
      if (mode === 'cloud') {
        if (!supabase) return;
        const { data, error } = await supabase.rpc('export_account_data');
        requireCurrentAccountScope(scope);
        if (error) throw error;
        downloadJson(`knufl-cloud-export-${localDate()}.json`, data);
      } else if (demoState) downloadJson(`knufl-demo-export-${localDate()}.json`, exportDemoState(demoState));
      requireCurrentAccountScope(scope);
      setNotice('Export prepared on this device.');
    } catch (error) {
      if (error instanceof StaleAccountOperationError || !accountScopeIsCurrent(scope)) return;
      setNotice(error instanceof Error ? error.message : 'Export could not be prepared.');
    }
  };

  const saveMemory = async (draft: MemoryDraft) => {
    const scope = captureAccountScope();
    const title = draft.title.trim();
    const note = draft.note.trim();
    if (!title || !note) throw new Error('A memory needs both a title and a note.');
    if (mode === 'cloud') {
      if (!supabase || !session) throw new Error('Sign in again before saving that memory.');
      if (draft.id) {
        const { data, error } = await supabase
          .from('memories')
          .update({ title, note })
          .eq('id', draft.id)
          .eq('version', draft.version ?? 0)
          .eq('editable', true)
          .select('id');
        requireCurrentAccountScope(scope);
        if (error) throw error;
        if (!data?.length) throw new Error('That memory changed on another device. Refresh before editing it.');
      } else {
        const { error } = await supabase.from('memories').insert({
          id: `memory:${makeId()}`,
          user_id: session.user.id,
          title,
          note,
          editable: true,
        });
        requireCurrentAccountScope(scope);
        if (error) throw error;
      }
    } else {
      const current = demoStateRef.current ?? loadDemoState();
      const createdAt = new Date().toISOString();
      const id = draft.id ?? `memory:${makeId()}`;
      const existing = current.legacyMemories.find((memory) => memory.id === id);
      const next: DemoState = {
        ...current,
        legacyMemories: existing
          ? current.legacyMemories.map((memory) => memory.id === id ? { ...memory, title, note } : memory)
          : [...current.legacyMemories, { id, title, note, createdAt }],
      };
      demoStateRef.current = next;
      setDemoState(next);
      saveDemoState(next);
    }
    await refreshContext();
    requireCurrentAccountScope(scope);
    setNotice('Memory saved.');
  };

  const deleteMemory = async (draft: MemoryDraft) => {
    if (!draft.id) return;
    const scope = captureAccountScope();
    if (mode === 'cloud') {
      if (!supabase) throw new Error('Sign in again before deleting that memory.');
      const { data, error } = await supabase
        .from('memories')
        .update({ deleted_at: new Date().toISOString() })
        .eq('id', draft.id)
        .eq('version', draft.version ?? 0)
        .eq('editable', true)
        .select('id');
      requireCurrentAccountScope(scope);
      if (error) throw error;
      if (!data?.length) throw new Error('That memory changed on another device. Refresh before deleting it.');
    } else {
      const current = demoStateRef.current ?? loadDemoState();
      const next = { ...current, legacyMemories: current.legacyMemories.filter((memory) => memory.id !== draft.id) };
      demoStateRef.current = next;
      setDemoState(next);
      saveDemoState(next);
    }
    await refreshContext();
    requireCurrentAccountScope(scope);
    setNotice('Memory deleted.');
  };

  const deleteAccount = async () => {
    const scope = captureAccountScope();
    try {
      await stopVoice();
      requireCurrentAccountScope(scope);
      if (mode === 'cloud') {
        if (!supabase) return;
        const { error } = await supabase.rpc('delete_current_account');
        requireCurrentAccountScope(scope);
        if (error) throw error;
        if (accountId) clearPendingOperations(accountId);
        await supabase.auth.signOut();
        if (!accountScopeIsCurrent(scope)) return;
      } else {
        window.localStorage.removeItem(DEMO_STORAGE_KEY); setMode(undefined); setDemoState(undefined); demoStateRef.current = undefined;
      }
      activeIdentityRef.current = undefined;
      resetAccountBoundState();
      setMode(undefined);
      setSession(null);
    } catch (error) {
      if (error instanceof StaleAccountOperationError || !accountScopeIsCurrent(scope)) return;
      setNotice(error instanceof Error ? error.message : 'Account deletion did not complete.');
    }
  };

  const signOut = async () => {
    const scope = captureAccountScope();
    await stopVoice();
    if (!accountScopeIsCurrent(scope)) return;
    if (mode === 'cloud') {
      await supabase?.auth.signOut({ scope: 'local' });
      if (!accountScopeIsCurrent(scope)) return;
    }
    activeIdentityRef.current = undefined;
    resetAccountBoundState();
    setMode(undefined);
    setSession(null);
  };

  const openProgress = async () => {
    setDrawer(undefined);
    const exercise = exercisesFrom(contextRef.current)[0] ?? firstRecordAt(contextRef.current, 'exercise');
    const exerciseName = stringValue(exercise, 'displayName', 'display_name', 'name');
    try {
      await executeTool('get_progress', exerciseName
        ? { kind: 'strength', exercise: exerciseName }
        : { kind: 'completion' });
    } catch { /* executeTool presents the error */ }
  };

  const suggestedCommands = useMemo(() => [
    'Bench today, three sets of eight at sixty kilos, ninety seconds rest.',
    'First set done, eight reps.',
    'Actually that was six.',
  ], []);

  if (!config || !authChecked || (mode === 'cloud' && !profileChecked)) return <main className="voice-loading"><Brand /><span className="voice-loading__paw">●</span><p>Warming up the paws…</p></main>;

  if (!mode) {
    const providerReady = config.cloudConfigured && (config.providers.google || config.providers.apple || config.providers.emailOtp);
    return <main className="auth-shell"><section className="auth-card"><div className="auth-card__copy"><Brand /><p className="eyebrow">Your training teammate</p><h1>Good to see you.</h1><p>Sign in to keep workouts, corrections and progress with you across devices.</p><div className="auth-actions">
      {config.cloudConfigured && config.providers.apple && <Button onClick={() => void signIn('apple')}>Continue with Apple</Button>}
      {config.cloudConfigured && config.providers.google && <Button onClick={() => void signIn('google')}>Continue with Google</Button>}
      {config.cloudConfigured && config.providers.emailOtp && <form className="email-auth" onSubmit={(event) => { event.preventDefault(); void signInWithEmail(); }}><label htmlFor="sign-in-email">Email for a sign-in link</label><div><input id="sign-in-email" type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" /><Button type="submit">Email link</Button></div>{emailSent && <span role="status">Check your email for the secure sign-in link.</span>}</form>}
      {!providerReady && <div className="configuration-note" role="status"><strong>Cloud sign-in is not configured on this preview.</strong><span>No provider buttons are shown until their Supabase setup is complete.</span></div>}
      <Button variant="secondary" onClick={beginDemo}>Open development demonstrator</Button></div><p className="privacy-note">The demonstrator stays in this browser. It does not provide accounts, cross-device recovery or live OpenAI voice.</p></div><div className="auth-card__art"><span className="auth-orbit" /><Character pose="wave" name="Knufl" animated /><span className="demo-ribbon">Approved art · static reference</span></div></section>{fatalError && <div className="global-error" role="alert"><span>{fatalError}</span><button aria-label="Dismiss error" onClick={() => setFatalError('')}>×</button></div>}</main>;
  }

  if (!profileReady) {
    return <main className="cloud-onboarding"><header><Brand compact /><div className="onboarding-account-controls"><span>{mode === 'cloud' ? 'Cloud account' : 'Development demonstrator'}</span><button className="onboarding-signout" onClick={() => void signOut()}>{mode === 'cloud' ? 'Sign out' : 'Leave demo'}</button></div></header><section className="cloud-onboarding__card">
      {onboardingStep === 'import' ? <><div className="cloud-onboarding__art"><Character pose="hero" name="Knufl" animated /><span className="demo-ribbon">Development renderer · static approved pose</span></div><p className="eyebrow">Bring the history with you</p><h1>Import existing Knufl progress first.</h1><p>Select either the JSON exported from the public Knufl site or a cloud account archive. You’ll see a preview before anything changes; repeat imports do not duplicate records.</p><label className="file-picker" aria-disabled={importBusy}><span>Choose Knufl export</span><input type="file" accept="application/json,.json" disabled={importBusy} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) prepareImportFile(file); }} /></label>
      {importBusy && <p className="inline-status" role="status">Checking that export…</p>}{importPreview && <div className="import-preview"><strong>{importPreview.companionName}</strong><span>{importPreview.sessions} sessions · {importPreview.memories} memories · {importPreview.milestones} milestones</span><span>{importPreview.kind === 'cloud-account' ? 'Cloud account archive' : 'Original local progress'}</span>{importPreview.duplicateSessions > 0 && <span>{importPreview.duplicateSessions} sessions already imported</span>}{importPreview.alreadyImported && <span>This exact archive is already restored.</span>}{Boolean(importPreview.conflicts) && <span className="warning">{importPreview.conflicts} conflicts need review; nothing will be overwritten.</span>}<Button onClick={() => void confirmImport()} disabled={importBusy || Boolean(importPreview.conflicts)}>{importPreview.alreadyImported ? 'Confirm existing restore' : 'Import this progress'}</Button></div>}{importError && <p className="form-error" role="alert">{importError}</p>}<Button variant="quiet" disabled={importBusy} onClick={() => { importRequestRef.current = undefined; setImportPreview(undefined); setImportError(''); setImportBusy(false); setOnboardingStep('name'); }}>I don’t have an export</Button><p className="privacy-note">A new origin cannot read another site or device’s browser storage automatically. Export there, then choose the file here.</p></>
      : <><div className="cloud-onboarding__art"><Character pose="wave" name={nameDraft || 'Knufl'} animated /><span className="demo-ribbon">Development renderer · static approved pose</span></div><p className="eyebrow">Meet your teammate</p><h1>Name your Knufl.</h1><label className="field-label">Companion name<input value={nameDraft} maxLength={32} autoComplete="off" onChange={(event) => setNameDraft(event.target.value)} /></label><Button onClick={() => void saveName()} disabled={nameSaving || !nameDraft.trim()}>{nameSaving ? 'Saving…' : `Meet ${nameDraft.trim() || 'my Knufl'}`}</Button><Button variant="quiet" onClick={() => setOnboardingStep('import')}>Back to import</Button></>}
    </section>{fatalError && <div className="global-error" role="alert"><span>{fatalError}</span><button aria-label="Dismiss error" onClick={() => setFatalError('')}>×</button></div>}</main>;
  }

  const activeSession = activeSessionFrom(context);
  const activeExercise = exercisesFrom(context)[0] ?? firstRecordAt(context, 'exercise');
  const recoveredPlan = planFrom(context);
  const recentSets = setsFrom(context);
  const resultSet = firstRecordAt(toolResult?.data ?? {}, 'set', 'completedSet', 'completed_set');
  const latestSet = (toolResult?.tool === 'record_set' || toolResult?.tool === 'correct_set') && resultSet
    ? resultSet
    : recentSets.at(-1) ?? resultSet;
  const latestSetExerciseId = stringValue(latestSet, 'exerciseInstanceId', 'exercise_instance_id');
  const latestSetExercise = exercisesFrom(context)
    .find((item) => stringValue(item, 'id') === latestSetExerciseId);
  const receiptRestSeconds = numberValue(toolResult?.data, 'restSeconds', 'rest_seconds')
    ?? numberValue(latestSetExercise, 'restSeconds', 'rest_seconds')
    ?? numberValue(activeExercise, 'restSeconds', 'rest_seconds');
  const practiceCredits = numberValue(context, 'exerciseDayCredits', 'exercise_day_credits', 'creditCount') ?? records(context.credits).length;
  const unlockedMilestones = milestoneIdsFrom(context);
  const pendingConflicts = pending.filter((item) => item.status === 'conflict').length;
  const connected = voiceClientActive && ['connecting', 'listening', 'thinking', 'speaking', 'reconnecting', 'mic-off'].includes(voiceStatus);
  const canTransmit = voiceClientActive && ['listening', 'thinking', 'speaking', 'mic-off'].includes(voiceStatus);
  const canInterrupt = voiceClientActive && ['listening', 'thinking', 'speaking'].includes(voiceStatus);
  const displayedStatus: VoiceStatus = manualBusy && voiceStatus === 'idle' ? 'thinking' : voiceStatus;
  const primaryVoiceLabel = voiceStatus === 'reconnecting'
    ? 'Reconnect'
    : voiceStatus === 'connecting'
      ? 'Connecting…'
    : voiceStatus === 'mic-off'
      ? 'Unmute'
      : canInterrupt
        ? 'Interrupt'
        : 'Talk';
  const primaryVoiceAction = () => {
    if (voiceStatus === 'connecting') {
      return;
    } else if (voiceStatus === 'reconnecting') {
      void stopVoice().then(() => setMicDisclosure(true));
    } else if (voiceStatus === 'mic-off') {
      setMuted(false);
      voiceClientRef.current?.setMuted(false);
    } else if (canInterrupt) {
      voiceClientRef.current?.interrupt();
    } else {
      setMicDisclosure(true);
    }
  };
  const pushToTalk = (active: boolean) => {
    if (!canTransmit) return;
    pushToTalkActiveRef.current = active;
    setMuted(!active);
    voiceClientRef.current?.setMuted(!active);
  };

  return <main className={`voice-app voice-app--${character.state}`}><header className="voice-header"><button className="menu-button" aria-label="Open menu" aria-haspopup="dialog" aria-expanded={drawerOpen} onClick={() => setDrawer('account')}><span /><span /><span /></button><Brand compact /><button className={`sync-badge ${pending.length ? 'sync-badge--pending' : ''}`} aria-haspopup="dialog" aria-expanded={drawerOpen} onClick={() => setDrawer('account')}><span aria-hidden="true">{mode === 'cloud' ? pending.length ? '↻' : '●' : '○'}</span>{mode === 'cloud' ? pending.length ? `${pending.length} pending` : 'No pending changes' : 'Demo only'}</button></header>
    <div className="demo-banner" role="note">Articulated 3D study · provisional model, not the final approved character</div>
    {fatalError && <div className="global-error" role="alert"><span>{fatalError}</span><button aria-label="Dismiss error" onClick={() => setFatalError('')}>×</button></div>}
    {notice && <div className="voice-toast" role="status"><span>{notice}</span><button aria-label="Dismiss" onClick={() => setNotice('')}>×</button></div>}
    <section className="companion-stage" aria-label={`${companionName}, your training companion`}><div className="ambient ambient--one" /><div className="ambient ambient--two" /><button className={`voice-character voice-character--${character.state}`} onClick={primaryVoiceAction} aria-label={`${primaryVoiceLabel} ${companionName}`}><span className="character-halo" /><ArticulatedCharacter snapshot={character} name={companionName} /><span className="voice-rings" aria-hidden="true"><i /><i /><i /></span></button><div className={`voice-status voice-status--${displayedStatus}`} role="status" aria-live="polite"><span className="voice-status__dot" />{statusLabel(displayedStatus)}</div><div className="caption-card" aria-live="polite"><span className="caption-card__name">{companionName}</span><p>“{caption}”</p></div></section>
    {panel && <ContextPanel kind={panel} result={toolResult} planned={plannedWorkout} latestSet={latestSet} restSeconds={receiptRestSeconds} restRemaining={restRemaining} onClose={() => setPanel(null)} onRest={(seconds) => void executeTool('start_rest_timer', { durationSeconds: seconds })} onUndo={() => void executeTool('undo_last_action', {})} />}
    <section className="voice-controls" aria-label="Conversation controls"><div className="quick-prompts" aria-label="Try a command">{suggestedCommands.map((command) => <button key={command} disabled={manualBusy} onClick={() => void submitManual(command)}>{command}</button>)}</div><form className="manual-composer" aria-busy={manualBusy} onSubmit={(event) => { event.preventDefault(); void submitManual(); }}><label htmlFor="manual-command" className="sr-only">Type a workout command</label><input id="manual-command" value={manualText} disabled={manualBusy} onChange={(event) => setManualText(event.target.value)} placeholder="Type instead — e.g. First set done, eight reps" /><button type="submit" disabled={manualBusy || !manualText.trim()} aria-label="Send typed command">↑</button></form><div className="persistent-controls"><button className="talk-button" onClick={primaryVoiceAction}><span aria-hidden="true">{canInterrupt ? '◼' : '●'}</span>{primaryVoiceLabel}</button><button className="push-talk-button" disabled={!canTransmit} onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); pushToTalk(true); }} onPointerUp={() => pushToTalk(false)} onPointerCancel={() => pushToTalk(false)} onBlur={() => pushToTalk(false)} onKeyDown={(event) => { if (!event.repeat && (event.key === ' ' || event.key === 'Enter')) pushToTalk(true); }} onKeyUp={(event) => { if (event.key === ' ' || event.key === 'Enter') pushToTalk(false); }}>Hold to talk</button><button onClick={() => { const next = !muted; setMuted(next); voiceClientRef.current?.setMuted(next); }} disabled={!canTransmit}>{muted ? 'Unmute' : 'Mute'}</button><button className="stop-button" onClick={() => void stopVoice()} disabled={!connected}>Stop</button></div></section>
    {micDisclosure && <div className="dialog-backdrop" role="presentation"><section ref={micDialogRef} className="permission-dialog" role="dialog" aria-modal="true" aria-labelledby="mic-title"><span className="permission-dialog__icon">●</span><p className="eyebrow">Before the mic starts</p><h2 id="mic-title">Talk with {companionName}</h2><p>When unmuted, your microphone audio is sent to OpenAI for the live conversation. Knufl does not store raw audio. You can interrupt, mute or stop at any time, and the keyboard remains available.</p>{!config.realtimeConfigured && <p className="configuration-note"><strong>Live voice is not configured on this preview.</strong><span>Continue to return to the keyboard demonstrator.</span></p>}<div className="dialog-actions"><Button onClick={() => void connectVoice()}>{config.realtimeConfigured && mode === 'cloud' ? 'Connect microphone controls' : 'Continue without voice'}</Button><Button variant="quiet" onClick={() => setMicDisclosure(false)}>Not now</Button></div></section></div>}
    {importPreview && <div className="dialog-backdrop import-dialog-backdrop" role="presentation"><section ref={importDialogRef} className="permission-dialog import-dialog" role="dialog" aria-modal="true" aria-labelledby="import-title"><p className="eyebrow">Review before restore</p><h2 id="import-title">Import {importPreview.companionName}’s progress?</h2><p>{importPreview.sessions} sessions · {importPreview.memories} memories · {importPreview.milestones} milestones</p><p>{importPreview.kind === 'cloud-account' ? 'Portable cloud account archive' : 'Original local progress export'}</p>{importPreview.duplicateSessions > 0 && <p>{importPreview.duplicateSessions} sessions already exist.</p>}{importPreview.alreadyImported && <p>This exact cloud archive is already restored.</p>}{Boolean(importPreview.conflicts) && <p className="form-error" role="alert">{importPreview.conflicts} conflicts need review; nothing will be overwritten.</p>}{importError && <p className="form-error" role="alert">{importError}</p>}<div className="dialog-actions"><Button onClick={() => void confirmImport()} disabled={importBusy || Boolean(importPreview.conflicts)}>{importPreview.alreadyImported ? 'Confirm existing restore' : 'Import this progress'}</Button><Button variant="quiet" disabled={importBusy} onClick={() => { importRequestRef.current = undefined; setImportPreview(undefined); setImportError(''); }}>Cancel</Button></div></section></div>}
    {drawer && <div className="drawer-backdrop" role="presentation" onMouseDown={() => setDrawer(undefined)}><aside ref={menuDialogRef} className="app-drawer" role="dialog" aria-modal="true" aria-label="Knufl menu" onMouseDown={(event) => event.stopPropagation()}><header><Brand compact /><button aria-label="Close menu" onClick={() => setDrawer(undefined)}>×</button></header><nav aria-label="Account and training">{([['account', '○', 'Account'], ['plan', '◇', 'Plan'], ['history', '↺', 'Workout history'], ['progress', '↗', 'Progress'], ['memories', '✦', 'Memories'], ['settings', '⚙', 'Settings']] as const).map(([id, icon, label]) => <button key={id} className={drawer === id ? 'is-active' : ''} onClick={() => id === 'progress' ? void openProgress() : setDrawer(id)}><span>{icon}</span>{label}</button>)}</nav><div className="drawer-content">{drawer === 'settings' && Array.isArray(context.auditionVoices) && context.auditionVoices.length > 0 && <section className="settings-group"><p className="eyebrow">Owner-only voice audition</p><h3>Find the gentle giant</h3><p>Cedar is provisional. Each sample reads the same original lines in a fresh, capped one-minute session. No microphone or workout changes; ordinary voice allowance applies.</p><div className="audition-actions">{AUDITION_VOICES.map(voice => <Button key={voice} variant="secondary" disabled={voiceStatus === 'connecting'} onClick={() => { setDrawer(undefined); void connectVoice(voice); }}>Hear {voice}</Button>)}</div></section>}{drawer === 'account' && <AccountSection mode={mode} email={session?.user.email} pending={pending} conflicts={pendingConflicts} credits={practiceCredits} milestones={unlockedMilestones} onSignOut={() => void signOut()} />}{drawer === 'plan' && <PlanSection planned={plannedWorkout} recovered={recoveredPlan} active={activeSession} exercise={activeExercise} />}{drawer === 'history' && <HistorySection context={context} />}{drawer === 'memories' && <MemoriesSection context={context} demo={mode === 'demo' ? demoState : undefined} onSave={saveMemory} onDelete={deleteMemory} />}{drawer === 'settings' && <SettingsSection name={nameDraft} nameSaving={nameSaving} importBusy={importBusy} setName={setNameDraft} onSaveName={() => void saveName()} onExport={() => void exportAccount()} onImportFile={prepareImportFile} importError={importError} deleteArmed={deleteArmed} onArmDelete={() => setDeleteArmed(true)} onCancelDelete={() => setDeleteArmed(false)} onDelete={() => void deleteAccount()} />}</div></aside></div>}
  </main>;
}

function ContextPanel({ kind, result, planned, latestSet, restSeconds, restRemaining, onClose, onRest, onUndo }: { kind: Exclude<PanelKind, null>; result?: ToolResult; planned?: PlannedWorkout; latestSet?: Record<string, unknown>; restSeconds?: number; restRemaining: number; onClose: () => void; onRest: (seconds: number) => void; onUndo: () => void }) {
  const [selectedPoint, setSelectedPoint] = useState<number>();
  const data = result?.data ?? {};
  const progress = asRecord(data.progress) ?? data;
  const points = arrayAt(progress, 'points');
  const reps = numberValue(latestSet, 'reps');
  const load = numberValue(latestSet, 'load');
  const unit = stringValue(latestSet, 'loadUnit', 'load_unit');
  const plannedExercise = planned?.exercises[0];
  const savedRestSeconds = restSeconds ?? numberValue(plannedExercise, 'restSeconds', 'rest_seconds');
  const displayedPoints = points.slice(-8);
  const selectedPointLabel = selectedPoint === undefined ? undefined : progressPointLabel(displayedPoints[selectedPoint] ?? {}, selectedPoint);
  const awaitingSync = data.pending === true;
  const maximumPoint = Math.max(
    1,
    ...points.map((item) => numberValue(item, 'load', 'durationSeconds', 'duration_seconds', 'reps') ?? 1),
  );

  return (
    <aside className={`context-panel context-panel--${kind}`} aria-label={`${kind} details`}>
      <button className="context-panel__close" onClick={onClose} aria-label="Close details">×</button>
      {kind === 'plan' && (
        <>
          <p className="eyebrow">Planned · not completed</p>
          <h2>{planned?.title ?? 'Workout draft'}</h2>
          <p>{plannedExercise
            ? `${plannedExercise.name}: ${plannedExercise.sets ?? '—'} × ${plannedExercise.reps ?? '—'}${plannedExercise.load !== undefined ? ` at ${plannedExercise.load} ${plannedExercise.loadUnit ?? ''}` : ''}`
            : result?.message}</p>
        </>
      )}
      {kind === 'set' && (
        <>
          <p className="eyebrow">{awaitingSync ? 'Set pending · not synced' : 'Set receipt · saved actual'}</p>
          <div className="set-receipt">
            <strong>{reps ?? '—'}</strong><span>reps</span>
            {load !== undefined && <><strong>{load}</strong><span>{unit ?? 'load'}</span></>}
          </div>
          <p>{result?.message}</p>
          {!awaitingSync && <button className="panel-link" onClick={onUndo}>Undo last change</button>}
          {savedRestSeconds && (
            <button className="panel-link" onClick={() => onRest(savedRestSeconds)}>
              Start {savedRestSeconds}s rest
            </button>
          )}
        </>
      )}
      {kind === 'rest' && (
        <>
          <p className="eyebrow">Timestamp-based rest{awaitingSync ? ' · pending sync' : ''}</p>
          <div className="rest-countdown" aria-label={`${restRemaining} seconds remaining`}>
            {Math.floor(restRemaining / 60)}:{String(restRemaining % 60).padStart(2, '0')}
          </div>
          <p>{restRemaining ? 'Time left is calculated from the saved deadline.' : 'Rest complete. Ready when you are.'}</p>
        </>
      )}
      {kind === 'progress' && (
        <>
          <p className="eyebrow">Actual saved progress</p>
          <h2>Progress</h2>
          <p>{result?.message}</p>
          {points.length > 0 && (
            <div className="progress-chart" aria-label={`${points.length} saved comparable results. Select a bar for its exact date and value.`}>
              {displayedPoints.map((point, index) => {
                const value = numberValue(point, 'load', 'durationSeconds', 'duration_seconds') ?? numberValue(point, 'reps') ?? 1;
                return (
                  <button
                    type="button"
                    key={stringValue(point, 'setId', 'set_id', 'recordId', 'record_id') ?? index}
                    style={{ height: `${Math.max(12, (value / maximumPoint) * 100)}%` }}
                    aria-label={progressPointLabel(point, index)}
                    aria-pressed={selectedPoint === index}
                    onClick={() => setSelectedPoint(index)}
                  />
                );
              })}
            </div>
          )}
          {selectedPointLabel && <p className="progress-point-detail" role="status">{selectedPointLabel}</p>}
        </>
      )}
      {kind === 'clarification' && (
        <>
          <p className="eyebrow">One detail first</p>
          <h2>Choose the exact context</h2>
          <p>{result?.message ?? 'Tell me which exercise, activity, unit or distance you mean before I change anything.'}</p>
        </>
      )}
    </aside>
  );
}

function AccountSection({ mode, email, pending, conflicts, credits, milestones, onSignOut }: { mode: AppMode; email?: string; pending: PendingToolOperation[]; conflicts: number; credits: number; milestones: Set<string>; onSignOut: () => void }) {
  return <section><p className="eyebrow">Account</p><h2>{mode === 'cloud' ? 'Saved across devices' : 'This browser only'}</h2><p>{email || 'Development demonstrator'}</p><div className="account-stats"><span><strong>{credits}</strong> exercise days</span><span><strong>{pending.length}</strong> pending</span><span><strong>{conflicts}</strong> conflicts</span></div><article className="drawer-card"><strong>Little Mountain</strong><span>{milestones.has('little-mountain') ? 'Unlocked forever · balance move ready' : `${Math.max(0, 3 - credits)} more exercise ${Math.max(0, 3 - credits) === 1 ? 'day' : 'days'} to unlock`}</span></article><Button variant="secondary" onClick={onSignOut}>{mode === 'cloud' ? 'Sign out' : 'Leave demonstrator'}</Button></section>;
}

function PlanSection({ planned, recovered, active, exercise }: { planned?: PlannedWorkout; recovered?: ClientPlanSummary; active?: Record<string, unknown>; exercise?: Record<string, unknown> }) {
  const planExercises = planned?.exercises ?? recovered?.exercises ?? [];
  const title = planned?.title ?? recovered?.title ?? stringValue(active, 'title', 'notes') ?? 'No current draft';
  return <section><p className="eyebrow">Plan</p><h2>{title}</h2>
    {recovered && !planned && <p>{[
      recovered.activityDetail || recovered.activity,
      recovered.weeklyTarget ? `${recovered.weeklyTarget} days each week` : undefined,
      recovered.nextSessionDate ? `next ${recovered.nextSessionDate}` : undefined,
    ].filter(Boolean).join(' · ') || 'Saved plan recovered from your account.'}</p>}
    {planExercises.map((item, index) => {
      const sets = numberValue(item, 'sets', 'targetSets', 'target_sets');
      const reps = numberValue(item, 'reps', 'targetReps', 'target_reps');
      const load = numberValue(item, 'load', 'targetLoad', 'target_load');
      const unit = stringValue(item, 'loadUnit', 'load_unit');
      return <article className="drawer-card" key={stringValue(item, 'id') ?? index}><strong>{stringValue(item, 'name', 'displayName', 'display_name') ?? 'Exercise'}</strong><span>{sets ?? '—'} sets · {reps ?? '—'} reps{load !== undefined ? ` · ${load} ${unit ?? ''}` : ''}</span><small>Targets only; completed work is logged separately.</small></article>;
    })}
    {exercise && !planned && planExercises.length === 0 && <p>{stringValue(exercise, 'displayName', 'display_name', 'name') ?? 'Active exercise'}</p>}
  </section>;
}

function HistorySection({ context }: { context: Record<string, unknown> }) {
  const sessions = arrayAt(context, 'recentSessions', 'recent_sessions', 'sessions')
    .filter((item) => stringValue(item, 'status') === 'completed');
  const sets = setsFrom(context);
  return <section><p className="eyebrow">Workout history</p><h2>Saved actuals</h2>{sessions.length ? sessions.map((item) => <article className="drawer-card" key={stringValue(item, 'id')}><strong>{stringValue(item, 'title', 'notes') ?? 'Completed workout'}</strong><span>{stringValue(item, 'localDate', 'local_date', 'completedAt', 'completed_at')}</span></article>) : sets.length ? sets.map((item) => <article className="drawer-card" key={stringValue(item, 'id')}><strong>{numberValue(item, 'reps')} reps</strong><span>{numberValue(item, 'load') !== undefined ? `${numberValue(item, 'load')} ${stringValue(item, 'loadUnit', 'load_unit') ?? ''}` : 'Bodyweight'}</span></article>) : <p>No completed cloud records yet.</p>}</section>;
}

function MemoriesSection({ context, demo, onSave, onDelete }: { context: Record<string, unknown>; demo?: DemoState; onSave: (draft: MemoryDraft) => Promise<void>; onDelete: (draft: MemoryDraft) => Promise<void> }) {
  const memories = demo ? records(demo.legacyMemories) : arrayAt(context, 'memories');
  const [draft, setDraft] = useState<MemoryDraft>({ title: '', note: '' });
  const [deleteId, setDeleteId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async () => {
    setBusy(true); setError('');
    try { await onSave(draft); setDraft({ title: '', note: '' }); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Memory could not be saved.'); }
    finally { setBusy(false); }
  };
  const remove = async (item: Record<string, unknown>) => {
    setBusy(true); setError('');
    try {
      await onDelete({ id: stringValue(item, 'id'), title: stringValue(item, 'title') ?? '', note: stringValue(item, 'note') ?? '', version: numberValue(item, 'version') });
      setDeleteId(undefined);
      if (draft.id === stringValue(item, 'id')) setDraft({ title: '', note: '' });
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Memory could not be deleted.'); }
    finally { setBusy(false); }
  };
  return <section><p className="eyebrow">Memories</p><h2>Small things worth keeping</h2><p>Keep confirmed goals, preferences and earned moments—not full conversations.</p><div className="memory-editor"><label>Title<input maxLength={160} value={draft.title} onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))} /></label><label>Note<input maxLength={2000} value={draft.note} onChange={(event) => setDraft((current) => ({ ...current, note: event.target.value }))} /></label><div><Button onClick={() => void submit()} disabled={busy || !draft.title.trim() || !draft.note.trim()}>{draft.id ? 'Save changes' : 'Add memory'}</Button>{draft.id && <Button variant="quiet" onClick={() => setDraft({ title: '', note: '' })}>Cancel</Button>}</div></div>{error && <p className="form-error" role="alert">{error}</p>}{memories.length ? memories.map((item, index) => { const id = stringValue(item, 'id') ?? String(index); const editable = item.editable !== false; return <article className="drawer-card memory-row" key={id}><strong>{stringValue(item, 'title') ?? 'Shared moment'}</strong><span>{stringValue(item, 'note') ?? ''}</span>{editable && <div>{deleteId === id ? <><Button variant="quiet" onClick={() => setDeleteId(undefined)}>Cancel</Button><Button variant="danger" disabled={busy} onClick={() => void remove(item)}>Confirm delete</Button></> : <><Button variant="quiet" onClick={() => setDraft({ id, title: stringValue(item, 'title') ?? '', note: stringValue(item, 'note') ?? '', version: numberValue(item, 'version') })}>Edit</Button><Button variant="quiet" onClick={() => setDeleteId(id)}>Delete</Button></>}</div>}</article>; }) : <p>No saved memories yet.</p>}</section>;
}

function SettingsSection({ name, nameSaving, importBusy, setName, onSaveName, onExport, onImportFile, importError, deleteArmed, onArmDelete, onCancelDelete, onDelete }: { name: string; nameSaving: boolean; importBusy: boolean; setName: (value: string) => void; onSaveName: () => void; onExport: () => void; onImportFile: (file: File) => void; importError: string; deleteArmed: boolean; onArmDelete: () => void; onCancelDelete: () => void; onDelete: () => void }) {
  return <section><p className="eyebrow">Settings</p><h2>Your team, your data</h2><label className="field-label">Companion name<input value={name} maxLength={32} onChange={(event) => setName(event.target.value)} /></label><Button onClick={onSaveName} disabled={nameSaving || !name.trim()}>{nameSaving ? 'Saving…' : 'Save name'}</Button><div className="settings-group"><h3>Export and restore</h3><p>Cloud and local origins do not transfer data automatically. Imports are previewed and never silently overwrite conflicts.</p><Button variant="secondary" onClick={onExport}>Export this account</Button><label className="file-picker" aria-disabled={importBusy}><span>Import progress or account archive</span><input type="file" accept="application/json,.json" disabled={importBusy} onChange={(event) => { const file = event.target.files?.[0]; if (file) onImportFile(file); event.target.value = ''; }} /></label>{importError && <p className="form-error" role="alert">{importError}</p>}<a className="button button--quiet" href="https://helloalexcain-bot.github.io/Knufl/" target="_blank" rel="noreferrer">Open original site to export local progress</a><p className="privacy-note">On the original site, open Settings → Export progress, then import that file here.</p></div><div className="settings-group settings-group--danger"><h3>Delete account</h3><p>This permanently deletes this account’s Knufl profile and workout data. It never affects another account.</p>{!deleteArmed ? <Button variant="danger" onClick={onArmDelete}>Delete account</Button> : <div className="delete-actions"><Button variant="quiet" onClick={onCancelDelete}>Cancel</Button><Button variant="danger" onClick={onDelete}>Confirm permanent deletion</Button></div>}</div></section>;
}
