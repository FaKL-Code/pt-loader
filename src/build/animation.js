import * as THREE from 'three';
import { FRAMES_PER_SECOND, FRAMES_PER_TICK } from '../formats/constants.js';
import { trackBindRotation } from './math.js';

/**
 * Extract per-bone keyframe data from a parsed skeleton.
 *
 * Two conversions happen here, and both are essential:
 *
 * **Rotations are deltas.** Each `TransRotation` key is relative to the
 * previous one, so they must be accumulated. Treating them as absolute leaves a
 * character frozen in its first pose — the single most common porting failure.
 *
 * **jME stores tracks relative to the bind pose; three.js stores them
 * absolute.** The reference loader subtracts the bind position, divides by the
 * bind scale, and pre-multiplies by the inverse bind rotation, because
 * jMonkeyEngine re-applies the bind pose at playback. three.js does not, so
 * positions and scales are emitted raw and rotations are emitted as
 * `bindRotation * accumulatedDelta`.
 *
 * @param {object} obj a parsed `GeomObject` acting as a bone
 * @returns {{rot:{times:number[], values:THREE.Quaternion[]},
 *            pos:{times:number[], values:number[][]},
 *            scale:{times:number[], values:number[][]}}}
 */
export function extractBoneTracks(obj) {
  const bindRot = trackBindRotation(obj);
  const bindRotInv = bindRot.clone().invert();

  // ---- rotation: accumulate deltas, then re-anchor on the bind rotation ----
  const rotKeys = obj.rotTrack.slice().sort((a, b) => a.frame - b.frame);
  const rotTimes = [];
  const rotValues = [];
  const acc = new THREE.Quaternion(); // identity

  for (let j = 0; j < rotKeys.length; j++) {
    const k = rotKeys[j];
    const q = new THREE.Quaternion(-k.x, -k.y, -k.z, k.w);

    if (j === 0) {
      // The first key is expressed against the bind pose rather than against a
      // previous frame. When it *is* the bind pose, the delta is identity.
      const dx = obj.qx - k.x;
      const dy = obj.qy - k.y;
      const dz = obj.qz - k.z;
      const dw = obj.qw - k.w;
      if (dx * dx + dy * dy + dz * dz + dw * dw === 0) q.identity();
      else q.premultiply(bindRotInv);
    }

    q.multiply(acc).normalize();
    acc.copy(q);

    rotTimes.push(k.frame);
    rotValues.push(bindRot.clone().multiply(q).normalize());
  }

  // ---- position and scale: already absolute ----
  const posKeys = obj.posTrack.slice().sort((a, b) => a.frame - b.frame);
  const scaleKeys = obj.scaleTrack.slice().sort((a, b) => a.frame - b.frame);

  return {
    rot: { times: rotTimes, values: rotValues },
    pos: { times: posKeys.map((k) => k.frame), values: posKeys.map((k) => [k.x, k.y, k.z]) },
    scale: {
      times: scaleKeys.map((k) => k.frame),
      values: scaleKeys.map((k) => [k.x, k.y, k.z]),
    },
    bind: {
      position: [obj.px, obj.py, obj.pz],
      quaternion: bindRot,
      scale: [obj.sx || 1, obj.sy || 1, obj.sz || 1],
    },
  };
}

/**
 * Slice a channel to a frame window and rebase its times to start at zero.
 *
 * A channel with no key inside the window would otherwise vanish and snap the
 * bone to its rest pose, so the last value at or before the window start is
 * held as a single key.
 */
function sliceChannel(times, values, startFrame, endFrame, fallback) {
  const outT = [];
  const outV = [];

  for (let i = 0; i < times.length; i++) {
    if (times[i] >= startFrame && times[i] <= endFrame) {
      outT.push((times[i] - startFrame) / FRAMES_PER_SECOND);
      outV.push(values[i]);
    }
  }

  if (outT.length === 0) {
    let held = fallback;
    for (let i = 0; i < times.length; i++) {
      if (times[i] <= startFrame) held = values[i];
      else break;
    }
    if (held === undefined || held === null) return null;
    outT.push(0);
    outV.push(held);
  }

  return { times: outT, values: outV };
}

function flatten(values) {
  const out = [];
  for (const v of values) out.push(v[0], v[1], v[2]);
  return out;
}

function flattenQuat(values) {
  const out = [];
  for (const q of values) out.push(q.x, q.y, q.z, q.w);
  return out;
}

/**
 * Build one `THREE.AnimationClip` from pre-extracted bone tracks.
 *
 * @param {string} name
 * @param {{boneName:string, tracks: ReturnType<typeof extractBoneTracks>}[]} bones
 * @param {number|null} startFrame inclusive; null means the whole animation
 * @param {number|null} endFrame inclusive
 */
export function buildClip(name, bones, startFrame = null, endFrame = null) {
  const tracks = [];
  const whole = startFrame === null || endFrame === null;
  const from = whole ? 0 : startFrame;
  const to = whole ? Number.MAX_SAFE_INTEGER : endFrame;

  for (const { boneName, tracks: t } of bones) {
    const rot = sliceChannel(t.rot.times, t.rot.values, from, to, t.bind.quaternion);
    if (rot) {
      tracks.push(
        new THREE.QuaternionKeyframeTrack(
          `${boneName}.quaternion`,
          rot.times,
          flattenQuat(rot.values),
        ),
      );
    }

    if (t.pos.times.length > 0) {
      const pos = sliceChannel(t.pos.times, t.pos.values, from, to, t.bind.position);
      if (pos) {
        tracks.push(
          new THREE.VectorKeyframeTrack(`${boneName}.position`, pos.times, flatten(pos.values)),
        );
      }
    }

    if (t.scale.times.length > 0) {
      const sc = sliceChannel(t.scale.times, t.scale.values, from, to, t.bind.scale);
      if (sc) {
        tracks.push(
          new THREE.VectorKeyframeTrack(`${boneName}.scale`, sc.times, flatten(sc.values)),
        );
      }
    }
  }

  if (tracks.length === 0) return null;

  const duration = whole ? -1 : (to - from) / FRAMES_PER_SECOND;
  const clip = new THREE.AnimationClip(name, duration, tracks);
  if (whole) clip.resetDuration();
  return clip;
}

/**
 * Build every animation clip for a skeleton.
 *
 * Without an `.inx` the skeleton holds a single monolithic animation, returned
 * as `"Full"`. With an `.inx`, each `MotionInfo` becomes its own clip, named
 * after its `State`. Duplicate names are suffixed (`Attack`, `Attack.1`, ...).
 *
 * Clips whose end tick precedes their start tick are meant to play backwards;
 * they are emitted forwards and flagged in `reversed`, so the caller can set
 * `action.timeScale = -1`.
 *
 * @param {{objects: object[]}} skeletonPat parsed `.smb`
 * @param {object|null} inx parsed `.inx`, or null
 * @returns {{clips: Record<string, THREE.AnimationClip>, reversed: Set<string>,
 *   byState: Record<number, string>, full: THREE.AnimationClip|null}}
 */
export function buildClips(skeletonPat, inx = null) {
  const bones = skeletonPat.objects
    .filter((o) => o.rotTrack.length || o.posTrack.length || o.scaleTrack.length)
    .map((o) => ({
      boneName: THREE.PropertyBinding.sanitizeNodeName(o.nodeName),
      tracks: extractBoneTracks(o),
    }));

  const clips = {};
  const reversed = new Set();
  const byState = {};

  const full = bones.length ? buildClip('Full', bones, null, null) : null;
  if (full) clips.Full = full;

  if (!inx) return { clips, reversed, byState, full };

  const motions = [...inx.motions, ...inx.talkMotions];
  const used = new Map();

  for (const m of motions) {
    const [startFrame, endFrame] = m.frameRange;
    if (endFrame <= startFrame) continue;

    let name = m.name;
    const n = used.get(name) ?? 0;
    used.set(name, n + 1);
    if (n > 0) name = `${name}.${n}`;

    const clip = buildClip(name, bones, startFrame, endFrame);
    if (!clip) continue;

    clips[name] = clip;
    byState[m.state] = name;
    if (m.reversed) reversed.add(name);
  }

  return { clips, reversed, byState, full };
}

/** Convert an animation frame number to seconds. */
export function frameToSeconds(frame) {
  return frame / FRAMES_PER_SECOND;
}

/** Convert a tick (as stored in `.inx`) to an animation frame number. */
export function tickToFrame(tick) {
  return tick * FRAMES_PER_TICK;
}
