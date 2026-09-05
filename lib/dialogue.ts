export const HOME_DIALOGUE = [
  'Fancy moving together?',
  'I brought the enthusiasm. Coordination is en route.',
  'The mat is ready. My paws too.',
  'Same team, whatever today looks like.',
] as const;

export const savedDialogue = (duration?: number): string =>
  duration
    ? `${duration} ${duration === 1 ? 'minute' : 'minutes'}. We showed up. My balance? Still a work in progress. Paw tap?`
    : 'We showed up. My balance? Still a work in progress. Paw tap?';

export const sameDayDialogue = (): string =>
  'Another session logged. Today’s practice credit is already tucked away. I checked twice.';

export const activityAcknowledgement = (activity: string): string => {
  const label = activity.trim() || 'Session';
  switch (label.toLocaleLowerCase()) {
    case 'walking':
      return 'Walk logged. I found our rhythm eventually. My paws took the scenic route.';
    case 'running':
      return 'Run logged. We moved; I supplied the determined little wobble.';
    case 'cycling':
      return 'Ride logged. I kept up beautifully in spirit.';
    case 'strength':
      return 'Strength logged. I held the brave face; my knees held a tiny meeting.';
    default:
      return `${label} logged. We showed up together. I brought the determined little wobble.`;
  }
};

export const RETURN_DIALOGUE =
  'Good to see you, teammate. The mat is ready. My paws too. Fancy a restart?';

export const REST_DIALOGUE =
  'Rest day. I’ll keep the mat warm and practise being very still. No promises.';
