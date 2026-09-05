# Knufl production character asset contract

Status: **production character asset missing**. This contract is the handoff gate for replacing the development demonstrator.

## Current asset audit

The repository contains five approved raster pose references:

| File | Size | Alpha | Intended reference |
| --- | ---: | --- | --- |
| `public/bram/hero.png` | 680×680 | No | Primary silhouette, fur, face and raised paw |
| `public/bram/wave.png` | 380×390 | No | Greeting |
| `public/bram/wobble.png` | 390×390 | No | Comic balance |
| `public/bram/balance.png` | 410×350 | No | Quiet determination / Little Mountain |
| `public/bram/pawtap.png` | 390×390 | No | Celebration |

They are flattened RGB PNG renders with their backgrounds baked in. There is no 3D mesh, skeleton, skinning, animation clip, facial rig, morph target, material source, depth information, or editable production source in the repository. The small clipped dark fragment at the top edge of `hero.png` is also baked into that raster.

The current character UI may switch these approved poses in response to real controller events. That is deliberately labelled a **development animation demonstrator**. Pose switching, CSS transforms, or moving/scaling one of these PNGs is not a completed lifelike character and must not pass final visual acceptance.

## Required delivery

Deliver all of the following together:

1. `public/character/knufl.glb` — self-contained glTF 2.0 binary export with no external URIs.
2. `character-source/knufl.blend` (or the original application's equivalent editable file) with an uncollapsed rig and editable materials.
3. Original texture source files at their working resolution.
4. A clip manifest mapping authored clip names to the names below, including loop/one-shot intent and duration.
5. A signed licence/readme confirming original authorship or full provenance and perpetual rights to modify and reuse the character, rig, textures and animations in the Knufl product, marketing and store materials. List any third-party tools/assets and their licences.
6. At least one front, side and three-quarter turntable render for visual comparison with the approved PNG references.

Do not substitute a stock bear, generated video, sprite loop or unrelated generic rig.

## Coordinate, hierarchy and mesh contract

- glTF 2.0 / GLB, metres, Y-up, right-handed. At identity, feet rest on Y=0, the root is at ground centre, and the character faces +Z.
- Stable top-level node names: `KnuflRoot`, `KnuflArmature`, `KnuflBody`, `KnuflEyes`, `KnuflMouth`.
- `KnuflRoot` owns scale/placement. Animation clips must not translate it away from the origin; deliberate in-place body motion belongs below the root.
- Required deform/control bones (case-sensitive): `Root`, `Hips`, `Spine`, `Chest`, `Neck`, `Head`, `Jaw`, `Eye_L`, `Eye_R`, `Brow_L`, `Brow_R`, `Ear_L`, `Ear_R`, `Shoulder_L`, `UpperArm_L`, `LowerArm_L`, `Hand_L`, `Shoulder_R`, `UpperArm_R`, `LowerArm_R`, `Hand_R`, `UpperLeg_L`, `LowerLeg_L`, `Foot_L`, `UpperLeg_R`, `LowerLeg_R`, `Foot_R`.
- Mesh deforms must preserve the approved round silhouette, short legs, readable eyebrows, asymmetric cheeky expression, oversized padded paws, cream fur, brown extremities and muted sage belly patch.
- No simulation-dependent fur. Use mobile-safe geometry, cards/shells, baked normals and roughness to suggest plush fur. The character must remain recognisable with all optional fur layers disabled.
- Bind pose must be neutral and free of intersections around the jaw, belly, shoulders and hips. Paw pads need enough topology to read during close greeting/celebration shots.

## Face, eyes and lip sync

Required morph target names on `KnuflMouth`/`KnuflBody` as appropriate:

`blink_L`, `blink_R`, `eyesWide`, `browInnerUp`, `browDown_L`, `browDown_R`, `smile_L`, `smile_R`, `frown_L`, `frown_R`, `cheekRaise`, `jawOpen`, `mouthClose`, `mouthFunnel`, `mouthPucker`.

Required viseme targets (the controller's optional `CharacterViseme` set):

`viseme_sil`, `viseme_PP`, `viseme_FF`, `viseme_TH`, `viseme_DD`, `viseme_kk`, `viseme_CH`, `viseme_SS`, `viseme_nn`, `viseme_RR`, `viseme_aa`, `viseme_E`, `viseme_ih`, `viseme_oh`, `viseme_ou`.

- `Jaw`/`jawOpen` must support amplitude-driven speech when viseme timings are unavailable.
- Eye bones must accept the controller's clamped horizontal/vertical gaze without leaving the sockets. The renderer, not the asset, limits gaze and adds head follow.
- Independent blinks must fully close without clipping. Brow shapes must remain readable at phone size.
- All facial targets must combine cleanly at representative partial weights; no target may depend on an unexported driver.

## Animation clips

Every clip is in place, starts/ends on a compatible neutral pose, and includes no camera, light or root-scale tracks. Required names are case-sensitive.

State loops:

- `state_idle` — gentle breathing, irregular-blink-compatible neutral base.
- `state_listening` — attentive, quiet loop.
- `state_thinking` — restrained thinking loop.
- `state_speaking` — low-motion base under procedural face/head/paw layers.
- `state_ready` — attentive neutral stance.
- `state_resting` — quiet loop with no large distracting motion.

One-shots matching `CharacterGesture` cues:

- `greeting-wave`, `greeting-paw-to-heart`
- `listening-head-tilt`, `listening-small-nod`
- `thinking-paw-to-chin`, `thinking-small-wobble`
- `speaking-conversational-paw`, `speaking-small-nod`
- `ready-paw-tap`, `ready-settle`
- `resting-timer-glance`
- `celebrating-paw-tap`, `celebrating-little-mountain`
- `comforting-paw-to-heart`, `comforting-gentle-nod`
- `farewell-wave`, `farewell-small-bow`
- `interrupt-settle`, `reconnect-attentive`
- `idle-weight-shift`, `idle-self-check`

`idle-breathe` and `resting-breathe` may map to their corresponding state loops. `reduced-settle` and `reduced-emphasis` are renderer-level blends into a still neutral pose; they do not require large authored motion.

`celebrating-little-mountain` must be a short, grounded evolution of the approved balance pose. It is triggered only by an earned milestone operation key; reconnecting or retrying must not replay it.

## Materials and measured mobile budgets

Initial acceptance budgets, to be revised only after profiling the actual target iPhone:

- GLB download: ≤ 8 MB compressed over the network; ≤ 14 MB uncompressed asset payload.
- Rendered triangles: ≤ 60,000 at the closest stage view; provide an optional ≤ 25,000 triangle LOD if the primary mesh exceeds 40,000.
- Skinned bones: ≤ 75; skin influences: ≤ 4 per vertex.
- Active morph targets: ≤ 8 concurrently; authored total: ≤ 32.
- Draw calls for the character: ≤ 8.
- Texture memory: ≤ 48 MB decoded; maximum individual texture dimension 2048×2048.
- Materials: glTF metallic-roughness PBR, opaque or masked where possible. Base colour/emissive use sRGB; normal/roughness/occlusion use linear sampling.
- No required runtime shader compilation outside the app's documented renderer; provide a plain PBR fallback for every custom material.
- Target stable 30 fps or better during listening/speaking on the nominated iPhone, with no sustained main-thread frame above 33 ms after warm-up.

Texture compression may be supplied as KTX2/Basis, but the checked-in delivery must retain a tested fallback path for browsers where the selected compression/transcoder fails. Avoid transparent full-body fur layers and expensive per-pixel subsurface simulations.

## Integration and acceptance checks

- Validate `knufl.glb` with the Khronos glTF Validator with no errors.
- Load on current iOS Safari and a representative Android Chrome device without external file requests, missing textures or shader errors.
- Exercise all required clips, morph targets and eye/jaw controls through `lib/character-controller.ts`.
- Verify interruption stops output audio and mouth/paw motion within one rendered frame after the controller event.
- Verify reconnect/error states use `reconnect-attentive` or a still neutral pose and never replay an achievement.
- Verify `prefers-reduced-motion` selects a still/subtle blend while status, gaze and lip-sync meaning remain understandable.
- Inspect ears, raised paw and feet at 390×844 and desktop stage sizes; nothing essential may be clipped.
- Compare neutral, greeting, balance and paw-tap captures against the approved raster references before visual sign-off.

Until this complete delivery is integrated and inspected, the production-lifelike character remains an explicit external asset dependency.
