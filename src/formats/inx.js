import { BinaryReader } from '../io/BinaryReader.js';
import {
  SIZES,
  FIXED,
  MOTION_INFO_MAX,
  MOTION_TOOL_MAX,
  MOTION_SKIL_MAX,
  NPC_MOTION_INFO_MAX,
  TALK_MOTION_INFO_MAX,
  TALK_MOTION_FILE_MAX,
  INX_SIZE_CLASSIC,
  INX_SIZE_KPT,
  FRAMES_PER_TICK,
  motionStateName,
} from './constants.js';

/**
 * `ModelGroup` — 68 bytes. Level-of-detail mesh names.
 * @param {BinaryReader} r
 */
export function readModelGroup(r) {
  const start = r.offset;
  const count = r.i32();
  const names = [];
  for (let i = 0; i < 4; i++) names.push(r.str(16));
  r.expect(start + SIZES.MODEL_GROUP, 'ModelGroup');
  return { count, names };
}

/**
 * Read one 4-byte frame key.
 *
 * The Java reference's `readKey()` returns `(b0 + b2) << 8`, which is an
 * operator-precedence bug (`|` and a shift were intended) and does not agree
 * with its own downstream use of `value / 256`. Since the field occupies four
 * bytes either way, this reads a plain little-endian int32; the caller divides
 * by 256 to get ticks, which is consistent with the 24.8 fixed-point
 * convention used everywhere else in the format.
 * @param {BinaryReader} r
 */
function readFrameKey(r) {
  return r.i32();
}

/**
 * `MotionInfo` — 120 bytes (classic) or 172 bytes (KPT).
 * Describes one animation clip as a frame range into the shared motion file.
 * @param {BinaryReader} r
 * @param {boolean} kpt
 */
export function readMotionInfo(r, kpt) {
  const start = r.offset;

  const state = r.i32();

  const motionStartRaw = readFrameKey(r);
  const talkStartRaw = readFrameKey(r);
  const keyword2Raw = readFrameKey(r);
  const endRaw = readFrameKey(r);

  const eventRaw = [readFrameKey(r), readFrameKey(r), readFrameKey(r), readFrameKey(r)];

  const itemCodeCount = r.i32();
  const itemCodeList = Uint8Array.from(r.bytes(MOTION_TOOL_MAX));
  const jobCodeBits = r.i32();
  const skillCodeList = Uint8Array.from(r.bytes(MOTION_SKIL_MAX));

  if (kpt) r.skip(52);

  const mapPosition = r.i32();
  const repeat = r.i32();
  const keyCode = r.u16();
  r.skip(2); // padding
  const motionFrame = r.i32();

  r.expect(start + (kpt ? SIZES.MOTION_INFO_KPT : SIZES.MOTION_INFO), 'MotionInfo');

  // Ticks are 24.8 fixed-point; one tick is FRAMES_PER_TICK animation frames.
  const startTick = Math.round(motionStartRaw / FIXED);
  const talkStartTick = Math.round(talkStartRaw / FIXED);
  const endTick = Math.round(endRaw / FIXED);

  return {
    state,
    name: motionStateName(state),
    motionStartRaw,
    talkStartRaw,
    keyword2Raw,
    endRaw,
    startTick,
    talkStartTick,
    endTick,
    eventTicks: eventRaw.map((v) => Math.round(v / FIXED)),
    itemCodeCount,
    itemCodeList,
    jobCodeBits,
    skillCodeList,
    mapPosition,
    repeat,
    keyCode,
    motionFrame,
    /** True when the clip is meant to play backwards. */
    get reversed() {
      return this.endTick < this.effectiveStartTick;
    },
    /** Talk motions store their start in `talkStartTick` instead. */
    get effectiveStartTick() {
      return this.startTick > 0 ? this.startTick : this.talkStartTick;
    },
    /** Inclusive animation-frame range, normalised so start <= end. */
    get frameRange() {
      const a = this.effectiveStartTick * FRAMES_PER_TICK;
      const b = this.endTick * FRAMES_PER_TICK;
      return a <= b ? [a, b] : [b, a];
    },
  };
}

/**
 * Parse an `.inx` animation index.
 *
 * Two variants exist, distinguished only by file size:
 *   67,084 bytes -> classic, `MotionInfo` is 120 bytes
 *   95,268 bytes -> KPT,     `MotionInfo` is 172 bytes
 *
 * @param {ArrayBuffer|Uint8Array} buffer
 */
export function parseINX(buffer) {
  const r = new BinaryReader(buffer);
  const size = r.length;

  let kpt;
  if (size === INX_SIZE_CLASSIC) kpt = false;
  else if (size === INX_SIZE_KPT) kpt = true;
  else if (size > INX_SIZE_CLASSIC)
    kpt = true; // matches the Java heuristic
  else {
    throw new Error(
      `pt-loader: unexpected .inx size ${size}; expected ${INX_SIZE_CLASSIC} (classic) ` +
        `or ${INX_SIZE_KPT} (KPT)`,
    );
  }

  const modelFile = r.str(64);
  const motionFile = r.str(64);
  const subModelFile = r.str(64);

  const highModel = readModelGroup(r);
  const defaultModel = readModelGroup(r);
  const lowModel = readModelGroup(r);

  const allMotions = [];
  for (let i = 0; i < MOTION_INFO_MAX; i++) allMotions.push(readMotionInfo(r, kpt));

  const subMotionCount = r.i16();
  r.skip(2); // padding

  const fileTypeKeyWord = r.i32();
  const linkFileKeyWord = r.i32();

  const motionLinkFile = r.str(64);
  const talkLinkFile = r.str(64);
  const talkMotionFile = r.str(64);

  const allTalkMotions = [];
  for (let i = 0; i < TALK_MOTION_INFO_MAX; i++) allTalkMotions.push(readMotionInfo(r, kpt));

  const talkMotionCount = r.i32();

  const npcMotionRate = Array.from(r.i32Array(NPC_MOTION_INFO_MAX));
  const npcMotionRateCnt = Array.from(r.i32Array(100));
  const talkMotionRate = Array.from(r.i32Array(TALK_MOTION_INFO_MAX));
  const talkMotionRateCnt = [];
  for (let i = 0; i < TALK_MOTION_FILE_MAX; i++) {
    talkMotionRateCnt.push(Array.from(r.i32Array(100)));
  }

  // Only entries with a non-zero state describe a real clip.
  const motions = allMotions
    .slice(0, subMotionCount > 0 ? subMotionCount : MOTION_INFO_MAX)
    .filter((m) => m.state !== 0 && m.endTick !== 0);
  const talkMotions = allTalkMotions
    .slice(0, talkMotionCount > 0 ? talkMotionCount : TALK_MOTION_INFO_MAX)
    .filter((m) => m.state !== 0 && m.endTick !== 0);

  return {
    type: 'inx',
    kpt,
    modelFile,
    motionFile,
    subModelFile,
    highModel,
    defaultModel,
    lowModel,
    motions,
    talkMotions,
    subMotionCount,
    talkMotionCount,
    fileTypeKeyWord,
    linkFileKeyWord,
    /** Non-empty when this model borrows another model's animation file. */
    motionLinkFile,
    talkLinkFile,
    talkMotionFile,
    npcMotionRate,
    npcMotionRateCnt,
    talkMotionRate,
    talkMotionRateCnt,
  };
}
