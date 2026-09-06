import type { CharacterControllerSnapshot } from './character-controller.ts';
export interface MotionPose { breath:number; shift:number; headTilt:number; headNod:number; gazeX:number; gazeY:number; blink:number; mouth:number; paw:number; tap:number }
export const neutralMotion = (): MotionPose => ({breath:0,shift:0,headTilt:0,headNod:0,gazeX:0,gazeY:0,blink:0,mouth:0,paw:0,tap:0});
const smooth = (v:number) => { const x=Math.max(0,Math.min(1,v)); return x*x*(3-2*x); };
const pulse = (t:number,attack:number,hold:number,end:number) => smooth(t/attack)*(1-smooth((t-hold)/(end-hold)));
export function motionTarget(s:Readonly<CharacterControllerSnapshot>, now:number, elapsed:number): MotionPose {
  const reduced=s.motionMode==='reduced', speaking=s.state==='speaking', listening=s.state==='listening';
  const t=elapsed/1000, cycle=t%18.7;
  // Uneven blink intervals, including an occasional second blink. Not a looped bounce.
  const blinkTimes=[2.2,6.9,7.25,12.8,17.4];
  const blink=blinkTimes.reduce((v,at)=>Math.max(v,pulse(cycle-at,.07,.10,.22)),0);
  const gesture=s.gesture, age=gesture?(now-gesture.startedAt)/1000:99;
  const tapping=gesture?.name.includes('paw-tap') ?? false;
  // Anticipation, contact, then delayed follow-through over a planted base.
  const tap=tapping ? pulse(age-.10,.30,.55,1.25)*gesture!.intensity : 0;
  const shiftCycle=t%27.3;
  const shift= s.state==='idle' || s.state==='ready' ?
    -.10*pulse(shiftCycle-19,.45,.55,1.2)+.18*pulse(shiftCycle-19.6,.5,.6,1.6)-.04*pulse(shiftCycle-20.8,.3,.4,1.0) : 0;
  return {
    breath: reduced?0:Math.sin(t*1.55)*.006,
    shift:reduced?0:shift,
    headTilt:reduced?0:listening?.075:s.state==='thinking'?-.045:speaking?Math.sin(t*1.3)*.02:0,
    headNod:reduced?0:speaking?Math.sin(t*2.1)*.025:tap*.045,
    gazeX:reduced?0:s.gaze.horizontal*.035+(listening?.012:Math.sin(t*.43)*.006),
    gazeY:reduced?0:s.gaze.vertical*.025,
    blink:reduced?0:blink,
    mouth:speaking?Math.min(1,Math.max(0,s.speechAmplitude*1.5)):0,
    paw:reduced?0:speaking?.10*pulse(t%5.4,.6,1.25,2.6):s.state==='greeting'?.24*pulse(age,.35,.6,1.5):0,
    tap:reduced?0:tap,
  };
}
export function stepMotion(current:MotionPose,target:MotionPose,dt:number):MotionPose {
  const result={...current};
  for(const key of Object.keys(result) as (keyof MotionPose)[]) {
    const speed=key==='mouth'?24:key==='blink'?48:8;
    result[key]+=(target[key]-result[key])*(1-Math.exp(-speed*Math.min(.1,Math.max(0,dt))));
  }
  return result;
}
