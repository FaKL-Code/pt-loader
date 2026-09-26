import type {
  AnimationAction,
  AnimationMixer,
  Mesh,
  Object3D,
  PerspectiveCamera,
  Scene,
  Vector2,
  WebGLRenderer,
} from 'three';
import type {
  PTBuildOptions,
  PTAssetRequestInit,
  PTCharacter,
  PTHighlight,
  PTHighlightOptions,
  PTLoader,
  PTPickResult,
  PTTransform,
} from './index.js';

export interface PTViewerOptions {
  baseUrl?: string;
  manifest?: Record<string, string> | null;
  fetch?: typeof fetch;
  /** Authorization credentials/headers for every model and texture request. */
  requestInit?: PTAssetRequestInit;
  /** Reuse an existing loader instead of creating one. */
  loader?: PTLoader;
  /** `null` (default) keeps the canvas transparent. */
  background?: number | string | null;
  autoRotate?: boolean;
  /** Radians per second. Default `0.5`. */
  autoRotateSpeed?: number;
  grid?: boolean;
  fov?: number;
  exposure?: number;
  options?: PTBuildOptions;
  /** Default root position, rotation and scale for every shown asset. */
  transform?: PTTransform;
  /** Colours and behaviour of the pick outline. */
  highlight?: PTHighlightOptions;
}

/**
 * Renderer, scene, camera, lights, orbit controls, resize handling and an
 * animation loop in one object. Orbit controls are built in, so nothing beyond
 * `three` is required.
 */
export class PTViewer {
  constructor(target: HTMLElement | string, options?: PTViewerOptions);

  readonly container: HTMLElement;
  readonly renderer: WebGLRenderer;
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly loader: PTLoader;
  /** Set to `false` to freeze the orbit controls. */
  enabled: boolean;
  autoRotate: boolean;
  autoRotateSpeed: number;

  current: Object3D | null;
  character?: PTCharacter | null;
  mixer: AnimationMixer | null;
  action: AnimationAction | null;
  readonly clipNames: string[];

  /** Load and display an asset, replacing whatever is shown. */
  show(
    path: string,
    opts?: {
      kind?: 'model' | 'character' | 'stage';
      /** Clip to play; defaults to the first of Idle / Walk / Full that exists. */
      clip?: string;
      /** Fit the camera to the loaded object. Default `true`. */
      frame?: boolean;
      textureFolder?: string;
      options?: PTBuildOptions;
      transform?: PTTransform;
    },
  ): Promise<Object3D>;

  /** Cross-fade to another clip. Only meaningful for `kind: 'character'`. */
  play(name: string, opts?: { fade?: number }): AnimationAction | null;

  /** Created on first pick. */
  highlight: PTHighlight | null;

  /** Raycast into the displayed object and describe the surface under a pointer. */
  pick(
    source: PointerEvent | MouseEvent | Vector2 | { x: number; y: number },
    opts?: {
      siblings?: boolean;
      matchAllSlots?: boolean;
      alphaTest?: boolean;
    },
  ): PTPickResult | null;

  /**
   * Call `callback` whenever the user picks a surface, and outline it along
   * with every other surface sharing its texture. Clicking empty space clears
   * the selection and calls back with `null`. Drags orbit instead of picking.
   * Returns an unsubscribe function.
   */
  onPick(
    callback: (result: PTPickResult | null) => void,
    opts?: {
      event?: 'click' | 'pointermove';
      highlight?: boolean;
      siblings?: boolean;
      matchAllSlots?: boolean;
      alphaTest?: boolean;
      /** Pixels of pointer movement that turn a click into a drag. Default `4`. */
      dragThreshold?: number;
    },
  ): () => void;

  /** Outline a surface manually, without a pointer event. */
  showHighlight(target: PTPickResult | Mesh | null): this;
  clearHighlight(): this;

  frameObject(object: Object3D, opts?: { padding?: number }): void;
  clear(): void;
  dispose(): void;
}

export default PTViewer;
