import type {
  AnimationClip,
  AnimationAction,
  AnimationMixer,
  BufferGeometry,
  Bone,
  Camera,
  Group,
  Intersection,
  Material,
  Matrix4,
  Mesh,
  Object3D,
  Quaternion,
  Raycaster,
  Skeleton,
  Texture,
  Vector2,
  Vector3,
} from 'three';

// ===========================================================================
// Parsed data (no three.js involved) — also exported from `@jpstale/pt-loader/core`
// ===========================================================================

/** One vertex of a PAT3D mesh. Values are already divided by 256. */
export interface PTVertex {
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
}

/** One triangle. `v[0..2]` index into the object's vertex array. */
export interface PTFace {
  v: [number, number, number];
  /** Index into `materialGroup.materials`. */
  matId: number;
  /** Inline UVs, used as a fallback when `texIndex` is -1. */
  t: [number, number][];
  lpTexLink: number;
  /** Index into the owning object's `texLinks`, or -1. */
  texIndex: number;
}

/** A UV triple, plus an optional link to the lightmap UV set. */
export interface PTTexLink {
  u: number[];
  v: number[];
  lpNextTex: number;
  /** Index of the second UV set (lightmap), or -1. */
  nextIndex: number;
}

export interface PTTextureRef {
  name: string;
  nameAlpha: string;
}

/** Fixed-function Direct3D material state. */
export interface PTMaterial {
  inUse: number;
  textureCounter: number;
  textureStageState: number[];
  /** `[0] >= 4` marks a scrolling material. */
  textureFormState: number[];
  reformTexture: number;
  /** Non-zero means alpha-test cutout. */
  mapOpacity: number;
  /** 0 = MULTIMIX, 1 = ANIMATION (flipbook). */
  textureType: number;
  /** See `BLEND`. */
  blendType: number;
  shade: number;
  twoSide: number;
  serialNum: number;
  diffuse: { r: number; g: number; b: number };
  /** 0..1; non-zero means real alpha blending. */
  transparency: number;
  selfIllum: number;
  textureSwap: number;
  matFrame: number;
  textureClip: number;
  /** Script bit field; see `SCRIPT`. */
  useState: number;
  /** Bit 0 marks a collidable surface. */
  meshState: number;
  /** `& 0x07FF` selects a wind or water effect. */
  windMeshBottom: number;
  animTexCounter: number;
  frameMask: number;
  shiftFrameSpeed: number;
  animationFrame: number;
  /** `[0]` is the diffuse map, `[1]` the lightmap. */
  textures: PTTextureRef[];
  animTextures: PTTextureRef[];
}

export interface PTMaterialGroup {
  materialCount: number;
  materials: PTMaterial[];
  reformTexture: number;
  maxMaterial: number;
  lastSearchMaterial: number;
  lastSearchName: string;
}

export interface PTSmdHeader {
  header: string;
  objCounter: number;
  matCounter: number;
  matFilePoint: number;
  firstObjInfoPoint: number;
  tmFrameCounter: number;
  tmFrame: object[];
  /** Version 0.66 embeds ObjInfo before each GeomObject instead of in a table. */
  isVer066: boolean;
}

export interface PTRotationKey {
  frame: number;
  x: number;
  y: number;
  z: number;
  w: number;
}
export interface PTVectorKey {
  frame: number;
  x: number;
  y: number;
  z: number;
}

/** A mesh node in a `.smd`, or a bone in a `.smb`. */
export interface PTGeomObject {
  lpOldTexLink: number;
  /** Non-zero means a per-vertex bone-name block follows the geometry. */
  lpPhysique: number;
  bounds: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number };
  nVertex: number;
  nFace: number;
  nTexLink: number;
  nodeName: string;
  nodeParent: string;
  /** Index of the parent object, or -1 for a root. */
  parentIndex: number;
  /** 16 values in file order, already divided by 256. */
  transform: Float64Array;
  /** The inverse bind matrix as stored. Invert it to get the bind transform. */
  transformInvert: Float64Array;
  transformRotate: Float64Array;
  worldMatrix: Float64Array;
  localMatrix: Float64Array;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  sx: number;
  sy: number;
  sz: number;
  px: number;
  py: number;
  pz: number;
  tmRotCnt: number;
  tmPosCnt: number;
  tmScaleCnt: number;
  vertices: PTVertex[];
  faces: PTFace[];
  texLinks: PTTexLink[];
  /** Rotation keys. **These are deltas** and must be accumulated. */
  rotTrack: PTRotationKey[];
  posTrack: PTVectorKey[];
  scaleTrack: PTVectorKey[];
  /** Per-vertex bone name, present only when `lpPhysique !== 0`. */
  boneNames: string[] | null;
  maxFrame: number;
}

export interface PTPat3D {
  type: 'pat3d';
  header: PTSmdHeader;
  materialGroup: PTMaterialGroup | null;
  objects: PTGeomObject[];
  nameToIndex: Map<string, number>;
  maxFrame: number;
}

export interface PTStageVertex {
  x: number;
  y: number;
  z: number;
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface PTStageFace {
  v: [number, number, number];
  matId: number;
  lpTexLink: number;
  texIndex: number;
  nx: number;
  ny: number;
  nz: number;
}

export interface PTLight3D {
  type: number;
  x: number;
  y: number;
  z: number;
  range: number;
  r: number;
  g: number;
  b: number;
}

export interface PTStage3D {
  type: 'stage3d';
  header: PTSmdHeader;
  materialGroup: PTMaterialGroup | null;
  vertices: PTStageVertex[];
  faces: PTStageFace[];
  texLinks: PTTexLink[];
  lights: PTLight3D[];
  nVertColor: number;
  contrast: number;
  bright: number;
  lightDir: { x: number; y: number; z: number };
  /** Map extents on the XZ plane, scaled by 256. */
  rect: { left: number; top: number; right: number; bottom: number };
}

/** One animation clip definition from an `.inx`. */
export interface PTMotionInfo {
  state: number;
  /** Human-readable name derived from `state`. */
  name: string;
  startTick: number;
  talkStartTick: number;
  endTick: number;
  eventTicks: number[];
  repeat: number;
  keyCode: number;
  /** True when the clip is meant to play backwards. */
  readonly reversed: boolean;
  readonly effectiveStartTick: number;
  /** Inclusive animation-frame range, normalised so start <= end. */
  readonly frameRange: [number, number];
}

export interface PTInx {
  type: 'inx';
  /** True for the 172-byte MotionInfo variant. */
  kpt: boolean;
  modelFile: string;
  motionFile: string;
  subModelFile: string;
  highModel: { count: number; names: string[] };
  defaultModel: { count: number; names: string[] };
  lowModel: { count: number; names: string[] };
  motions: PTMotionInfo[];
  talkMotions: PTMotionInfo[];
  /** Non-empty when this model borrows another model's animation file. */
  motionLinkFile: string;
  talkLinkFile: string;
  talkMotionFile: string;
}

/** Raw RGBA output of the image decoders. `data` is **bottom-up**. */
export interface PTDecodedImage {
  width: number;
  height: number;
  data: Uint8Array;
  hasAlpha: boolean;
  format?: 'bmp' | 'tga';
}

// ---------------------------------------------------------------- parsers ---

export function parsePAT3D(buffer: ArrayBuffer | Uint8Array): PTPat3D;
export function parseSMB(buffer: ArrayBuffer | Uint8Array): PTPat3D;
export function parseSTAGE3D(buffer: ArrayBuffer | Uint8Array): PTStage3D;
export function parseINX(buffer: ArrayBuffer | Uint8Array): PTInx;

export function decodeBMP(u8: Uint8Array): PTDecodedImage;
export function decodeTGA(u8: Uint8Array): PTDecodedImage;
export function decodeImage(buffer: ArrayBuffer | Uint8Array, filename?: string): PTDecodedImage;

export function decryptBMP(u8: Uint8Array): Uint8Array;
export function decryptTGA(u8: Uint8Array): Uint8Array;
export function encryptBMP(u8: Uint8Array): Uint8Array;
export function encryptTGA(u8: Uint8Array): Uint8Array;
export function decryptImage(u8: Uint8Array, filename?: string): 'bmp' | 'tga';
export function isEncryptedBMP(u8: Uint8Array): boolean;
export function isEncryptedTGA(u8: Uint8Array): boolean;
export function isPlainBMP(u8: Uint8Array): boolean;

export class BinaryReader {
  constructor(source: ArrayBuffer | Uint8Array | DataView, offset?: number);
  offset: number;
  readonly length: number;
  readonly remaining: number;
  i8(): number;
  byte(): number;
  i16(): number;
  u16(): number;
  i32(): number;
  u32(): number;
  f32(): number;
  skip(n: number): this;
  bytes(n: number): Uint8Array;
  i32Array(n: number): Int32Array;
  f32Array(n: number): Float32Array;
  /** Fixed-width field: reads to the first NUL, then skips the padding. */
  str(size: number): string;
  cstr(): string;
  /** Throws if the cursor is not exactly at `expected`. */
  expect(expected: number, what: string): this;
}

// --------------------------------------------------------------- constants ---

export const SIZES: Record<string, number>;
export const BLEND: {
  NONE: 0;
  ALPHA: 1;
  COLOR: 2;
  SHADOW: 3;
  LAMP: 4;
  ADDCOLOR: 5;
  INVSHADOW: 6;
};
export const TEX_TYPE: { MULTIMIX: 0; ANIMATION: 1 };
export const SCRIPT: Record<
  | 'WIND'
  | 'WINDZ1'
  | 'WINDZ2'
  | 'WINDX1'
  | 'WINDX2'
  | 'WATER'
  | 'NOTVIEW'
  | 'PASS'
  | 'NOTPASS'
  | 'RENDLATTER'
  | 'BLINK_COLOR'
  | 'CHECK_ICE'
  | 'ORG_WATER',
  number
>;
export const LIGHT_TYPE: Record<'NIGHT' | 'LENS' | 'PULSE2' | 'OBJ' | 'DYNAMIC', number>;
export const FRAMES_PER_SECOND: 4800;
export const TICKS_PER_SECOND: 30;
export const FRAMES_PER_TICK: 160;
export const FIXED: 256;
export const INX_SIZE_CLASSIC: 67084;
export const INX_SIZE_KPT: 95268;
export const MESH_STATE_COLLIDE: 1;
export const WIND_MASK: number;
export const MOTION_STATE_NAMES: Record<number, string>;
export function motionStateName(state: number): string;

// ------------------------------------------------------------------- paths ---

export function dirOf(path: string): string;
export function baseOf(path: string): string;
export function stripExt(path: string): string;
export function changeExt(path: string, ext: string): string;
export function resolveAssetPath(
  folder: string,
  name: string,
  manifest: Record<string, string> | Map<string, string> | null,
): string | null;

// ===========================================================================
// three.js build layer
// ===========================================================================

/** Textures already resolved for one material. */
export interface PTResolvedTextures {
  diffuse: Texture | null;
  lightmap: Texture | null;
  anim: Texture[];
  diffuseHasAlpha: boolean;
}

export interface PTBuildOptions {
  /** Apply the -90 degree X rotation that maps Z-up to Y-up. Default `true`. */
  upAxisFix?: boolean;
  /**
   * How a mesh object is placed.
   * `'matrix'` (default) transforms vertices by the bind matrix and leaves the
   * node at identity. `'trs'` uses the decomposed transform instead. `'both'`
   * reproduces the reference renderer, which applies both. `'none'` leaves raw
   * coordinates.
   */
  objectTransform?: 'matrix' | 'trs' | 'both' | 'none';
  /** Average normals across shared vertices instead of flat shading. Default `false`. */
  smoothNormals?: boolean;
  /** How inverse-bind matrices are derived. Default `'pose'`. */
  bindInverses?: 'pose' | 'matrix';
  /** `'unshaded'` (default) matches the game; `'lambert'` reacts to scene lights. */
  lighting?: 'unshaded' | 'lambert';
  /** Alpha-test threshold for cutout materials. Default `0.5`. */
  alphaTest?: number;
  /** Feed `StageVertex` colours into the geometry. Stage only. Default `false`. */
  vertexColors?: boolean;
}

/** A per-frame updater for a scrolling, flipbook, water or wind effect. */
export interface PTAnimator {
  kind: 'flipbook' | 'scroll' | 'water' | 'wind';
  update(timeSeconds: number): void;
  material?: Material;
  object?: Object3D;
}

/** Extra data every object built by this package carries. */
export interface PTUserData {
  ptSource?: string;
  ptAnimators?: PTAnimator[];
  ptUpdate?: (timeSeconds: number) => void;
  ptSkeleton?: Skeleton;
  ptBones?: Bone[];
  ptLights?: PTLight3D[];
  ptRect?: { left: number; top: number; right: number; bottom: number };
}

export function buildModel(
  pat: PTPat3D,
  opts: {
    resolveTextures: (material: PTMaterial, index: number) => PTResolvedTextures;
    skeletonPat?: PTPat3D | null;
    name?: string;
    options?: PTBuildOptions;
  },
): Group;

export function buildStage(
  stage: PTStage3D,
  opts: {
    resolveTextures: (material: PTMaterial, index: number) => PTResolvedTextures;
    name?: string;
    options?: PTBuildOptions;
  },
): Group;

export function buildCollisionMesh(parsed: PTStage3D | PTPat3D): Mesh | null;

export function buildGeometry(opts: {
  faces: PTFace[] | PTStageFace[];
  texLinks: PTTexLink[];
  positions: Float32Array;
  matId: number;
  normals?: Float32Array | null;
  colors?: Float32Array | null;
  boneIndex?: Int32Array | null;
  fallbackUV?: boolean;
}): BufferGeometry | null;

export function buildCollisionGeometry(
  faces: { v: number[]; matId: number }[],
  positions: Float32Array,
  isCollidable: (matId: number) => boolean,
): BufferGeometry | null;

export function computeSmoothNormals(
  faces: { v: number[] }[],
  positions: Float32Array,
  vertexCount: number,
): Float32Array;

export function createMaterial(
  m: PTMaterial,
  tex: PTResolvedTextures,
  options?: PTBuildOptions,
): { material: Material; animator: PTAnimator | null };

export function createWindAnimator(object: Object3D, kind: number): PTAnimator;
export function shouldSkipMaterial(m: PTMaterial | null | undefined): boolean;
export function isCollidable(m: PTMaterial | null | undefined): boolean;
export function isScrolling(m: PTMaterial): boolean;
export function scrollSpeedOf(m: PTMaterial): number;
export function windEffectOf(m: PTMaterial): number;

export function buildBones(pat: PTPat3D): {
  bones: Bone[];
  roots: Bone[];
  indexByName: Map<string, number>;
};
export function createSkeleton(
  bones: Bone[],
  objects: PTGeomObject[],
  options?: { bindInverses?: 'pose' | 'matrix'; rootMatrix?: Matrix4 | null },
): Skeleton;
export function mapVertexBones(boneNames: string[], indexByName: Map<string, number>): Int32Array;

export function extractBoneTracks(obj: PTGeomObject): {
  rot: { times: number[]; values: Quaternion[] };
  pos: { times: number[]; values: number[][] };
  scale: { times: number[]; values: number[][] };
  bind: { position: number[]; quaternion: Quaternion; scale: number[] };
};

export function buildClip(
  name: string,
  bones: { boneName: string; tracks: ReturnType<typeof extractBoneTracks> }[],
  startFrame?: number | null,
  endFrame?: number | null,
): AnimationClip | null;

export function buildClips(
  skeletonPat: PTPat3D,
  inx?: PTInx | null,
): {
  clips: Record<string, AnimationClip>;
  reversed: Set<string>;
  byState: Record<number, string>;
  full: AnimationClip | null;
};

export function frameToSeconds(frame: number): number;
export function tickToFrame(tick: number): number;

// --------------------------------------------------------------- picking ---

/** What a raycast into a loaded object found. */
export interface PTPickResult {
  /** The surface that was hit. */
  mesh: Mesh;
  /** The object the pick was performed against. */
  root: Object3D;
  /** World-space hit position. */
  point: Vector3;
  distance: number;
  faceIndex: number | null;
  uv: Vector2 | null;
  /** Primary diffuse texture name, e.g. `"rock02.bmp"`. */
  textureName: string | null;
  textureNames: string[];
  animTextureNames: string[];
  materialIndex: number | null;
  nodeName: string | null;
  objectIndex: number | null;
  blendType: number | null;
  useState: number | null;
  meshState: number | null;
  mapOpacity: number | null;
  transparency: number | null;
  twoSide: number | null;
  /** Other surfaces under `root` using the same texture. */
  siblings: Mesh[];
}

export interface PTPickOptions {
  raycaster?: Raycaster;
  /** Collect surfaces sharing the texture. Default `true`. */
  siblings?: boolean;
  /** Match the lightmap and flipbook slots too. Default `false`. */
  matchAllSlots?: boolean;
  /** Ignore hits on transparent texels of cutout materials. Default `true`. */
  alphaTest?: boolean;
  filter?: (mesh: Mesh, hit: Intersection) => boolean;
}

export function pickAt(
  opts: {
    root: Object3D;
    camera: Camera;
    pointer: Vector2 | { x: number; y: number };
  } & PTPickOptions,
): PTPickResult | null;

/** Convert a DOM pointer event into normalised device coordinates. */
export function pointerToNDC(
  event: { clientX: number; clientY: number },
  domElement: HTMLElement,
  target?: Vector2,
): Vector2;

export function findMeshesByTexture(
  root: Object3D,
  textureName: string | null,
  opts?: { matchAllSlots?: boolean },
): Mesh[];

/**
 * Read a texture's alpha at a UV. Returns 255 for browser-decoded images,
 * whose pixels live only on the GPU.
 */
export function sampleTextureAlpha(texture: Texture | null, u: number, v: number): number;

export interface PTHighlightOptions {
  /** Outline colour of the picked surface. Default `0x3cf0b4`. */
  color?: number | string;
  /** Outline colour of surfaces sharing the texture. Default `0xff8a3c`. */
  siblingColor?: number | string;
  opacity?: number;
  siblingOpacity?: number;
  /** Draw through geometry so siblings behind walls stay visible. Default `true`. */
  xray?: boolean;
  renderOrder?: number;
}

/**
 * Wireframe overlay for a picked surface and its siblings. Overlays are
 * children of the meshes they trace and share their geometry; skinned surfaces
 * get a bound `SkinnedMesh` overlay so the outline follows the animation.
 */
export class PTHighlight {
  constructor(options?: PTHighlightOptions);
  readonly overlays: Map<Mesh, Mesh>;
  readonly active: boolean;
  primaryMaterial: Material;
  siblingMaterial: Material;
  /** Outline a surface and, optionally, its siblings. Replaces the previous highlight. */
  show(target: PTPickResult | Mesh | null, siblings?: Mesh[]): this;
  clear(): this;
  /** Remove the overlays and dispose the two shared materials. */
  dispose(): void;
}

export function mat4FromFile(f: Float64Array | number[], target?: Matrix4): Matrix4;
export function invertSafe(m: Matrix4): Matrix4;
export function bindMatrixOf(obj: PTGeomObject): Matrix4;
export function inverseBindMatrixOf(obj: PTGeomObject): Matrix4;

export const UP_AXIS_FIX: number;
export const UNIT_SCALE: number;

// ===========================================================================
// Texture cache
// ===========================================================================

export interface TextureCacheOptions {
  baseUrl?: string;
  manifest?: Record<string, string> | Map<string, string> | null;
  fetch?: typeof fetch;
  anisotropy?: number;
  /** Downscale textures above this size. `0` disables. Default `4096`. */
  maxSize?: number;
  warnMissing?: boolean;
}

export class TextureCache {
  constructor(options?: TextureCacheOptions);
  baseUrl: string;
  manifest: Record<string, string> | Map<string, string> | null;
  /** Magenta checker used whenever a texture cannot be resolved. */
  readonly missingTexture: Texture;
  /** Never rejects: unresolved names resolve to `missingTexture`. */
  load(folder: string, name: string, opts?: { srgb?: boolean }): Promise<Texture>;
  loadMaterialGroup(
    materialGroup: PTMaterialGroup | null,
    folder: string,
  ): Promise<Map<number, PTResolvedTextures>>;
  dispose(): void;
}

export function downscaleRGBA(
  src: Uint8Array,
  width: number,
  height: number,
  maxSize: number,
): { width: number; height: number; data: Uint8Array };

// ===========================================================================
// PTLoader
// ===========================================================================

export interface PTLoaderOptions {
  /** Prefix for every asset request, e.g. `'/pt-assets/'`. */
  baseUrl?: string;
  /** Output of `pt-assets manifest`. Strongly recommended in production. */
  manifest?: Record<string, string> | Map<string, string> | null;
  fetch?: typeof fetch;
  textureCache?: TextureCache;
  /** Parse off the main thread. Falls back automatically if unavailable. */
  useWorker?: boolean;
  options?: PTBuildOptions & TextureCacheOptions;
}

export interface PTCharacter {
  object: Group;
  clips: Record<string, AnimationClip>;
  clipNames: string[];
  /** Clips whose `MotionInfo` asked to play backwards. */
  reversed: Set<string>;
  /** `MotionInfo.state` -> clip name. */
  byState: Record<number, string>;
  inx: PTInx | null;
  skeleton: Skeleton | null;
  createMixer(): AnimationMixer;
  /** Play a clip, creating an internal mixer if none is supplied. */
  play(name: string, mixer?: AnimationMixer): AnimationAction | null;
}

export class PTLoader {
  constructor(options?: PTLoaderOptions);
  baseUrl: string;
  manifest: Record<string, string> | Map<string, string> | null;
  textures: TextureCache;
  useWorker: boolean;
  readonly updatables: Set<Object3D>;

  static loadManifest(url: string, fetchImpl?: typeof fetch): Promise<Record<string, string>>;
  setManifest(manifest: Record<string, string> | Map<string, string>): void;

  fetchBuffer(path: string): Promise<ArrayBuffer>;
  parsePAT3D(path: string): Promise<PTPat3D>;
  parseSTAGE3D(path: string): Promise<PTStage3D>;
  parseINX(path: string): Promise<PTInx>;

  /** A drop item, weapon or scenery prop. */
  loadModel(
    path: string,
    opts?: { textureFolder?: string; options?: PTBuildOptions },
  ): Promise<Group>;

  /** A player, NPC or monster, with its animation clips. */
  loadCharacter(path: string, opts?: { options?: PTBuildOptions }): Promise<PTCharacter>;

  /** A map (STAGE3D). */
  loadStage(
    path: string,
    opts?: { textureFolder?: string; options?: PTBuildOptions },
  ): Promise<Group>;

  /** An invisible mesh of collidable faces, for raycasting. */
  loadCollision(path: string, opts?: { kind?: 'stage' | 'model' }): Promise<Mesh | null>;

  /**
   * Raycast into a loaded object and describe the surface hit, including which
   * texture it uses and every other surface sharing it.
   */
  pick(
    root: Object3D,
    camera: Camera,
    pointer: Vector2 | { x: number; y: number },
    opts?: PTPickOptions,
  ): PTPickResult | null;

  /** Drive animated materials and wind. Call once per frame. */
  update(elapsedSeconds: number): void;
  /** Stop updating a root and dispose its geometries and materials. */
  release(root: Object3D): void;
  dispose(): void;
}

export default PTLoader;
