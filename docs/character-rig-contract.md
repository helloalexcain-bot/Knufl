# Knufl first animation milestone — artist handoff

Status: the app now renders an **articulated 3D study**, not the approved final character. The five approved PNGs in `public/bram/` are untouched and remain the visual authority.

## Implemented study, and its limits

`public/character/knufl-study.glb` is a self-contained, approximately 1 MB glTF 2.0 maquette, reproducible with `node scripts/build-character-study.mjs`. It has a real 3D mesh hierarchy, separate torso/head/jaw/eyes/shoulders/paws, PBR materials and geometric surface nap. It does not move, scale or switch a PNG to simulate speech.

The WebGL renderer connects the existing controller to breathing, uneven blinks, attentive gaze/tilt, output-audio RMS mouth opening, restrained head/paw gestures, an occasional weighted shift/recovery and a paw-tap cue. Exponential settling handles interruption. Reduced motion suppresses idle/gesture movement while retaining speech mouth motion. No WebGL means an explicitly labelled approved still fallback.

**Not production-ready:** this is a node-articulated construction, not a continuously skinned sculpt. Its geometric nap is not the approved plush fur; cheek, mouth, paws, shoulder joins and expression need artist refinement. Amplitude-driven jaw movement is not phoneme/viseme-accurate lip sync. The maquette has many mesh draws and is not certified against the earlier mobile performance budget. No claim of lifelike final animation or physical-iPhone performance is made.

The available environment had no Blender installation or connected 3D-generation service. Three.js was used to author, export, load and inspect a genuine articulated study; no services were purchased.

## Minimum replacement asset

Deliver one self-contained `knufl.glb` plus editable source and material textures, with rights to modify/use them in Knufl. Match the approved cream plush silhouette, short legs, sage belly, brown extremities, large padded paws, expressive eyebrows and cheeky asymmetry. Include front/side/three-quarter comparison renders for Alex’s approval.

Use Y-up, feet at ground Y=0, front +Z and an in-place root. Provide:

- A smoothly skinned torso/neck/head and articulated shoulders/paws. Enough leg/hip control for a small planted shift and recovery, not a locomotion system.
- A jaw/open-mouth shape, independent complete blinks, gaze and readable brows. Jaw-open must compose with a soft smile without intersections.
- Mobile-safe baked fur normals/roughness and a restrained fur silhouette. No runtime hair simulation.
- A neutral pose and just two authored one-shots if needed for the final quality: weighted shift/recovery and warm paw tap. Breathing, gaze, blink and amplitude mouth can use the existing procedural integration.

**Bone names are not acceptance criteria.** `lib/character-rig-map.ts` maps semantic roles to arbitrary asset node names. Its optional morph bindings map jaw/blinks to named targets on any mesh. Supply the mapping with the asset. The first milestone does not require the previous full clip/viseme catalogue. Optional phoneme targets or additional clips are future work, not a blocker.

Target under 8 MB network download, 60k triangles and 8 character draw calls, with textures at most 2048px. These are artist targets, not measurements achieved by the maquette.

## Acceptance

Validate the GLB, compare its neutral/listening/paw-tap poses to the references, and inspect real speech plus interruption at 390×844 and desktop. Ears/paw/feet must remain in frame. Ensure quiet movement between sets, planted feet through recovery and a smooth interruption settle. Test reduced motion and WebGL failure. Finally measure sustained frame rate/thermal behaviour and Safari speaker/Bluetooth playback on Alex’s physical iPhone.

References: [Three.js GLTFLoader](https://threejs.org/docs/pages/GLTFLoader.html), [GLTFExporter](https://threejs.org/docs/pages/GLTFExporter.html).
