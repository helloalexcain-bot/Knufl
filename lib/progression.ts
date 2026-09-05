import type { KnuflData, Memory, MilestoneId, SessionLog } from './types';

export const localDateKey = (date = new Date()): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

export const creditedDays = (logs: SessionLog[]): string[] =>
  [...new Set(logs.map((log) => log.date))].sort();

export const practiceCredits = (logs: SessionLog[]): number => creditedDays(logs).length;

export interface DailySessionState {
  date: string;
  sessions: SessionLog[];
  latestSession?: SessionLog;
  isFirstEverSession: boolean;
}

export const dailySessionState = (
  logs: SessionLog[],
  date = localDateKey(),
): DailySessionState => {
  const sessions = logs
    .filter((log) => log.date === date)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  return {
    date,
    sessions,
    latestSession: sessions[sessions.length - 1],
    isFirstEverSession: logs.length === 1 && sessions.length === 1,
  };
};

export const firstSessionMemoryNote = (activity: string): string => {
  const label = activity.trim() || 'Activity';
  switch (label.toLocaleLowerCase()) {
    case 'walking':
      return 'Our first walk. One wonderfully wobbly beginning.';
    case 'running':
      return 'Our first run. I found my stride eventually. Mostly.';
    case 'cycling':
      return 'Our first ride. I pedalled bravely in spirit.';
    case 'strength':
      return 'Our first strength session. A strong start, with one tiny paw wobble.';
    default:
      return `Our first session: ${label}. One wonderfully wobbly beginning.`;
  }
};

export const createId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

export interface SaveResult {
  data: KnuflData;
  log: SessionLog;
  created: boolean;
  alreadyCreditedToday: boolean;
  unlockedNow: MilestoneId[];
}

export const addSession = (data: KnuflData, log: SessionLog): SaveResult => {
  const duplicate = data.logs.find((item) => item.submissionKey === log.submissionKey);
  if (duplicate) {
    return {
      data,
      log: duplicate,
      created: false,
      alreadyCreditedToday: data.logs.some((item) => item.date === duplicate.date && item.id !== duplicate.id),
      unlockedNow: [],
    };
  }

  const alreadyCreditedToday = data.logs.some((item) => item.date === log.date);
  const logs = [...data.logs, log];
  const nextCredits = practiceCredits(logs);
  const unlockedNow: MilestoneId[] = [];
  const unlockedMoves = [...data.unlockedMoves];

  if (!unlockedMoves.includes('first-session')) {
    unlockedMoves.push('first-session');
    unlockedNow.push('first-session');
  }
  if (nextCredits >= 3 && !unlockedMoves.includes('little-mountain')) {
    unlockedMoves.push('little-mountain');
    unlockedNow.push('little-mountain');
  }

  const memories = [...data.memories];
  if (data.logs.length === 0) {
    memories.push({
      id: createId(),
      associatedSessionId: log.id,
      title: 'Our first session',
      note: firstSessionMemoryNote(log.activity),
      createdAt: log.createdAt,
    });
  }
  if (unlockedNow.includes('little-mountain')) {
    memories.push({
      id: createId(),
      associatedSessionId: log.id,
      title: 'Little Mountain',
      note: 'Three practice days. A steadier stance, and the same big heart.',
      createdAt: log.createdAt,
    });
  }

  return {
    data: { ...data, logs, memories, unlockedMoves },
    log,
    created: true,
    alreadyCreditedToday,
    unlockedNow,
  };
};

export const reconcileMilestones = (data: KnuflData, associatedSessionId?: string): KnuflData => {
  const unlockedMoves = [...data.unlockedMoves];
  const memories = [...data.memories];
  const logs = data.logs;
  if (logs.length > 0 && !unlockedMoves.includes('first-session')) unlockedMoves.push('first-session');
  if (practiceCredits(logs) >= 3 && !unlockedMoves.includes('little-mountain')) {
    unlockedMoves.push('little-mountain');
    const session = logs.find((log) => log.id === associatedSessionId) ?? logs[logs.length - 1];
    if (session) {
      memories.push({
        id: createId(),
        associatedSessionId: session.id,
        title: 'Little Mountain',
        note: 'Three practice days. A steadier stance, and the same big heart.',
        createdAt: new Date().toISOString(),
      });
    }
  }
  return { ...data, unlockedMoves, memories };
};

export const updateSession = (data: KnuflData, updated: SessionLog): KnuflData => {
  const previous = data.logs.find((log) => log.id === updated.id);
  const memories = data.memories.map((memory) => {
    const isGeneratedFirstMemory = previous
      && memory.associatedSessionId === updated.id
      && memory.title === 'Our first session'
      && memory.note === firstSessionMemoryNote(previous.activity);
    return isGeneratedFirstMemory
      ? { ...memory, note: firstSessionMemoryNote(updated.activity) }
      : memory;
  });

  return reconcileMilestones({
    ...data,
    logs: data.logs.map((log) => (log.id === updated.id ? updated : log)),
    memories,
  }, updated.id);
};

export const deleteSession = (data: KnuflData, id: string): KnuflData => ({
  ...data,
  logs: data.logs.filter((log) => log.id !== id),
  memories: data.memories.filter((memory) => memory.associatedSessionId !== id),
});

export const memoryDate = (memory: Memory, logs: SessionLog[]): string =>
  logs.find((log) => log.id === memory.associatedSessionId)?.date ?? memory.createdAt.slice(0, 10);

export const calendarDayDifference = (from: string, to: string): number => {
  if (!from || !to) return 0;
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
};

export const nextPlannedDate = (planDays: string[], override?: string, now = new Date()): string | undefined => {
  const today = localDateKey(now);
  if (override && override >= today) return override;
  if (!planDays.length) return undefined;
  const mondayIndex = (now.getDay() + 6) % 7;
  for (let offset = 0; offset < 7; offset += 1) {
    const index = (mondayIndex + offset) % 7;
    const dayName = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][index];
    if (planDays.includes(dayName)) {
      const date = new Date(now);
      date.setDate(now.getDate() + offset);
      return localDateKey(date);
    }
  }
  return undefined;
};
