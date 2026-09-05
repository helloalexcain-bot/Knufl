'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ACTIVITIES,
  DAY_NAMES,
  createDefaultData,
  type KnuflData,
  type Plan,
  type Profile,
  type SessionLog,
} from '@/lib/types';
import {
  addSession,
  calendarDayDifference,
  createId,
  dailySessionState,
  deleteSession,
  localDateKey,
  memoryDate,
  nextPlannedDate,
  practiceCredits,
  updateSession,
} from '@/lib/progression';
import { activityAcknowledgement, HOME_DIALOGUE, REST_DIALOGUE, RETURN_DIALOGUE, sameDayDialogue, savedDialogue } from '@/lib/dialogue';
import { parseProgressImport, readProgress, STORAGE_KEY, writeProgress } from '@/lib/storage';
import { BottomNav, Brand, Button, Character, displayDate, FieldLabel, Modal } from './components';

type View = 'home' | 'journey' | 'plan' | 'you' | 'session';
type Sheet = 'short' | 'move' | 'log' | null;
type CelebrationKind = 'first' | 'milestone' | 'same-day' | 'standard';

interface LogDraft {
  id?: string;
  submissionKey: string;
  date: string;
  activity: string;
  duration: string;
  feeling: string;
  source: 'planned' | 'short' | 'completed';
}

const resolvedActivity = (plan: Plan) =>
  plan.activity === 'Another activity' ? plan.activityDetail.trim() || 'Your activity' : plan.activity;

const emptyLogDraft = (plan: Plan, source: LogDraft['source'] = 'completed'): LogDraft => ({
  submissionKey: createId(),
  date: localDateKey(),
  activity: resolvedActivity(plan),
  duration: '',
  feeling: '',
  source,
});

export default function Home() {
  const [data, setData] = useState<KnuflData>(createDefaultData);
  const [ready, setReady] = useState(false);
  const [onboardingStep, setOnboardingStep] = useState<'identity' | 'plan'>('identity');
  const [profileDraft, setProfileDraft] = useState<Profile>(createDefaultData().profile);
  const [planDraft, setPlanDraft] = useState<Plan>(createDefaultData().plan);
  const [view, setView] = useState<View>('home');
  const [sheet, setSheet] = useState<Sheet>(null);
  const [logDraft, setLogDraft] = useState<LogDraft>(emptyLogDraft(createDefaultData().plan));
  const [moveDate, setMoveDate] = useState(localDateKey());
  const [celebration, setCelebration] = useState<{ kind: CelebrationKind; log: SessionLog } | null>(null);
  const [pawTapped, setPawTapped] = useState(false);
  const [returnPrompt, setReturnPrompt] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [resetArmed, setResetArmed] = useState(false);
  const [notice, setNotice] = useState('');
  const [importError, setImportError] = useState('');
  const [today, setToday] = useState(localDateKey);
  const saveLock = useRef(false);

  /* Browser storage is intentionally hydrated after mount to keep the server render device-agnostic. */
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    const openedToday = localDateKey();
    const loaded = readProgress();
    setReturnPrompt(loaded.onboarded && calendarDayDifference(loaded.lastOpened, openedToday) >= 7);
    const opened = { ...loaded, lastOpened: openedToday };
    writeProgress(opened);
    setData(opened);
    setProfileDraft(opened.profile);
    setPlanDraft(opened.plan);
    setToday(openedToday);
    setReady(true);
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    const syncLocalDate = () => setToday(localDateKey());
    const timer = window.setInterval(syncLocalDate, 60_000);
    window.addEventListener('focus', syncLocalDate);
    document.addEventListener('visibilitychange', syncLocalDate);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', syncLocalDate);
      document.removeEventListener('visibilitychange', syncLocalDate);
    };
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 3200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (view !== 'session' || !data.activeSession) return;
    const update = () => setElapsed(Math.max(0, Date.now() - data.activeSession!.startedAt));
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [view, data.activeSession]);

  useEffect(() => {
    if (ready && view !== 'session') window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, [ready, view]);

  const commit = useCallback((next: KnuflData | ((current: KnuflData) => KnuflData)) => {
    setData((current) => {
      const value = typeof next === 'function' ? next(current) : next;
      writeProgress(value);
      return value;
    });
  }, []);

  const credits = useMemo(() => practiceCredits(data.logs), [data.logs]);
  const exportHref = useMemo(
    () => `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(data, null, 2))}`,
    [data],
  );
  const activity = resolvedActivity(data.plan);
  const isRestingToday = data.restDates.includes(today);
  const openLog = (source: LogDraft['source'], existing?: SessionLog, duration?: number) => {
    saveLock.current = false;
    setLogDraft(existing ? {
      id: existing.id,
      submissionKey: existing.submissionKey,
      date: existing.date,
      activity: existing.activity,
      duration: existing.duration ? String(existing.duration) : '',
      feeling: existing.feeling ?? '',
      source: existing.source,
    } : {
      ...emptyLogDraft(data.plan, source),
      duration: duration ? String(duration) : '',
    });
    setSheet('log');
  };

  const beginSession = (source: 'planned' | 'short' = 'planned') => {
    if (!data.activeSession) {
      commit({
        ...data,
        activeSession: { id: createId(), startedAt: Date.now(), activity, source },
        restDates: data.restDates.filter((date) => date !== today),
      });
    }
    setSheet(null);
    setReturnPrompt(false);
    setView('session');
  };

  const finishSession = () => {
    if (!data.activeSession) return;
    const duration = Math.max(1, Math.round((Date.now() - data.activeSession.startedAt) / 60_000));
    setView('home');
    openLog(data.activeSession.source, undefined, duration);
  };

  const saveLog = () => {
    if (saveLock.current || !logDraft.activity.trim()) return;
    saveLock.current = true;
    const numericDuration = logDraft.duration ? Number(logDraft.duration) : undefined;
    const log: SessionLog = {
      id: logDraft.id ?? createId(),
      submissionKey: logDraft.submissionKey,
      date: logDraft.date,
      activity: logDraft.activity.trim(),
      duration: numericDuration && numericDuration > 0 ? Math.round(numericDuration) : undefined,
      feeling: logDraft.feeling || undefined,
      source: logDraft.source,
      createdAt: logDraft.id
        ? data.logs.find((item) => item.id === logDraft.id)?.createdAt ?? new Date().toISOString()
        : new Date().toISOString(),
    };

    if (logDraft.id) {
      const updated = updateSession(data, log);
      commit(updated);
      setSheet(null);
      setNotice('Session updated. Practice days recalculated.');
      saveLock.current = false;
      return;
    }

    const result = addSession(data, log);
    if (!result.created) {
      setSheet(null);
      setNotice('That session is already saved.');
      return;
    }
    const next: KnuflData = {
      ...result.data,
      activeSession: undefined,
      dialogueCursor: data.dialogueCursor + 1,
      plan: {
        ...result.data.plan,
        nextSessionDate: result.data.plan.nextSessionDate === log.date ? undefined : result.data.plan.nextSessionDate,
      },
    };
    writeProgress(next);
    setData(next);
    setSheet(null);
    setView('home');
    const kind: CelebrationKind = result.unlockedNow.includes('first-session')
      ? 'first'
      : result.unlockedNow.includes('little-mountain')
        ? 'milestone'
        : result.alreadyCreditedToday
          ? 'same-day'
          : 'standard';
    setPawTapped(false);
    setCelebration({ kind, log });
  };

  const saveIdentityAndContinue = () => {
    if (!profileDraft.name.trim()) return;
    setProfileDraft({ name: profileDraft.name.trim() });
    setOnboardingStep('plan');
  };

  const completeOnboarding = () => {
    const next: KnuflData = {
      ...data,
      onboarded: true,
      profile: { name: profileDraft.name.trim() },
      plan: planDraft,
      lastOpened: localDateKey(),
    };
    writeProgress(next);
    setData(next);
    setView('home');
  };

  const savePlan = () => {
    const next = { ...data, plan: planDraft };
    commit(next);
    setNotice('Plan saved. Your earned practice stays exactly as it was.');
    setView('home');
  };

  const saveProfile = () => {
    if (!profileDraft.name.trim()) return;
    const profile = { name: profileDraft.name.trim() };
    commit({ ...data, profile });
    setProfileDraft(profile);
    setNotice('Companion details saved.');
  };

  const markRest = () => {
    if (!isRestingToday) commit({ ...data, restDates: [...data.restDates, today] });
    setSheet(null);
  };

  const moveSession = () => {
    commit({ ...data, plan: { ...data.plan, nextSessionDate: moveDate } });
    setPlanDraft({ ...data.plan, nextSessionDate: moveDate });
    setSheet(null);
    setNotice(`Session moved to ${displayDate(moveDate, true)}.`);
  };

  const removeLog = (id: string) => {
    const next = deleteSession(data, id);
    commit(next);
    setDeleteId(null);
    setNotice('Session and its linked memory deleted.');
  };

  const exportProgress = () => {
    setNotice('Local progress exported.');
  };

  const importProgress = async (file?: File) => {
    if (!file) return;
    try {
      const imported = parseProgressImport(await file.text());
      const returning = imported.onboarded && calendarDayDifference(imported.lastOpened, today) >= 7;
      const opened = { ...imported, lastOpened: today, activeSession: undefined };
      writeProgress(opened);
      setData(opened);
      setProfileDraft(opened.profile);
      setPlanDraft(opened.plan);
      setReturnPrompt(returning);
      setImportError('');
      setView(opened.onboarded ? 'home' : 'you');
      setNotice('Progress imported on this device.');
    } catch (error) {
      setImportError(error instanceof Error ? error.message : 'Could not import that file.');
    }
  };

  const resetProgress = () => {
    window.localStorage.removeItem(STORAGE_KEY);
    const fresh = { ...createDefaultData(), lastOpened: today };
    writeProgress(fresh);
    setData(fresh);
    setProfileDraft(fresh.profile);
    setPlanDraft(fresh.plan);
    setOnboardingStep('identity');
    setView('home');
    setResetArmed(false);
  };

  if (!ready) {
    return <main className="loading-screen"><Brand /><span className="loading-dot" /></main>;
  }

  if (!data.onboarded) {
    return onboardingStep === 'identity' ? (
      <IdentityOnboarding
        profile={profileDraft}
        onChange={setProfileDraft}
        onContinue={saveIdentityAndContinue}
      />
    ) : (
      <PlanOnboarding
        plan={planDraft}
        onChange={setPlanDraft}
        name={profileDraft.name}
        onBack={() => setOnboardingStep('identity')}
        onComplete={completeOnboarding}
      />
    );
  }

  if (returnPrompt) {
    return (
      <main className="return-screen">
        <Brand />
        <div className="return-stage"><Character pose="wave" name={data.profile.name} animated /></div>
        <p className="eyebrow">Still the same team</p>
        <h1>Welcome back, {data.profile.name}.</h1>
        <p className="return-copy">“{RETURN_DIALOGUE}”</p>
        <div className="return-actions">
          <Button onClick={() => beginSession()}>Start a session</Button>
          <Button variant="secondary" onClick={() => { setReturnPrompt(false); setView('plan'); }}>Adjust my plan</Button>
          <Button variant="quiet" onClick={() => setReturnPrompt(false)}>Leave for now</Button>
        </div>
        <p className="return-note">Your {credits} earned practice {credits === 1 ? 'day is' : 'days are'} still here.</p>
      </main>
    );
  }

  if (view === 'session') {
    return (
      <SessionView
        name={data.profile.name}
        activity={data.activeSession?.activity ?? activity}
        elapsed={elapsed}
        active={Boolean(data.activeSession)}
        onFinish={finishSession}
        onLeave={() => setView('home')}
        onCancel={() => {
          commit({ ...data, activeSession: undefined });
          setView('home');
        }}
      />
    );
  }

  return (
    <main className="app-shell">
      <div className="app-frame">
        <header className="app-header">
          <Brand compact />
          <div className="credit-pill" aria-label={`${credits} credited exercise days`}>
            <span>{credits}</span> practice {credits === 1 ? 'day' : 'days'}
          </div>
        </header>

        {notice && <div className="toast" role="status">{notice}</div>}

        <div className="app-content">
          {view === 'home' && (
            <HomeView
              data={data}
              credits={credits}
              today={today}
              isRestingToday={isRestingToday}
              onStart={() => beginSession()}
              onContinue={() => setView('session')}
              onShort={() => setSheet('short')}
              onMove={() => { setMoveDate(data.plan.nextSessionDate ?? today); setSheet('move'); }}
              onRest={markRest}
              onLog={() => openLog('completed')}
              onJourney={() => setView('journey')}
            />
          )}
          {view === 'journey' && (
            <JourneyView
              data={data}
              credits={credits}
              deleteId={deleteId}
              onEdit={(log) => openLog(log.source, log)}
              onDeleteAsk={setDeleteId}
              onDelete={removeLog}
              onDeleteCancel={() => setDeleteId(null)}
            />
          )}
          {view === 'plan' && (
            <PlanSettings
              plan={planDraft}
              onChange={setPlanDraft}
              onSave={savePlan}
            />
          )}
          {view === 'you' && (
            <SettingsView
              profile={profileDraft}
              onChange={setProfileDraft}
              onSave={saveProfile}
              exportHref={exportHref}
              exportFilename={`knufl-progress-${today}.json`}
              onExport={exportProgress}
              onImport={importProgress}
              importError={importError}
              resetArmed={resetArmed}
              onArmReset={() => setResetArmed(true)}
              onCancelReset={() => setResetArmed(false)}
              onReset={resetProgress}
            />
          )}
        </div>

        <BottomNav
          active={view}
          onChange={(next) => {
            setView(next);
            if (next === 'plan') setPlanDraft(data.plan);
            if (next === 'you') setProfileDraft(data.profile);
          }}
        />
      </div>

      {sheet === 'short' && (
        <Modal title="Short on time?" eyebrow="Smaller session, same team" onClose={() => setSheet(null)}>
          <p className="modal-copy">Choose what works today. Use your own familiar shorter routine—we won’t prescribe exercises or intensity.</p>
          <div className="stack-actions">
            <Button onClick={() => beginSession('short')}>Start my shorter routine</Button>
            <Button variant="secondary" onClick={() => { setMoveDate(data.plan.nextSessionDate ?? today); setSheet('move'); }}>Reschedule instead</Button>
            <Button variant="quiet" onClick={markRest}>Rest today</Button>
          </div>
        </Modal>
      )}

      {sheet === 'move' && (
        <Modal title="Move this session" eyebrow="Plans can flex" onClose={() => setSheet(null)}>
          <label className="form-field">
            <FieldLabel>New date</FieldLabel>
            <input type="date" min={today} value={moveDate} onInput={(event) => setMoveDate(event.currentTarget.value)} onChange={(event) => setMoveDate(event.target.value)} />
          </label>
          <Button onClick={moveSession} disabled={!moveDate}>Move session</Button>
        </Modal>
      )}

      {sheet === 'log' && (
        <LogModal
          draft={logDraft}
          onChange={setLogDraft}
          onSave={saveLog}
          onClose={() => { setSheet(null); saveLock.current = false; }}
          editing={Boolean(logDraft.id)}
          today={today}
        />
      )}

      {celebration && (
        <Celebration
          celebration={celebration}
          name={data.profile.name}
          pawTapped={pawTapped}
          onPaw={() => setPawTapped(true)}
          onClose={() => setCelebration(null)}
        />
      )}
    </main>
  );
}

function IdentityOnboarding({
  profile,
  onChange,
  onContinue,
}: {
  profile: Profile;
  onChange: (profile: Profile) => void;
  onContinue: () => void;
}) {
  return (
    <main className="onboarding-shell">
      <section className="onboarding-card">
        <header className="brand-row"><Brand compact /><span className="step-label">Meet · 1 of 2</span></header>
        <div className="onboarding-copy">
          <p className="eyebrow">Your training teammate</p>
          <h1>Meet your Knufl.</h1>
          <p className="intro">A little cheeky. Quietly determined. Here to get stronger with you.</p>
          <div className="identity-fields identity-fields--simple">
            <label className="form-field">
              <FieldLabel>Name your Knufl</FieldLabel>
              <input aria-label="Name your Knufl" value={profile.name} maxLength={24} onChange={(event) => onChange({ ...profile, name: event.target.value })} autoComplete="off" />
            </label>
          </div>
          <p className="fine-print">You can change {profile.name.trim() || 'your Knufl'}’s name later.</p>
          <Button onClick={onContinue} disabled={!profile.name.trim()}>Continue with {profile.name.trim() || 'my Knufl'}</Button>
        </div>
        <div className="character-stage">
          <div className="sage-orbit" />
          <Character pose="hero" name={profile.name || 'Your Knufl'} animated />
          <blockquote>“Hello, teammate.”</blockquote>
        </div>
      </section>
    </main>
  );
}

function PlanOnboarding({
  plan,
  onChange,
  name,
  onBack,
  onComplete,
}: {
  plan: Plan;
  onChange: (plan: Plan) => void;
  name: string;
  onBack: () => void;
  onComplete: () => void;
}) {
  return (
    <main className="plan-onboarding">
      <section className="plan-onboarding__card">
        <header className="brand-row"><Brand compact /><span className="step-label">Plan · 2 of 2</span></header>
        <div className="plan-onboarding__art">
          <Character pose="wave" name={name} animated />
          <div className="speech-card">“We’ll follow your plan. I’ll bring the paws.”</div>
        </div>
        <div className="plan-onboarding__form">
          <p className="eyebrow">Make it manageable</p>
          <h1>A plan that can flex.</h1>
          <p className="intro">Choose the rhythm. You’ll use your own familiar exercise routine—Knufl doesn’t prescribe workouts.</p>
          <PlanFields plan={plan} onChange={onChange} />
          <div className="split-actions"><Button variant="quiet" onClick={onBack}>Back</Button><Button onClick={onComplete}>Meet the team</Button></div>
        </div>
      </section>
    </main>
  );
}

function PlanFields({ plan, onChange }: { plan: Plan; onChange: (plan: Plan) => void }) {
  return (
    <div className="plan-fields">
      <fieldset className="form-field">
        <legend><FieldLabel>Weekly session target</FieldLabel></legend>
        <div className="number-choice">
          {[1, 2, 3, 4, 5, 6, 7].map((number) => (
            <button type="button" key={number} className={plan.weeklyTarget === number ? 'selected' : ''} onClick={() => onChange({ ...plan, weeklyTarget: number })}>{number}</button>
          ))}
        </div>
        <small className="field-help">For planning only. It never caps rewards or reduces progress.</small>
      </fieldset>
      <fieldset className="form-field">
        <legend><FieldLabel optional>Training days</FieldLabel></legend>
        <div className="choice-chips choice-chips--days">
          {DAY_NAMES.map((day) => (
            <button type="button" key={day} className={plan.days.includes(day) ? 'selected' : ''} onClick={() => onChange({
              ...plan,
              days: plan.days.includes(day) ? plan.days.filter((item) => item !== day) : [...plan.days, day],
            })}>{day.slice(0, 1)}</button>
          ))}
        </div>
        <small className="field-help">Leave every day clear if you prefer to stay unscheduled.</small>
      </fieldset>
      <fieldset className="form-field">
        <legend><FieldLabel>Usual activity</FieldLabel></legend>
        <div className="choice-chips choice-chips--wrap">
          {ACTIVITIES.map((activity) => (
            <button type="button" key={activity} className={plan.activity === activity ? 'selected' : ''} onClick={() => onChange({ ...plan, activity })}>{activity}</button>
          ))}
        </div>
      </fieldset>
      {plan.activity === 'Another activity' && (
        <label className="form-field"><FieldLabel>Your activity</FieldLabel><input value={plan.activityDetail} onChange={(event) => onChange({ ...plan, activityDetail: event.target.value })} placeholder="e.g. swimming" /></label>
      )}
    </div>
  );
}

function HomeView({
  data,
  credits,
  today,
  isRestingToday,
  onStart,
  onContinue,
  onShort,
  onMove,
  onRest,
  onLog,
  onJourney,
}: {
  data: KnuflData;
  credits: number;
  today: string;
  isRestingToday: boolean;
  onStart: () => void;
  onContinue: () => void;
  onShort: () => void;
  onMove: () => void;
  onRest: () => void;
  onLog: () => void;
  onJourney: () => void;
}) {
  const nextDate = nextPlannedDate(data.plan.days, data.plan.nextSessionDate);
  const dialogue = HOME_DIALOGUE[data.dialogueCursor % HOME_DIALOGUE.length];
  const milestoneUnlocked = data.unlockedMoves.includes('little-mountain');
  const completedToday = dailySessionState(data.logs, today);
  const todayComplete = Boolean(completedToday.latestSession);
  const completionStatus = completedToday.isFirstEverSession
    ? 'First session together ✓'
    : completedToday.sessions.length > 1
      ? `${completedToday.sessions.length} sessions today ✓`
      : 'Today’s session complete ✓';
  const heroEyebrow = todayComplete
    ? completionStatus
    : isRestingToday
      ? 'A quieter kind of progress'
      : 'Today, together';
  const heroTitle = todayComplete ? 'Nicely done.' : isRestingToday ? 'Rest easy.' : 'Hi, teammate.';
  const heroDialogue = completedToday.latestSession
    ? activityAcknowledgement(completedToday.latestSession.activity)
    : isRestingToday
      ? REST_DIALOGUE
      : dialogue;
  return (
    <div className="home-view">
      <section className={`companion-hero ${todayComplete ? 'companion-hero--complete' : isRestingToday ? 'companion-hero--rest' : ''}`}>
        <div className="companion-hero__copy">
          <p className="eyebrow">{heroEyebrow}</p>
          <h1>{heroTitle}</h1>
          <p className="dialogue">“{heroDialogue}”</p>
        </div>
        <div className="companion-hero__art">
          <span className="sun-shape" />
          <Character pose={todayComplete || isRestingToday ? 'wave' : 'hero'} name={data.profile.name} animated={!isRestingToday} />
          <span className="name-tag">{data.profile.name}</span>
        </div>
      </section>

      {data.activeSession && (
        <button className="active-session-banner" onClick={onContinue}>
          <span><small>Session in progress</small>{data.activeSession.activity}</span>
          <strong>Continue →</strong>
        </button>
      )}

      <section className="today-card">
        <div>
          <p className="eyebrow">Next session</p>
          <h2>{nextDate ? displayDate(nextDate, true) : 'Whenever suits you'}</h2>
          <p>{resolvedActivity(data.plan)} · your own familiar routine</p>
        </div>
        <div className="today-card__actions">
          <Button variant={todayComplete ? 'secondary' : 'primary'} onClick={onStart}>{todayComplete ? 'Start another session' : isRestingToday ? 'Change my mind & start' : 'Start session'}</Button>
          <Button variant="secondary" onClick={onShort}>Short on time?</Button>
        </div>
      </section>

      <section className="quick-actions" aria-label="Session options">
        <button onClick={onMove}><span>↗</span><strong>Move session</strong><small>Choose another day</small></button>
        <button onClick={onRest}><span>☾</span><strong>Rest today</strong><small>Progress stays safe</small></button>
        <button onClick={onLog}><span>✓</span><strong>Log completed</strong><small>Add a past session</small></button>
      </section>

      <button className="milestone-preview" onClick={onJourney}>
        <div className="milestone-preview__art"><Character pose={milestoneUnlocked ? 'balance' : 'wobble'} name={data.profile.name} /></div>
        <div>
          <p className="eyebrow">Next shared move</p>
          <h3>Little Mountain</h3>
          <p>{milestoneUnlocked ? `Unlocked. A little steadier, still unmistakably ${data.profile.name}.` : `${Math.max(0, 3 - credits)} more practice ${3 - credits === 1 ? 'day' : 'days'} to discover it.`}</p>
        </div>
        <span aria-hidden="true">→</span>
      </button>
    </div>
  );
}

function SessionView({
  name,
  activity,
  elapsed,
  active,
  onFinish,
  onLeave,
  onCancel,
}: {
  name: string;
  activity: string;
  elapsed: number;
  active: boolean;
  onFinish: () => void;
  onLeave: () => void;
  onCancel: () => void;
}) {
  const minutes = Math.floor(elapsed / 60_000);
  const seconds = Math.floor((elapsed % 60_000) / 1000);
  return (
    <main className="session-screen">
      <header><Brand compact /><button className="text-button" onClick={onLeave}>Leave running</button></header>
      <section className="session-center">
        <p className="eyebrow">Moving together</p>
        <h1>{activity}</h1>
        <div className="timer" aria-label={`${minutes} minutes and ${seconds} seconds elapsed`}>
          <span>{String(minutes).padStart(2, '0')}</span>:<span>{String(seconds).padStart(2, '0')}</span>
        </div>
        <p>You follow your routine. {name} will keep you company.</p>
        <Character pose="balance" name={name} animated />
      </section>
      <div className="session-actions">
        <Button onClick={onFinish} disabled={!active}>Finish & log</Button>
        <Button variant="quiet" onClick={onCancel}>Cancel session</Button>
      </div>
      <p className="session-footnote">This timer is stored on this device, so locking your phone or leaving the tab won’t lose it.</p>
    </main>
  );
}

function LogModal({
  draft,
  onChange,
  onSave,
  onClose,
  editing,
  today,
}: {
  draft: LogDraft;
  onChange: (draft: LogDraft) => void;
  onSave: () => void;
  onClose: () => void;
  editing: boolean;
  today: string;
}) {
  return (
    <Modal title={editing ? 'Correct session' : 'Quick log'} eyebrow={editing ? 'Keep it accurate' : 'Usually under 20 seconds'} onClose={onClose}>
      <div className="log-form">
        <label className="form-field"><FieldLabel>Date</FieldLabel><input type="date" max={today} value={draft.date} onInput={(event) => onChange({ ...draft, date: event.currentTarget.value })} onChange={(event) => onChange({ ...draft, date: event.target.value })} /></label>
        <label className="form-field"><FieldLabel>Activity</FieldLabel><input value={draft.activity} onChange={(event) => onChange({ ...draft, activity: event.target.value })} /></label>
        <label className="form-field"><FieldLabel optional>Duration in minutes</FieldLabel><input type="number" min="1" max="1440" inputMode="numeric" value={draft.duration} onChange={(event) => onChange({ ...draft, duration: event.target.value })} placeholder="e.g. 15" /></label>
        <fieldset className="form-field">
          <legend><FieldLabel optional>How did it feel?</FieldLabel></legend>
          <div className="choice-chips">
            {['Light', 'Good', 'Tough'].map((feeling) => <button type="button" key={feeling} className={draft.feeling === feeling ? 'selected' : ''} onClick={() => onChange({ ...draft, feeling: draft.feeling === feeling ? '' : feeling })}>{feeling}</button>)}
          </div>
        </fieldset>
      </div>
      <p className="fine-print">This is saved as user-reported activity. It isn’t independently verified.</p>
      <Button onClick={onSave} disabled={!draft.date || !draft.activity.trim()}>{editing ? 'Save correction' : 'Save session'}</Button>
    </Modal>
  );
}

function Celebration({
  celebration,
  name,
  pawTapped,
  onPaw,
  onClose,
}: {
  celebration: { kind: CelebrationKind; log: SessionLog };
  name: string;
  pawTapped: boolean;
  onPaw: () => void;
  onClose: () => void;
}) {
  const { kind, log } = celebration;
  const title = kind === 'milestone' ? 'Little Mountain unlocked.' : kind === 'same-day' ? 'Still showed up.' : 'We showed up.';
  const dialogue = kind === 'same-day'
    ? sameDayDialogue()
    : kind === 'milestone'
      ? 'Three practice days. Look at that stance. Please ignore the tiny wobble on the left.'
      : savedDialogue(log.duration);
  const pose = pawTapped ? 'pawtap' : kind === 'milestone' ? 'balance' : kind === 'same-day' ? 'wave' : 'wobble';
  return (
    <div className="celebration-backdrop" role="presentation">
      <section className="celebration" role="dialog" aria-modal="true" aria-labelledby="celebration-title">
        <p className="saved-first">Saved ✓</p>
        <div className="celebration__art"><span className="celebration-ring" /><Character pose={pose} name={name} animated /></div>
        <p className="eyebrow">{kind === 'milestone' ? 'A new shared move' : kind === 'first' ? 'Our first session' : 'Same team'}</p>
        <h2 id="celebration-title">{pawTapped ? 'Paw tap.' : title}</h2>
        <p className="celebration__dialogue">“{pawTapped ? 'Good work, teammate. My paw survived too.' : dialogue}”</p>
        {kind !== 'same-day' && !pawTapped ? (
          <div className="celebration__actions"><Button onClick={onPaw}>Paw tap</Button><Button variant="quiet" onClick={onClose}>Not now</Button></div>
        ) : (
          <Button onClick={onClose}>Back home</Button>
        )}
        <p className="fine-print">Your session and progress were saved before this moment.</p>
      </section>
    </div>
  );
}

function JourneyView({
  data,
  credits,
  deleteId,
  onEdit,
  onDeleteAsk,
  onDelete,
  onDeleteCancel,
}: {
  data: KnuflData;
  credits: number;
  deleteId: string | null;
  onEdit: (log: SessionLog) => void;
  onDeleteAsk: (id: string) => void;
  onDelete: (id: string) => void;
  onDeleteCancel: () => void;
}) {
  const logs = [...data.logs].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  const unlocked = data.unlockedMoves.includes('little-mountain');
  return (
    <div className="section-view journey-view">
      <div className="section-heading"><p className="eyebrow">Shared journey</p><h1>Things we’ve done.</h1><p>Real sessions, earned memories and one increasingly steady Knufl.</p></div>
      <section className="journey-summary">
        <div><strong>{credits}</strong><span>credited exercise {credits === 1 ? 'day' : 'days'}</span></div>
        <div><strong>{data.logs.length}</strong><span>session {data.logs.length === 1 ? 'log' : 'logs'}</span></div>
        <div><strong>{data.memories.length}</strong><span>shared {data.memories.length === 1 ? 'memory' : 'memories'}</span></div>
      </section>
      <section className="milestone-card">
        <div className="milestone-card__art"><Character pose={unlocked ? 'balance' : 'wobble'} name={data.profile.name} /></div>
        <div><p className="eyebrow">Shared move</p><h2>Little Mountain</h2><p>{unlocked ? 'Unlocked forever after three credited exercise days.' : `${credits} of 3 credited exercise days. One credit per local calendar day.`}</p><div className="progress-dots">{[1, 2, 3].map((item) => <span key={item} className={item <= credits ? 'filled' : ''} />)}</div></div>
      </section>
      <section className="journey-section">
        <div className="subheading"><h2>Memories</h2><span>{data.memories.length}</span></div>
        {data.memories.length ? <div className="memory-list">{data.memories.map((memory) => (
          <article key={memory.id} className="memory-card"><span className="memory-mark">✦</span><div><time>{displayDate(memoryDate(memory, data.logs), true)}</time><h3>{memory.title}</h3><p>{memory.note}</p></div></article>
        ))}</div> : <EmptyState title="Your first memory is waiting." copy="Save a session and we’ll remember the day you started together." />}
      </section>
      <section className="journey-section">
        <div className="subheading"><h2>Session history</h2><span>{logs.length}</span></div>
        {logs.length ? <div className="history-list">{logs.map((log) => (
          <article key={log.id} className="history-card">
            <div className="history-date"><strong>{new Date(`${log.date}T12:00:00`).getDate()}</strong><span>{new Intl.DateTimeFormat('en-GB', { month: 'short' }).format(new Date(`${log.date}T12:00:00`))}</span></div>
            <div className="history-main"><h3>{log.activity}</h3><p>{[log.duration ? `${log.duration} min` : null, log.feeling, log.source === 'short' ? 'shorter routine' : null].filter(Boolean).join(' · ') || 'Session completed'}</p></div>
            {deleteId === log.id ? <div className="delete-confirm"><span>Delete?</span><button onClick={() => onDelete(log.id)}>Yes</button><button onClick={onDeleteCancel}>No</button></div> : <div className="row-menu"><button onClick={() => onEdit(log)}>Edit</button><button onClick={() => onDeleteAsk(log.id)}>Delete</button></div>}
          </article>
        ))}</div> : <EmptyState title="No sessions yet." copy="Your completed sessions will live here, ready to correct or delete." />}
      </section>
    </div>
  );
}

function PlanSettings({ plan, onChange, onSave }: { plan: Plan; onChange: (plan: Plan) => void; onSave: () => void }) {
  return (
    <div className="section-view settings-view">
      <div className="section-heading"><p className="eyebrow">Your rhythm</p><h1>Plan, not pressure.</h1><p>Change the plan whenever life changes. Earned practice is never reduced.</p></div>
      <section className="settings-card"><PlanFields plan={plan} onChange={onChange} /><Button onClick={onSave}>Save plan</Button></section>
      <aside className="info-card"><strong>What Knufl does</strong><p>Knufl helps you follow through on an exercise plan you already understand. This prototype does not prescribe workouts, exercises or intensity.</p></aside>
    </div>
  );
}

function SettingsView({
  profile,
  onChange,
  onSave,
  exportHref,
  exportFilename,
  onExport,
  onImport,
  importError,
  resetArmed,
  onArmReset,
  onCancelReset,
  onReset,
}: {
  profile: Profile;
  onChange: (profile: Profile) => void;
  onSave: () => void;
  exportHref: string;
  exportFilename: string;
  onExport: () => void;
  onImport: (file?: File) => void;
  importError: string;
  resetArmed: boolean;
  onArmReset: () => void;
  onCancelReset: () => void;
  onReset: () => void;
}) {
  return (
    <div className="section-view settings-view">
      <div className="section-heading"><p className="eyebrow">You & your Knufl</p><h1>Still your team.</h1><p>{profile.name || 'Your Knufl'}’s name stays editable. Everything you’ve earned stays with the team.</p></div>
      <section className="settings-card">
        <label className="form-field"><FieldLabel>Companion name</FieldLabel><input value={profile.name} onChange={(event) => onChange({ ...profile, name: event.target.value })} /></label>
        <Button onClick={onSave} disabled={!profile.name.trim()}>Save name</Button>
      </section>
      <section className="settings-card data-card">
        <p className="eyebrow">Local progress</p><h2>Stored on this device.</h2><p>Knufl uses this browser’s local storage. There is no account or cloud sync, so another browser won’t have this progress unless you export and import it.</p>
        <div className="split-actions"><a className="button button--secondary" href={exportHref} download={exportFilename} onClick={onExport}>Export progress</a><label className="button button--secondary file-button">Import progress<input type="file" accept="application/json,.json" onChange={(event) => onImport(event.target.files?.[0])} /></label></div>
        {importError && <p className="form-error" role="alert">{importError}</p>}
      </section>
      <section className="settings-card danger-card">
        <h2>Reset Knufl</h2><p>This permanently removes identity, plan, session logs, memories and milestones from this browser.</p>
        {!resetArmed ? <Button variant="danger" onClick={onArmReset}>Reset local progress</Button> : <div className="reset-confirm"><p><strong>Are you sure?</strong> Export first if you want a backup.</p><div className="split-actions"><Button variant="quiet" onClick={onCancelReset}>Cancel</Button><Button variant="danger" onClick={onReset}>Yes, reset everything</Button></div></div>}
      </section>
    </div>
  );
}

function EmptyState({ title, copy }: { title: string; copy: string }) {
  return <div className="empty-state"><span>○</span><h3>{title}</h3><p>{copy}</p></div>;
}
