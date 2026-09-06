// Semantic channels decouple controller intent from an artist's bone names.
export const STUDY_RIG = {
  asset: '/character/knufl-study.glb',
  status: 'provisional-articulated-study',
  nodes: {
    root:'Study_Root', hips:'Study_Hips', torso:'Study_Torso', head:'Study_Head',
    jaw:'Study_Jaw', mouth:'Study_Mouth', leftEye:'Study_EyeL', rightEye:'Study_EyeR',
    leftGaze:'Study_GazeL', rightGaze:'Study_GazeR', leftBrow:'Study_BrowL', rightBrow:'Study_BrowR',
    leftShoulder:'Study_ShoulderL', rightShoulder:'Study_ShoulderR', leftPaw:'Study_PawL', rightPaw:'Study_PawR',
    leftLeg:'Study_LegL', rightLeg:'Study_LegR',
  },
} as const;
export type RigRole = keyof typeof STUDY_RIG.nodes;
export interface RigMapping {
  asset: string;
  status: string;
  nodes: Partial<Record<RigRole,string>>;
  // Optional artist morphs replace the maquette's eye/mouth scale channels.
  morphs?: Partial<Record<'jawOpen'|'blinkLeft'|'blinkRight', { node:string; target:string }>>;
}
