export const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
export const ACTIVITIES = ['Strength', 'Walking', 'Running', 'Cycling', 'Another activity'] as const;

export type Activity = (typeof ACTIVITIES)[number] | string;
export type MilestoneId = 'first-session' | 'little-mountain';

export interface Profile {
  name: string;
}

export interface Plan {
  weeklyTarget: number;
  days: string[];
  activity: Activity;
  activityDetail: string;
  nextSessionDate?: string;
}

export interface SessionLog {
  id: string;
  submissionKey: string;
  date: string;
  activity: string;
  duration?: number;
  feeling?: string;
  source: 'planned' | 'short' | 'completed';
  createdAt: string;
}

export interface Memory {
  id: string;
  associatedSessionId: string;
  title: string;
  note: string;
  createdAt: string;
}

export interface ActiveSession {
  id: string;
  startedAt: number;
  activity: string;
  source: 'planned' | 'short';
}

export interface KnuflData {
  version: 1;
  onboarded: boolean;
  profile: Profile;
  plan: Plan;
  logs: SessionLog[];
  memories: Memory[];
  unlockedMoves: MilestoneId[];
  restDates: string[];
  activeSession?: ActiveSession;
  lastOpened: string;
  dialogueCursor: number;
}

export const createDefaultData = (): KnuflData => ({
  version: 1,
  onboarded: false,
  profile: {
    name: 'Knufl',
  },
  plan: {
    weeklyTarget: 3,
    days: [],
    activity: 'Strength',
    activityDetail: '',
  },
  logs: [],
  memories: [],
  unlockedMoves: [],
  restDates: [],
  lastOpened: '',
  dialogueCursor: 0,
});
