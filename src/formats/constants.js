/** Structure sizes, in bytes. Every one of these is asserted by the parsers. */
export const SIZES = {
  FRAME_POS: 16,
  SMD_FILE_HEADER: 556,
  SMD_FILE_OBJ_INFO: 40,
  MATERIAL_GROUP: 88,
  MATERIAL: 320,
  TEXLINK: 32,
  VERTEX: 24,
  FACE: 36,
  GEOM_OBJECT: 2236,
  MATRIX4: 64,
  TRANS_ROTATION: 20,
  TRANS_POSITION: 16,
  TRANS_SCALE: 16,
  STAGE: 262260,
  STAGE_AREA: 262144,
  STAGE_VERTEX: 28,
  STAGE_FACE: 28,
  LIGHT3D: 26,
  MODEL_GROUP: 68,
  MOTION_INFO: 120,
  MOTION_INFO_KPT: 172,
};

/** `OBJ_FRAME_SEARCH_MAX` in the original C source. */
export const OBJ_FRAME_SEARCH_MAX = 32;

/** Fixed-point divisor. Nearly every geometric integer is 24.8 fixed-point. */
export const FIXED = 256;

/** Maximum objects a PAT3D can hold (hard cap in the original engine). */
export const MAX_OBJECTS = 128;

/** INX table sizes. */
export const MOTION_INFO_MAX = 512;
export const MOTION_LIST_MAX = 32;
export const MOTION_TOOL_MAX = 52;
export const MOTION_SKIL_MAX = 8;
export const NPC_MOTION_INFO_MAX = 30;
export const TALK_MOTION_INFO_MAX = 30;
export const TALK_MOTION_FILE_MAX = 2;

/** Exact byte lengths of the two INX variants — used to pick MotionInfo size. */
export const INX_SIZE_CLASSIC = 67084;
export const INX_SIZE_KPT = 95268;

/** `_Material.BlendType` values (`SMMAT_BLEND_*`). */
export const BLEND = {
  NONE: 0,
  ALPHA: 1,
  COLOR: 2,
  SHADOW: 3,
  LAMP: 4,
  ADDCOLOR: 5,
  INVSHADOW: 6,
};

/** `_Material.TextureType` values (`SMTEX_TYPE_*`). */
export const TEX_TYPE = {
  MULTIMIX: 0,
  ANIMATION: 1,
};

/** `_Material.UseState` / `MeshState` / `WindMeshBottom` bit flags. */
export const SCRIPT = {
  WIND: 0x00001,
  WINDZ1: 0x00020,
  WINDZ2: 0x00040,
  WINDX1: 0x00080,
  WINDX2: 0x00100,
  WATER: 0x00200,
  NOTVIEW: 0x00400,
  PASS: 0x00800,
  NOTPASS: 0x01000,
  RENDLATTER: 0x02000,
  BLINK_COLOR: 0x04000,
  CHECK_ICE: 0x08000,
  ORG_WATER: 0x10000,
};

/** Mask applied to `WindMeshBottom` before matching a wind/water effect. */
export const WIND_MASK = 0x07ff;

/** `MeshState` bit 0: the face participates in collision detection. */
export const MESH_STATE_COLLIDE = 0x0001;

/** `Light3D.type` bit flags (`smLIGHT_TYPE_*`). */
export const LIGHT_TYPE = {
  NIGHT: 0x00001,
  LENS: 0x00002,
  PULSE2: 0x00004,
  OBJ: 0x00008,
  DYNAMIC: 0x80000,
};

/**
 * Animation timebase, inherited from 3ds Max defaults:
 * 30 ticks per second x 160 frames per tick = 4800 frames per second.
 */
export const FRAMES_PER_SECOND = 4800;
export const TICKS_PER_SECOND = 30;
export const FRAMES_PER_TICK = 160;

/** `MotionInfo.State` -> human-readable clip name. */
export const MOTION_STATE_NAMES = {
  0x040: 'Idle',
  0x050: 'Walk',
  0x060: 'Run',
  0x080: 'Fall',
  0x100: 'Attack',
  0x110: 'Damage',
  0x120: 'Die',
  0x130: 'Sometimes',
  0x140: 'Potion',
  0x150: 'Technique',
  0x170: 'LandingSmall',
  0x180: 'LandingLarge',
  0x200: 'Standup',
  0x210: 'Cry',
  0x220: 'Hurray',
  0x240: 'Jump',
  0x400: 'Talk1',
  0x410: 'Talk1',
  0x420: 'Talk2',
  0x430: 'Talk3',
  0x440: 'Talk4',
  0x450: 'Talk5',
};

/**
 * Resolve a `MotionInfo.State` to a clip name.
 * Unknown states fall back to `State_0x<hex>` rather than being dropped.
 * @param {number} state
 */
export function motionStateName(state) {
  return MOTION_STATE_NAMES[state] ?? `State_0x${state.toString(16)}`;
}
