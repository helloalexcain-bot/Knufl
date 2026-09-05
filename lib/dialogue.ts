export const HOME_DIALOGUE = [
  'Fancy moving together?',
  'I brought the enthusiasm. Coordination is en route.',
  'The mat is ready. My paws too.',
  'Same team, whatever today looks like.',
] as const;

export const savedDialogue = (name: string, duration?: number): string =>
  duration
    ? `${duration} ${duration === 1 ? 'minute' : 'minutes'}. We showed up. My balance? Still a work in progress. Paw tap?`
    : `We showed up, ${name}. My balance? Still a work in progress. Paw tap?`;

export const sameDayDialogue = (name: string): string =>
  `Another session logged, ${name}. Today’s practice credit is already tucked away.`;

export const RETURN_DIALOGUE =
  'Good to see you, teammate. The mat is ready. My paws too. Fancy a restart?';

export const REST_DIALOGUE =
  'Rest day. I’ll keep the mat warm and practise being very still. No promises.';
