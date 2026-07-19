/* eslint-disable @typescript-eslint/ban-types */
import { LitElement, html, TemplateResult, css, PropertyValues, CSSResultGroup, render } from 'lit';
import { property, customElement, state } from 'lit/decorators';
import {
  HomeAssistant,
  ActionHandlerEvent,
  handleAction,
  LovelaceCardEditor,
  fireEvent,
} from 'custom-card-helpers'; // This is a community maintained npm module with common helper functions/types
import './editor';
import { HassEntity } from 'home-assistant-js-websocket';
import { createConfigArray, createObjectGroupConfigArray, getLovelace, evaluateCondition } from './helpers';
import type { Floor3dCardConfig, MarkerConfig, RoomControlConfig, AnimationConfig } from './types';
import { CARD_VERSION } from './const';
import { localize } from './localize/localize';
//import three.js libraries for 3D rendering
import * as TWEEN from '@tweenjs/tween.js';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader';
import { GLTFLoader, GLTF } from 'three/examples/jsm/loaders/GLTFLoader';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { Sky } from 'three/examples/jsm/objects/Sky';
import { Object3D } from 'three';
import '../elements/button';

/* eslint no-console: 0 */
console.info(
  `%c  FLOOR3D-CARD \n%c  ${localize('common.version')} ${CARD_VERSION}    `,
  'color: orange; font-weight: bold; background: black',
  'color: white; font-weight: bold; background: dimgray',
);

// This puts your card into the UI card picker dialog
(window as any).customCards = (window as any).customCards || [];
(window as any).customCards.push({
  type: 'floor3d-card',
  name: 'Floor3d Card',
  preview: true,
  description: 'A custom card to visualize and activate entities in a live 3D model',
});
class ModelSource {
  public static OBJ = 0;
  public static GLB = 1;
}

// Properties that belong to the new element's lifecycle — must NOT be overwritten
// during a cache-restore (Lit internals are excluded by name pattern below).
const CACHE_SKIP = new Set([
  'renderRoot', 'shadowRoot', 'isConnected',
  // new element's DOM references
  '_card', '_card_id', '_resizeObserver', '_intersectionObserver',
  // event-listener closures bound to the old element
  '_performActionListener', '_mousedownEventListener',
  '_mouseupEventListener', '_changeListener',
  // set from document / new element's constructor
  '_haShadowRoot', '_eval',
  // transient input/selection state — reset naturally
  '_clickStart', '_longpressTimeout', '_discoverLongPressTimeout',
  '_discoverTouchOrigin', '_currentIntersections', '_cardObscured', '_resizeTimeout',
  // selection state — reset by setConfig
  '_selectedmaterial', '_selectedobjects', '_selectionModeEnabled', '_initialobjectmaterials',
  // always set from new config/hass after restore
  '_config', '_configArray', '_object_ids', '_hass',
  // per-instance lifecycle handlers — must re-register on new element
  '_visibilityChangeHandler', '_externalZoomHandler',
  // per-instance timer maps (timeout IDs are per-instance)
  '_markerJourneyTimeouts',
  // zoom entity state — reset per element so the first hass update always syncs
  '_lastZoomEntityState',
]);

// Module-level cache: keeps the loaded 3D state alive when HA destroys the
// preview element during editor config changes, so the model doesn't reload.
let _floor3dCachedCard: { key: string; instance: any } | null = null;

// TODO Name your custom element
@customElement('floor3d-card')
export class Floor3dCard extends LitElement {
  private _scene?: THREE.Scene;
  private _camera?: THREE.PerspectiveCamera;
  private _renderer?: THREE.WebGLRenderer;
  private _levelbar?: HTMLElement;
  private _zoombar?: HTMLElement;
  private _selectionbar?: HTMLElement;
  private _weatherbar?: HTMLElement;
  private _animationsbar?: HTMLElement;
  private _weatherAnimationsEnabled = true;
  private _animationsEnabled = true;
  private _renderPending = false;
  private _lastFrameTime = 0;
  // Cache for anchor world-space positions.  Box3.setFromObject() traverses the
  // entire sub-tree — caching eliminates per-frame traversal for every overlay element.
  private _anchorWorldPosCache = new Map<string, THREE.Vector3>();
  // Pre-allocated scratch Vector3 used by _projectToScreen to avoid per-call GC pressure.
  private readonly _ndcScratch = new THREE.Vector3();
  // Camera-position snapshots used to skip _updateOverlayPositions when nothing moved.
  private _lastOverlayCamPos    = new THREE.Vector3();
  private _lastOverlayCamTarget = new THREE.Vector3();
  // Entities already logged as missing — prevents the same console.log on every hass update.
  private _loggedMissingEntities = new Set<string>();
  private _controls?: OrbitControls;
  private _hemiLight?: THREE.HemisphereLight;
  private _modelX?: number;
  private _modelY?: number;
  private _modelZ?: number;
  private _to_animate: boolean;
  private _bboxmodel: THREE.Object3D;
  private _modelBboxDiagonal = 0; // stored in _setCamera for overlay perspective scaling
  private _levels: THREE.Object3D[];
  private _displaylevels: boolean[];
  private _zoom: any[];
  private _selectedlevel: number;
  private _states?: string[];
  private _color?: number[][];
  private _raycasting: THREE.Object3D[];
  private _raycastinglevels: THREE.Object3D[][];
  private _initialmaterial?: THREE.Material[][];
  private _clonedmaterial?: THREE.Material[][];
  private _selectedmaterial?: THREE.Material;
  private _initialobjectmaterials: { [key: string]: THREE.Material };
  private _selectedobjects: string[];
  private _selectionModeEnabled: boolean;
  private _brightness?: number[];
  private _lights?: string[];
  private _rooms?: string[];
  private _sprites?: string[];
  private _canvas?: HTMLCanvasElement[];
  private _unit_of_measurement?: string[];
  private _text?: string[];
  private _spritetext?: string[];
  private _objposition: number[][];
  private _slidingdoorposition: THREE.Vector3[][];
  private _objects_to_rotate: THREE.Group[];
  private _pivot: THREE.Vector3[];
  private _degrees: number[];
  private _axis_for_door: THREE.Vector3[];
  private _axis_to_rotate: string[];
  private _round_per_seconds: number[];
  private _rotation_state: number[];
  private _rotation_index: number[];
  private _animated_transitions: any[];
  private _clock?: THREE.Clock;
  private _slidingdoor: THREE.Group[];
  private _overlay_entity: string;
  private _overlay_state: string;

  private _eval: Function;
  private _firstcall?: boolean;
  private _resizeTimeout?: number;
  private _resizeObserver: ResizeObserver;
  private _intersectionObserver: IntersectionObserver;
  private _performActionListener: EventListener;
  private _clickStart?: number;
  private _mousedownEventListener: EventListener;
  private _longpressTimeout: any;
  private _mouseupEventListener: EventListener;
  private _currentIntersections: THREE.Intersection[];
  private _changeListener: (...args: any[]) => void;
  private _cardObscured: boolean;
  private _card?: HTMLElement;
  private _content?: HTMLElement;
  private _modeltype?: ModelSource;
  private _config!: Floor3dCardConfig;
  private _configArray: Floor3dCardConfig[] = [];
  private _object_ids?: Floor3dCardConfig[] = [];
  private _visibilityChangeHandler?: () => void;
  private _overlay: HTMLDivElement;
  private _hass?: HomeAssistant;
  private _haShadowRoot: any;
  private _position: number[];
  private _card_id: string;
  private _ambient_light: any;
  private _torch: THREE.DirectionalLight;
  private _torchTarget: THREE.Object3D;
  private _sky: Sky;
  private _sun: THREE.DirectionalLight;
  _helper: THREE.DirectionalLightHelper;
  private _modelready: boolean;
  private _maxtextureimage: number;

  // --- Zoom entity state tracking ---
  private _lastZoomEntityState?: string;

  // --- Dynamic sky / sun / moon / weather ---
  private _sunDirection?: THREE.Vector3;    // normalized sun direction in world space
  private _moonMesh?: THREE.Mesh;           // moon 3D sphere in scene
  private _sunMesh?: THREE.Mesh;            // sun 3D sphere in scene
  private _weatherSystem?: {               // active 3D weather particle system
    mesh: THREE.Points | THREE.LineSegments;
    velArray: Float32Array;                // [vx, vy, vz] per particle (Points) or per segment-pair (LineSegments)
    spread: number;                        // half-width of spawn area (world units)
    maxY: number;                          // Y ceiling for particle reset
    type: 'rain' | 'snow' | 'hail' | 'sand' | 'wind';
    segLen: number;                        // streak length (rain) or 0 for Points types
  };
  private _lightningLight?: THREE.PointLight;
  private _lightningTimer = 0;
  private _lightningPhase = 0;
  private _windSystem?: {          // active 3D wind streak system (independent of weather state)
    mesh: THREE.LineSegments;
    count: number;
    windDir: THREE.Vector3;        // normalized direction wind blows TO
    baseSpeed: number;             // base world units per second
    speeds: Float32Array;          // per-streak speed multiplier (0.7–1.3×)
    segLengths: Float32Array;      // per-streak length in world units
    spread: number;                // bounding half-width for spawn/wrap
    maxY: number;
  };
  private _cloudSystem?: {         // active 3D cloud puff system
    group: THREE.Group;
    clouds: { mesh: THREE.Group; vel: THREE.Vector3 }[];
    spread: number;                // radial boundary for wrap-around
  };

  // --- Marker / room-control / animation overlay system ---
  private _markerOverlay?: HTMLDivElement;
  private _markerElements: Map<string, HTMLElement> = new Map();
  private _roomControlElements: Map<string, HTMLElement> = new Map();
  private _animationElements: Map<string, HTMLElement> = new Map();
  private _markerJourneyTimeouts: Map<string, number> = new Map();

  // --- 3D particle systems for music_notes and ac_flow animations ---
  private _animParticleSystems: Map<string, {
    type: 'music_notes' | 'ac_flow';
    active: boolean;
    origin: THREE.Vector3;
    // music_notes
    sprites?: THREE.Sprite[];
    spriteMats?: THREE.SpriteMaterial[];
    phases?: number[];          // per-sprite phase 0..1
    drifts?: number[];          // per-sprite x-drift amplitude
    noteScale?: number;         // world-unit base size of each sprite
    noteSpeed?: number;         // phase-units/second (speed multiplier applied at init)
    travelDist?: number;        // world units a note travels before fade-out
    // ac_flow
    mesh?: THREE.LineSegments;
    material?: THREE.LineBasicMaterial;
    count?: number;
    acPhases?: Float32Array;    // per-streak phase 0..1
    maxLen?: number;            // total streak travel distance in world units
    sdx?: Float32Array;         // per-streak direction X (normalized per-streak direction)
    sdy?: Float32Array;         // per-streak direction Y
    sdz?: Float32Array;         // per-streak direction Z
  }> = new Map();
  private _externalZoomHandler?: EventListener;

  // --- Mobile object-ID discovery (long-press) ---
  private _discoverLongPressTimeout: any = null;
  private _discoverTouchOrigin: { x: number; y: number; e: any } | null = null;

  constructor() {
    super();

    this._clickStart = null;
    this._initialobjectmaterials = {};
    this._selectedobjects = [];

    this._cardObscured = false;
    this._resizeObserver = new ResizeObserver(() => {
      this._resizeCanvasDebounce();
    });
    // Stop/start animation based on whether the card is actually in the
    // viewport (ratio === 0 means fully off-screen). Sibling cards that
    // visually overlap do NOT reduce intersection ratio, so they no longer
    // trigger false "Canvas Obscured" stops.
    this._intersectionObserver = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      const nowObscured = entry.intersectionRatio === 0;
      if (nowObscured !== this._cardObscured) {
        this._cardObscured = nowObscured;
        if (this._renderer) {
          if (nowObscured) {
            // Card fully scrolled off-screen — pause the loop.
            // Also clear _to_animate so _startOrStopAnimationLoop can restart
            // cleanly when the card comes back into view.
            if (this._to_animate) {
              this._to_animate = false;
              this._clock = null;
              this._renderer.setAnimationLoop(null);
            }
          } else {
            // Card is visible again — delegate to _startOrStopAnimationLoop so
            // all flags (_animationsEnabled, _weatherAnimationsEnabled, etc.) are
            // respected instead of unconditionally restarting the loop.
            this._startOrStopAnimationLoop();
          }
        }
      }
    }, { threshold: 0 });
    this._performActionListener = (evt) => {
      this._performAction(evt);
    };
    this._mousedownEventListener = (evt) => this._mousedownEvent(evt);
    this._mouseupEventListener = (evt) => {
      if (this._longpressTimeout) {
        clearTimeout(this._longpressTimeout);
        this._longpressTimeout = null;
      }

      // Handle mouse click events that are less than 200ms in duration
      if (this._clickStart && Date.now() - this._clickStart < 200) {
        if (this._config.click == 'yes' || this._selectionModeEnabled) {
          this._firEvent(evt);
        }
      }

      this._clickStart = null;
    };
    this._changeListener = () => {
      if (this._clickStart && Date.now() - this._clickStart > 200) {
        this._clickStart = null;
      }
      this._render();
    };
    this._haShadowRoot = document.querySelector('home-assistant').shadowRoot;
    this._eval = eval;
    this._card_id = 'ha-card-1';

    console.log('New Card');
  }

  public connectedCallback(): void {
    super.connectedCallback();

    // If this element briefly disconnected and stored itself in the cache, cancel it.
    // Without this, the editor preview's firstUpdated would steal our renderer and
    // _content, leaving the main dashboard card permanently blank.
    if (_floor3dCachedCard?.instance === this) {
      _floor3dCachedCard = null;
    }

    // Re-register visibility listener (handles Android app-switch context loss).
    this._visibilityChangeHandler = () => {
      if (document.hidden || !this._modelready || !this._renderer) return;
      const gl = this._renderer.getContext();
      if (gl && gl.isContextLost()) {
        console.log('floor3d-card: WebGL context lost on visibility restore, reloading');
        this.display3dmodel();
      } else {
        // Resize first — window/viewport may have changed while tab was hidden.
        this._resizeCanvas();
        // Always repaint even if the animation loop is running; the drawing buffer
        // can be cleared when the tab/window is backgrounded without a context-loss event.
        this._render();
      }
    };
    document.addEventListener('visibilitychange', this._visibilityChangeHandler);

    // External zoom trigger: window.dispatchEvent(new CustomEvent('floor3d-set-zoom', { detail: { id: 'room_name' } }))
    this._externalZoomHandler = (e: Event) => {
      if (!this._modelready || !this._zoom || !this._camera) return;
      const detail = (e as CustomEvent).detail;
      const name = detail?.id || detail?.name;
      if (!name) return;
      if (name === 'reset') {
        this._setCamera();
        this._setLookAt();
        this._controls.update();
        this._render();
        return;
      }
      const zoom = this._zoom.find((z: any) => z?.name === name);
      if (zoom) this._flyToZoom(zoom);
    };
    window.addEventListener('floor3d-set-zoom', this._externalZoomHandler);

    if (this._modelready) {
      // Always observe — cards in a responsive grid also need resize handling.
      this._resizeObserver.observe(this._card);
      this._intersectionObserver.observe(this);

      if (this._to_animate) {
        this._clock = new THREE.Clock();
        this._renderer.setAnimationLoop(() => this._animationLoop());
      } else {
        // Non-animated cards: repaint the static scene after reconnect.
        // The drawing buffer is cleared when the canvas is detached; nothing
        // repaints it unless we explicitly call _render().
        this._render();
      }

      // Always resize on reconnect — the container may have a different size
      // when switching between dashboards.
      this._resizeCanvas();
    }
  }

  public disconnectedCallback(): void {
    super.disconnectedCallback();

    if (this._visibilityChangeHandler) {
      document.removeEventListener('visibilitychange', this._visibilityChangeHandler);
      this._visibilityChangeHandler = undefined;
    }
    if (this._externalZoomHandler) {
      window.removeEventListener('floor3d-set-zoom', this._externalZoomHandler);
      this._externalZoomHandler = undefined;
    }
    this._markerJourneyTimeouts.forEach(id => window.clearTimeout(id));
    this._markerJourneyTimeouts.clear();

    this._resizeObserver.disconnect();
    this._intersectionObserver.unobserve(this);

    if (this._modelready && this._renderer) {
      // Keep the loaded model alive for a potential immediate re-creation
      // (HA destroys and recreates the preview card on every config-changed).
      const key = `${this._config?.path || ''}|${this._config?.objfile || ''}|${this._config?.mtlfile || ''}`;
      _floor3dCachedCard = { key, instance: this };
      if (this._to_animate) {
        this._clock = null;
        this._renderer.setAnimationLoop(null);
      }
    } else if (this._to_animate && this._renderer) {
      this._renderer.setAnimationLoop(null);
    }
  }

  public static async getConfigElement(): Promise<LovelaceCardEditor> {
    await import('./editor');
    return document.createElement('floor3d-card-editor');
  }

  public static getStubConfig(hass: HomeAssistant, entities: string[], entitiesFallback: string[]): object {
    console.log('Stub started');

    const entityFilter = (stateObj: HassEntity): boolean => {
      return !isNaN(Number(stateObj.state));
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const _arrayFilter = (array: any[], conditions: Array<(value: any) => boolean>, maxSize: number) => {
      if (!maxSize || maxSize > array.length) {
        maxSize = array.length;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const filteredArray: any[] = [];

      for (let i = 0; i < array.length && filteredArray.length < maxSize; i++) {
        let meetsConditions = true;

        for (const condition of conditions) {
          if (!condition(array[i])) {
            meetsConditions = false;
            break;
          }
        }

        if (meetsConditions) {
          filteredArray.push(array[i]);
        }
      }

      return filteredArray;
    };

    const _findEntities = (
      hass: HomeAssistant,
      maxEntities: number,
      entities: string[],
      entitiesFallback: string[],
      includeDomains?: string[],
      entityFilter?: (stateObj: HassEntity) => boolean,
    ) => {
      const conditions: Array<(value: string) => boolean> = [];

      if (includeDomains?.length) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        conditions.push((eid) => includeDomains!.includes(eid.split('.')[0]));
      }

      if (entityFilter) {
        conditions.push((eid) => hass.states[eid] && entityFilter(hass.states[eid]));
      }

      const entityIds = _arrayFilter(entities, conditions, maxEntities);

      if (entityIds.length < maxEntities && entitiesFallback.length) {
        const fallbackEntityIds = _findEntities(
          hass,
          maxEntities - entityIds.length,
          entitiesFallback,
          [],
          includeDomains,
          entityFilter,
        );

        entityIds.push(...fallbackEntityIds);
      }

      return entityIds;
    };

    //build a valid stub config

    let includeDomains = ['binary_sensor'];
    let maxEntities = 2;

    let foundEntities = _findEntities(hass, maxEntities, entities, entitiesFallback, includeDomains);

    const url = new URL(import.meta.url);
    let asset = url.pathname.split('/').pop();
    let path = url.pathname.replace(asset, '');

    if (path.includes('hacsfiles')) {
      path = '/local/community/floor3d-card/';
    }

    const conf = {
      path: path,
      name: 'Home',
      objfile: 'home.glb',
      lock_camera: 'no',
      header: 'yes',
      click: 'no',
      overlay: 'no',
      backgroundColor: '#aaaaaa',
      hideLevelsMenu: 'no',
      globalLightPower: '0.8',
      shadow: 'no',
      extralightmode: 'no',
      show_axes: 'no',
      sky: 'no',
      overlay_bgcolor: 'transparent',
      overlay_fgcolor: 'black',
      overlay_alignment: 'top-left',
      overlay_width: '33',
      overlay_height: '20',
      north: { x: 0, z: -1 },
      camera_position: { x: 609.3072605703628, y: 905.5330092468828, z: 376.66437610591277 },
      camera_rotate: { x: -1.0930244719682243, y: 0.5200808414019678, z: 0.7648717152512469 },
      camera_target: { x: 37.36890424945437, y: 18.64464320782064, z: -82.55051697031719 },
      object_groups: [
        {
          object_group: 'RoundTable',
          objects: [{ object_id: 'Round_table_1' }, { object_id: 'Round_table_2' }, { object_id: 'Round_table_3' }],
        },
        {
          object_group: 'EntranceDoor',
          objects: [{ object_id: 'Door_9' }, { object_id: 'Door_7' }, { object_id: 'Door_5' }],
        },
      ],
      entities: [],
    };

    let totalentities = 0;

    if (foundEntities[0]) {
      conf.entities.push({
        entity: foundEntities[0],
        type3d: 'door',
        object_id: '<EntranceDoor>',
        door: { doortype: 'swing', direction: 'inner', hinge: 'Door_3', percentage: '90' },
      });
      totalentities += 1;
    }
    if (foundEntities[1]) {
      conf.entities.push({
        entity: foundEntities[1],
        type3d: 'hide',
        object_id: '<RoundTable>',
        hide: { state: 'off' },
      });
      totalentities += 1;
    }

    includeDomains = ['light'];
    maxEntities = 1;

    let foundLights = _findEntities(hass, maxEntities, entities, entitiesFallback, includeDomains);

    if (foundLights[0]) {
      conf.entities.push({
        entity: foundLights[0],
        type3d: 'light',
        object_id: 'Bowl_2',
        light: { lumens: '800' },
      });
      totalentities += 1;
    }

    if (totalentities == 0) {
      conf.entities.push({
        entity: '',
      });
    }

    console.log(conf);

    console.log('Stub ended');
    return conf;
  }

  // TODO Add any properities that should cause your element to re-render here
  // https://lit-element.polymer-project.org/guide/properties
  //@property({ attribute: false }) public hass!: HomeAssistant;
  @state() private config!: Floor3dCardConfig;

  // https://lit-element.polymer-project.org/guide/properties#accessors-custom
  public setConfig(config: Floor3dCardConfig): void {
    // TODO Check for required fields and that they are of the proper format
    console.log('floor3d-card: Set Config Start');

    if (!config) {
      throw new Error(localize('common.invalid_configuration'));
    }

    this._config = config;
    this._configArray = createConfigArray(this._config);
    this._object_ids = createObjectGroupConfigArray(this._config);
    this._initialmaterial = [];
    this._clonedmaterial = [];
    let i = 0;

    this._selectionModeEnabled = this._config.selectionMode === 'yes';

    this._object_ids.forEach((entity) => {
      this._initialmaterial.push([]);
      this._clonedmaterial.push([]);

      entity.objects.forEach(() => {
        this._initialmaterial[i].push(null);
        this._clonedmaterial[i].push(null);
      });
      i += 1;
    });

    console.log('floor3d-card: Set Config End');

    if (this._config.show_warning) {
      render(this._showWarning(localize('common.show_warning')), this._card);
      return;
    }

    if (this._config.show_error) {
      render(this._showError(localize('common.show_error')), this._card);
      return;
    }
  }

  public rerender(): void {
    this._content.removeEventListener('dblclick', this._performActionListener);
    this._content.removeEventListener('touchstart', this._performActionListener);
    this._content.removeEventListener('keydown', this._performActionListener);
    this._controls.removeEventListener('change', this._changeListener);

    this._renderer.setAnimationLoop(null);
    this._resizeObserver.disconnect();
    this._intersectionObserver.unobserve(this);

    this._renderer.domElement.remove();
    this._renderer = null;

    this._states = null;
    this.hass = this._hass;
    this.display3dmodel();
  }

  private _ispanel(): boolean {

    let root: any = document.querySelector('home-assistant');
    root = root && root.shadowRoot;
    root = root && root.querySelector('home-assistant-main');
    root = root && root.shadowRoot;
    root = root && root.querySelector('app-drawer-layout partial-panel-resolver, ha-drawer partial-panel-resolver');
    root = (root && root.shadowRoot) || root;
    root = root && root.querySelector('ha-panel-lovelace');
    root = (root && root.shadowRoot) || root;
    root = root && root.querySelector('hui-root');
    root = (root && root.shadowRoot) || root;
    root = root && root.querySelector('hui-view');

    const panel: [] = root.getElementsByTagName('HUI-PANEL-VIEW');

    if (panel) {
      if (panel.length == 0) {
        return false;
      } else {
        return true;
      }
    } else {
      return false;
    }

  }

  private _issidebar(): boolean {

    let root: any = document.querySelector('home-assistant');
    root = root && root.shadowRoot;
    root = root && root.querySelector('home-assistant-main');
    root = root && root.shadowRoot;
    root = root && root.querySelector('app-drawer-layout partial-panel-resolver, ha-drawer partial-panel-resolver');
    root = (root && root.shadowRoot) || root;
    root = root && root.querySelector('ha-panel-lovelace');
    root = (root && root.shadowRoot) || root;
    root = root && root.querySelector('hui-root');
    root = (root && root.shadowRoot) || root;
    root = root && root.querySelector('hui-view');

    const sidebar: [] = root.getElementsByTagName('HUI-SIDEBAR-VIEW');

    if (sidebar) {
      if (sidebar.length == 0) {
        return false;
      } else {
        return true;
      }
    } else {
      return false;
    }
  }

  getCardSize(): number {
    const h = this._config?.height;
    const px = typeof h === 'number' ? h : 400;
    return Math.ceil(px / 72);
  }

  firstUpdated(): void {
    //called after the model has been loaded into the Renderer and first render
    console.log('First updated start');

    this._card = this.shadowRoot.getElementById(this._card_id);
    if (this._card) {
      // Check if a recently disconnected instance with the same model is cached.
      // HA destroys and recreates the preview element on every config-changed event;
      // restoring state from cache avoids a full model reload from disk.
      const modelKey = `${this._config?.path || ''}|${this._config?.objfile || ''}|${this._config?.mtlfile || ''}`;
      if (_floor3dCachedCard && _floor3dCachedCard.key === modelKey && this._config) {
        const oldCard = _floor3dCachedCard.instance;
        _floor3dCachedCard = null;

        const cachedGl = oldCard._renderer?.getContext?.();
        const contextOk = cachedGl && !cachedGl.isContextLost();
        if (oldCard._modelready && oldCard._content && oldCard._renderer && contextOk) {
          console.log('floor3d-card: restoring from cache');

          // Save values that must come from the NEW instance.
          const newConfig = this._config;
          const newConfigArray = this._configArray;
          const newObjectIds = this._object_ids;
          const newHass = this._hass;

          // Transfer only floor3d-specific state via an explicit allowlist.
          // Skipping Lit internals (_$*) and CACHE_SKIP prevents corrupting the
          // new element's reactive lifecycle.
          for (const prop of Object.getOwnPropertyNames(oldCard)) {
            if (prop.startsWith('_$') || CACHE_SKIP.has(prop)) continue;
            try { (this as any)[prop] = (oldCard as any)[prop]; } catch (_) { /* read-only */ }
          }

          // Restore new-instance-specific values.
          this._config = newConfig;
          this._configArray = newConfigArray;
          this._object_ids = newObjectIds;
          this._hass = newHass;

          // Capture old element's event-listener closures before nulling refs.
          // _changeListener, _mousedownEventListener, etc. are in CACHE_SKIP so
          // this (new) element already has its own fresh closures.  We need the
          // OLD closures so we can remove them from _controls and _content.
          const oldChangeListener = oldCard._changeListener;
          const oldMousedownListener = oldCard._mousedownEventListener;
          const oldMouseupListener = oldCard._mouseupEventListener;
          const oldPerformListener = oldCard._performActionListener;

          // CRITICAL: Null out the old element's shared references immediately after
          // the property transfer.  The old renderer canvas still has webglcontextlost /
          // webglcontextrestored listeners whose closures capture `this` === oldCard.
          // If the WebGL context is lost because the canvas moved between DOM containers,
          // those stale listeners would call oldCard.display3dmodel() — which still has
          // a valid reference to _content (now owned by this element) — and would corrupt
          // our display by clearing _content and re-appending a different canvas.
          // Nulling these refs makes the old listeners harmless no-ops.
          oldCard._content = null;
          oldCard._renderer = null;
          oldCard._scene = null;
          oldCard._modelready = false;

          // Re-attach content to new ha-card.
          this._card = this.shadowRoot.getElementById(this._card_id);
          this._card.appendChild(this._content);

          // Register fresh context-loss handlers bound to THIS (new) element.
          // The canvas already has old-element listeners but they are now harmless.
          this._renderer.domElement.addEventListener('webglcontextlost', (e) => {
            e.preventDefault();
            if (this._to_animate) this._renderer?.setAnimationLoop(null);
            this._modelready = false;
          }, { once: true });
          this._renderer.domElement.addEventListener('webglcontextrestored', () => {
            console.log('floor3d-card: WebGL context restored after DOM move, reloading');
            this.display3dmodel();
          }, { once: true });

          // Rebind OrbitControls change listener from old element to new element.
          // The transferred _controls still has oldCard._changeListener which calls
          // oldCard._render() — after we nulled oldCard._renderer that would crash
          // whenever controls.update() fires a 'change' event (e.g. from set hass
          // zoom-entity code).
          if (this._controls) {
            this._controls.removeEventListener('change', oldChangeListener);
            this._controls.addEventListener('change', this._changeListener);
          }

          // Rebind _content interaction listeners from old element to new element.
          if (this._content) {
            this._content.removeEventListener('mousedown', oldMousedownListener);
            this._content.removeEventListener('mouseup', oldMouseupListener);
            this._content.removeEventListener('dblclick', oldPerformListener);
            this._content.removeEventListener('touchstart', oldPerformListener);
            this._content.removeEventListener('keydown', oldPerformListener);
            this._content.addEventListener('mousedown', this._mousedownEventListener);
            this._content.addEventListener('mouseup', this._mouseupEventListener);
            this._content.addEventListener('dblclick', this._performActionListener);
            this._content.addEventListener('touchstart', this._performActionListener);
            this._content.addEventListener('keydown', this._performActionListener);
          }

          if (!this._ispanel()) {
            const show_header = this._config.header ? this._config.header : 'yes';
            (this._card as any).header = show_header == 'yes'
              ? (this._config.name ? this._config.name : 'Floor 3d') : '';
          }

          // Re-establish per-instance observers/timers.
          this._resizeObserver = new ResizeObserver(() => this._resizeCanvasDebounce());
          this._resizeObserver.observe(this._card); // always observe, not just panel/sidebar
          this._intersectionObserver.observe(this);

          if (this._to_animate) {
            this._clock = new THREE.Clock();
            this._renderer.setAnimationLoop(() => this._animationLoop());
          }

          // Re-apply background from the new config (may have changed since the cached scene was created).
          this._applyBackground();

          // Recalibrate camera/renderer to the new container, then re-apply state.
          this._resizeCanvas();
          if (this._hass && this._markerOverlay) {
            this._updateMarkersAndControls(this._hass);
          }
          if (!this._to_animate) {
            this._render();
          }

          console.log('floor3d-card: cache restore complete');

          // Deferred safety net: moving the canvas between DOM containers can cause
          // async WebGL context loss that isn't detectable synchronously.  Wait one
          // animation frame (after browser layout + GPU compositor) then verify:
          //   • context still alive → resize to final dimensions and re-render
          //   • context lost        → full model reload (display3dmodel)
          requestAnimationFrame(() => {
            if (!this.isConnected) return; // element was already replaced
            const gl2 = this._renderer?.getContext?.();
            if (!gl2 || gl2.isContextLost()) {
              console.log('floor3d-card: WebGL context lost after DOM move — reloading model');
              this._renderer = null;
              this._modelready = false;
              this.display3dmodel();
            } else {
              // Always resize before rendering: the synchronous _resizeCanvas() call
              // above may have seen clientWidth=0 (layout not yet computed), leaving
              // the canvas at 0×0.  By the time this rAF fires layout is guaranteed.
              this._resizeCanvas();
              if (!this._to_animate) {
                this._render();
              }
            }
          });

          return;
        }
      }

      if (!this._content) {
        this._content = document.createElement('div');
        this._content.style.width = '100%';
        // Height: panel = full viewport; otherwise use config.height (px) or 400px default
        if (this._ispanel()) {
          this._content.style.height = 'calc(100vh - var(--header-height))';
        } else {
          // height can be a bare number (→ px) or a full CSS value like "100vh", "50%", "calc(...)"
          this._content.style.height = this._config.height
            ? (typeof this._config.height === 'number' ? this._config.height + 'px' : String(this._config.height))
            : '400px';
        }
        this._content.style.alignContent = 'center';
        this._card.appendChild(this._content);
      }

      if (!this._ispanel()) {
        const show_header = this._config.header ? this._config.header : 'yes';

        if (show_header == 'yes') {
          (this._card as any).header = this._config.name ? this._config.name : 'Floor 3d';
        } else {
          (this._card as any).header = '';
        }
      }

      if (this._content && !this._renderer) {
        this.display3dmodel();
      }

      console.log('First updated end');
    }
  }

  /** Apply backgroundColor config to the scene and content div. Safe to call on fresh load AND cache restore. */
  private _applyBackground(): void {
    if (!this._scene || !this._renderer) return;
    const bg = this._config.backgroundColor || '';

    // Any value that has inherent alpha: transparent keyword, rgba(), hsla(), or CSS gradients.
    // These all require the ha-card shell to be transparent so the page background shows through.
    const isCssAlpha =
      /^transparent$/i.test(bg) ||
      /rgba?\s*\(/i.test(bg) ||
      /hsla?\s*\(/i.test(bg) ||
      /gradient|url\s*\(/i.test(bg);

    // Override ha-card's themed background (HA theme uses --ha-card-background which defaults to white).
    if (this._card) {
      if (isCssAlpha) {
        this._card.style.setProperty('--ha-card-background', 'transparent');
        this._card.style.background = 'transparent';
      } else {
        this._card.style.removeProperty('--ha-card-background');
        this._card.style.background = '';
      }
    }

    // Apply backdrop-filter (blur, etc.) to _content for glassmorphism effects.
    if (this._content) {
      const filter = this._config.backdrop_filter || '';
      (this._content.style as any).backdropFilter = filter;
      (this._content.style as any).webkitBackdropFilter = filter;
    }

    if (bg === 'transparent') {
      this._scene.background = null;
      this._renderer.setClearColor(0x000000, 0);
      if (this._content) this._content.style.background = '';
    } else if (isCssAlpha) {
      // CSS value with potential alpha (rgba, hsla, gradient, url) — apply as CSS background.
      this._scene.background = null;
      this._renderer.setClearColor(0x000000, 0);
      if (this._content) this._content.style.background = bg;
    } else if (bg) {
      // Solid colour — hand off to THREE.js for integrated scene background.
      if (this._content) this._content.style.background = '';
      this._scene.background = new THREE.Color(bg);
    } else if (this._config?.sky === 'yes') {
      // Sky shader renders the background — null lets it show through
      if (this._content) this._content.style.background = '';
      this._scene.background = null;
      this._renderer.setClearColor(0x000000, 0);
    } else {
      if (this._content) this._content.style.background = '';
      this._scene.background = new THREE.Color('#aaaaaa');
    }
  }

  private _render(): void {
    //render the model
    if (!this._renderer) return;
    // Batch multiple synchronous hass-triggered render calls into a single GPU frame.
    if (this._renderPending) return;
    this._renderPending = true;
    requestAnimationFrame(() => {
      this._renderPending = false;
      if (!this._renderer || !this._scene || !this._camera) return;
      if (this._torch) {
        this._torch.position.copy(this._camera.position);
        this._torch.rotation.copy(this._camera.rotation);
        this._camera.getWorldDirection(this._torch.target.position);
        //console.log(this._renderer.info);
      }
      this._renderer.render(this._scene, this._camera);
      this._updateOverlayPositions();
    });
  }

  private _getintersect(e: any): THREE.Intersection[] {
    const mouse: THREE.Vector2 = new THREE.Vector2();
    mouse.x = (e.offsetX / this._content.clientWidth) * 2 - 1;
    mouse.y = -(e.offsetY / this._content.clientHeight) * 2 + 1;
    const raycaster: THREE.Raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, this._camera);
    const intersects: THREE.Intersection[] = raycaster.intersectObjects(this._raycasting, false);
    return intersects;
  }

  private _mousedownEvent(e: any): void {
    this._currentIntersections = this._getintersect(e);
    this._clickStart = Date.now();
    this._longpressTimeout = setTimeout(() => this._longPressEvent(e), 600);
  }

  private _firEvent(e: any): void {
    //double click on object to show the name
    const intersects = this._getintersect(e);
    if (intersects.length > 0 && intersects[0].object.name != '') {
      if (this._selectionModeEnabled) {
        this._defaultaction(intersects);
        return;
      }

      this._config.entities.forEach((entity, i) => {
        for (let j = 0; j < this._object_ids[i].objects.length; j++) {
          if (this._object_ids[i].objects[j].object_id == intersects[0].object.name) {
            if (this._config.entities[i].action) {
              switch (this._config.entities[i].action) {
                case 'more-info':
                  fireEvent(this, 'hass-more-info', { entityId: entity.entity });
                  break;
                case 'overlay':
                  if (this._overlay) {
                    this._setoverlaycontent(entity.entity);
                  }
                  break;
                case 'default':
                default:
                  this._defaultaction(intersects);
              }
              return;
            } else {
              this._defaultaction(intersects);
              return;
            }
          }
        }
      });
    }
  }

  // Hold down the mouse button on object
  private _longPressEvent(_e: any): void {
    if (this._clickStart == null) return;
    this._clickStart = null;

    // Use intersections from the mousedown event
    const intersects = this._currentIntersections;
    this._currentIntersections = null;
    if (intersects.length > 0 && intersects[0].object.name != '') {
      this._config.entities.forEach((entity, i) => {
        for (let j = 0; j < this._object_ids[i].objects.length; j++) {
          if (this._object_ids[i].objects[j].object_id == intersects[0].object.name) {
            if (this._config.entities[i].long_press_action) {
              switch (this._config.entities[i].long_press_action) {
                case 'more-info':
                  fireEvent(this, 'hass-more-info', { entityId: entity.entity });
                  break;
                case 'overlay':
                  if (this._overlay) {
                    this._setoverlaycontent(entity.entity);
                  }
                  break;
                case 'default':
                default:
                  this._defaultaction(intersects);
              }
              return;
            }
          }
        }
      });
    }
  }

  private _setoverlaycontent(entity_id: string): void {
    this._overlay_entity = entity_id;
    const name = this._hass.states[entity_id].attributes['friendly_name']
      ? this._hass.states[entity_id].attributes['friendly_name']
      : entity_id;
    this._overlay.textContent = name + ': ' + this._hass.states[entity_id].state;
    this._overlay_state = this._hass.states[entity_id].state;
  }

  private _defaultaction(intersects: THREE.Intersection[]): void {
    if (intersects.length > 0 && intersects[0].object && intersects[0].object.name != '') {
      const objectName = intersects[0].object.name;

      if (getLovelace().editMode && this._config.editModeNotifications != 'no') {
        this._copyToClipboardAndToast(objectName, 'Object ID');
      }
      console.log('Object:', objectName);

      if (this._selectionModeEnabled) {
        // Color objects blue when we click them, so we can build a list of
        // rooms and walls to control a light
        const object: any = intersects[0].object;
        if (!this._selectedmaterial) {
          const newMaterial: any = new THREE.MeshStandardMaterial({ color: 0x7777ff });
          this._selectedmaterial = newMaterial;
        }
        if (!this._initialobjectmaterials[objectName]) {
          this._initialobjectmaterials[objectName] = object.material;
        }
        if (this._selectedobjects.includes(objectName)) {
          this._selectedobjects = this._selectedobjects.filter((e) => e !== objectName);
          object.material = this._initialobjectmaterials[objectName];
        } else {
          this._selectedobjects.push(objectName);
          object.material = this._selectedmaterial;
        }
        this._selectedobjects = this._selectedobjects.sort();
        console.log('Selected object IDs:', this._selectedobjects);
        this._render();
        render(this._getSelectionBar(), this._selectionbar);
        return;
      }

      this._config.entities.forEach((entity, i) => {
        if (entity.type3d == 'light' || entity.type3d == 'gesture' || entity.type3d == 'camera') {
          for (let j = 0; j < this._object_ids[i].objects.length; j++) {
            if (this._object_ids[i].objects[j].object_id == intersects[0].object.name) {
              if (entity.type3d == 'light') {
                this._hass.callService(entity.entity.split('.')[0], 'toggle', {
                  entity_id: entity.entity,
                });
              } else if (entity.type3d == 'gesture') {
                this._hass.callService(entity.gesture.domain, entity.gesture.service, {
                  entity_id: entity.entity,
                });
              } else if (entity.type3d == 'camera') {
                fireEvent(this, 'hass-more-info', { entityId: entity.entity });
                //this._hass.states[entity.entity].attributes["entity_picture"]
              }
              break;
            }
          }
        }
      });
    } else {
      const cameraData =
        'camera_position: { x: ' +
        this._camera.position.x +
        ', y: ' +
        this._camera.position.y +
        ', z: ' +
        this._camera.position.z +
        ' }\n' +
        'camera_rotate: { x: ' +
        this._camera.rotation.x +
        ', y: ' +
        this._camera.rotation.y +
        ', z: ' +
        this._camera.rotation.z +
        ' }\n' +
        'camera_target: { x: ' +
        this._controls.target.x +
        ', y: ' +
        this._controls.target.y +
        ', z: ' +
        this._controls.target.z +
        ' }';
      if (getLovelace().editMode && this._config.editModeNotifications != 'no') {
        this._copyToClipboardAndToast(cameraData, 'Camera YAML');
      }
      console.log('YAML:', cameraData);
    }
  }

  private _performAction(e: any): void {
    const intersects = this._getintersect(e);
    this._defaultaction(intersects);
  }

  private _getZIndex(toCheck: any): string {
    let returnVal: string;

    if (toCheck == null) {
      returnVal = '0';
    }

    if (toCheck.parentNode == null) {
      return '0';
    }

    returnVal = getComputedStyle(toCheck).getPropertyValue('--dialog-z-index');
    if (returnVal == '') {
      returnVal = getComputedStyle(toCheck).getPropertyValue('z-index');
    }

    if (returnVal == '' || returnVal == 'auto') {
      if (toCheck.parentNode.constructor != null) {
        if (toCheck.parentNode.constructor.name == 'ShadowRoot') {
          return this._getZIndex(toCheck.parentNode.host);
        } else if (toCheck.parentNode.constructor.name == 'HTMLDocument') {
          return '0';
        } else {
          return this._getZIndex(toCheck.parentNode);
        }
      } else {
        returnVal = '0';
      }
    }
    return returnVal;
  }

  private _resizeCanvasDebounce(): void {
    window.clearTimeout(this._resizeTimeout);
    this._resizeTimeout = window.setTimeout(() => {
      this._resizeCanvas();
    }, 50);
  }

  private _resizeCanvas(): void {
    console.log('Resize canvas start');
    if (!this._renderer?.domElement?.parentElement) return;
    const parentW = this._renderer.domElement.parentElement.clientWidth;
    const parentH = this._renderer.domElement.parentElement.clientHeight;
    if (parentW === 0 || parentH === 0) return; // layout not ready yet
    // Compare against the renderer's last-set logical size (CSS pixels).
    // domElement.clientWidth is always equal to parentElement.clientWidth because
    // the canvas style is set to width:100%/height:100%, so that comparison is
    // always false. domElement.width/height are physical pixels (CSS × DPR) and
    // likewise never equal parentW. renderer.getSize() is the ground truth.
    const rendSize = new THREE.Vector2();
    this._renderer.getSize(rendSize);
    if (parentW !== rendSize.x || parentH !== rendSize.y) {
      this._camera.aspect = parentW / parentH;
      this._camera.updateProjectionMatrix();
      this._renderer.setSize(parentW, parentH, !this._issidebar());
      this._renderer.render(this._scene, this._camera);
    }
    console.log('Resize canvas end');
  }

  private _statewithtemplate(entity: Floor3dCardConfig): string {
    if (this._hass.states[entity.entity]) {
      let state = this._hass.states[entity.entity].state;

      if (entity.entity_template) {
        const trimmed = entity.entity_template.trim();

        if (trimmed.substring(0, 3) === '[[[' && trimmed.slice(-3) === ']]]' && trimmed.includes('$entity')) {
          const normal = trimmed.slice(3, -3).replace(/\$entity/g, state);
          state = this._eval(normal);
        }
      }
      return state;
    } else {
      return '';
    }
  }

  public set hass(hass: HomeAssistant) {
    try {
      //called by Home Assistant Lovelace when a change of state is detected in entities
      const prevHass = this._hass; // capture BEFORE update for change detection
      this._hass = hass;
      if (this._config.entities) {
        if (!this._states) {
          //prepares to save the state
          this._states = [];
          this._unit_of_measurement = [];
          this._color = [];
          this._brightness = [];
          this._lights = [];
          this._rooms = [];
          this._sprites = [];
          this._canvas = [];
          this._text = [];
          this._spritetext = [];
          this._position = [];

          this._config.entities.forEach((entity) => {
            if (hass.states[entity.entity]) {
              this._states.push(this._statewithtemplate(entity));
              this._canvas.push(null);
              if (hass.states[entity.entity].attributes['unit_of_measurement']) {
                this._unit_of_measurement.push(hass.states[entity.entity].attributes['unit_of_measurement']);
              } else {
                this._unit_of_measurement.push('');
              }
              if (entity.type3d == 'text') {
                if (entity.text.attribute) {
                  if (hass.states[entity.entity].attributes[entity.text.attribute]) {
                    this._text.push(hass.states[entity.entity].attributes[entity.text.attribute]);
                  } else {
                    this._text.push(this._statewithtemplate(entity));
                  }
                } else {
                  this._text.push(this._statewithtemplate(entity));
                }
              } else {
                this._text.push('');
              }
              if (entity.type3d == 'room') {
                this._rooms.push(entity.object_id + '_room');
                this._sprites.push(entity.object_id + '_sprites');
                if (entity.room.attribute) {
                  if (hass.states[entity.entity].attributes[entity.room.attribute]) {
                    this._spritetext.push(hass.states[entity.entity].attributes[entity.room.attribute]);
                  } else {
                    this._spritetext.push(this._statewithtemplate(entity));
                  }
                } else {
                  if (entity.room.label_text) {
                    if (entity.room.label_text == 'template') {
                      this._spritetext.push(this._statewithtemplate(entity));
                      this._unit_of_measurement.pop();
                      this._unit_of_measurement.push('');
                    } else {
                      this._spritetext.push(this._hass.states[entity.entity].state);
                    }
                  }
                }
              } else {
                this._spritetext.push('');
                this._rooms.push('');
                this._sprites.push('');
              }
              if (entity.type3d == 'cover') {
                if (hass.states[entity.entity].attributes['current_position']) {
                  this._position.push(hass.states[entity.entity].attributes['current_position']);
                } else {
                  this._position.push(null);
                }
              }
              if (entity.type3d == 'light') {
                this._lights.push(entity.object_id + '_light');
              } else {
                this._lights.push('');
              }
              let i = this._color.push([255, 255, 255]) - 1;
              if (hass.states[entity.entity].attributes['color_mode']) {
                if ((hass.states[entity.entity].attributes['color_mode'] = 'color_temp')) {
                  this._color[i] = this._TemperatureToRGB(
                    parseInt(hass.states[entity.entity].attributes['color_temp']),
                  );
                }
              }
              if ((hass.states[entity.entity].attributes['color_mode'] = 'rgb')) {
                if (hass.states[entity.entity].attributes['rgb_color'] !== this._color[i]) {
                  this._color[i] = hass.states[entity.entity].attributes['rgb_color'];
                }
              }
              let j = this._brightness.push(-1) - 1;
              if (hass.states[entity.entity].attributes['brightness']) {
                this._brightness[j] = hass.states[entity.entity].attributes['brightness'];
              }
            } else {
              if (!this._loggedMissingEntities.has(entity.entity)) {
                this._loggedMissingEntities.add(entity.entity);
                console.warn('floor3d-card: Entity <' + entity.entity + '> not found in hass.states');
              }
            }
          });
          this._firstcall = false;
        }

        if (this._renderer && this._modelready) {
          let torerender = false;
          if (this._config.overlay) {
            if (this._config.overlay == 'yes') {
              if (this._overlay_entity) {
                if (this._overlay_state) {
                  if (this._overlay_state != hass.states[this._overlay_entity].state) {
                    this._setoverlaycontent(this._overlay_entity);
                  }
                }
              }
            }
          }
          this._config.entities.forEach((entity, i) => {
            if (hass.states[entity.entity]) {
              let state = this._statewithtemplate(entity);
              if (entity.type3d == 'cover') {
                let toupdate = false;
                if (hass.states[entity.entity].attributes['current_position']) {
                  if (this._position[i] != hass.states[entity.entity].attributes['current_position']) {
                    this._position[i] = hass.states[entity.entity].attributes['current_position'];
                    toupdate = true;
                  }
                } else {
                  if (state != this._states[i]) {
                    toupdate = true;
                    this._states[i] = state;
                  }
                }
                if (toupdate) {
                  this._updatecover(entity, this._states[i], i);
                  torerender = true;
                }
              }
              if (entity.type3d == 'light') {
                let toupdate = false;
                if (this._states[i] !== state) {
                  this._states[i] = state;
                  toupdate = true;
                }
                if (hass.states[entity.entity].attributes['color_mode']) {
                  if ((hass.states[entity.entity].attributes['color_mode'] = 'color_temp')) {
                    if (
                      this._TemperatureToRGB(parseInt(hass.states[entity.entity].attributes['color_temp'])) !==
                      this._color[i]
                    ) {
                      toupdate = true;
                      this._color[i] = this._TemperatureToRGB(
                        parseInt(hass.states[entity.entity].attributes['color_temp']),
                      );
                    }
                  }
                  if ((hass.states[entity.entity].attributes['color_mode'] = 'rgb')) {
                    if (hass.states[entity.entity].attributes['rgb_color'] !== this._color[i]) {
                      toupdate = true;
                      this._color[i] = hass.states[entity.entity].attributes['rgb_color'];
                    }
                  }
                }
                if (hass.states[entity.entity].attributes['brightness']) {
                  if (hass.states[entity.entity].attributes['brightness'] !== this._brightness[i]) {
                    toupdate = true;
                    this._brightness[i] = hass.states[entity.entity].attributes['brightness'];
                  }
                }
                if (toupdate) {
                  this._updatelight(entity, i);
                  torerender = true;
                }
              } else if (entity.type3d == 'text') {
                let toupdate = false;
                if (entity.text.attribute) {
                  if (hass.states[entity.entity].attributes[entity.text.attribute]) {
                    if (this._text[i] != hass.states[entity.entity].attributes[entity.text.attribute]) {
                      this._text[i] = hass.states[entity.entity].attributes[entity.text.attribute];
                      toupdate = true;
                    }
                  } else {
                    this._text[i] = '';
                    toupdate = true;
                  }
                } else {
                  if (this._text[i] != this._statewithtemplate(entity)) {
                    this._text[i] = this._statewithtemplate(entity);
                    toupdate = true;
                  }
                }
                if (this._canvas[i] && toupdate) {
                  this._updatetext(entity, this._text[i], this._canvas[i], this._unit_of_measurement[i]);
                  torerender = true;
                }
              } else if (entity.type3d == 'rotate') {
                this._states[i] = state;
                this._rotatecalc(entity, i);
              } else if (this._states[i] !== state) {
                this._states[i] = state;
                if (entity.type3d == 'color') {
                  this._updatecolor(entity, i);
                  torerender = true;
                } else if (entity.type3d == 'hide') {
                  this._updatehide(entity, i);
                  torerender = true;
                } else if (entity.type3d == 'show') {
                  this._updateshow(entity, i);
                  torerender = true;
                } else if (entity.type3d == 'door') {
                  this._updatedoor(entity, i);
                  torerender = true;
                } else if (entity.type3d == 'room') {
                  let toupdate = false;
                  if (entity.room.attribute) {
                    if (hass.states[entity.entity].attributes[entity.room.attribute]) {
                      if (this._spritetext[i] != hass.states[entity.entity].attributes[entity.room.attribute]) {
                        this._spritetext[i] = hass.states[entity.entity].attributes[entity.room.attribute];
                        toupdate = true;
                      }
                    } else {
                      this._spritetext[i] = '';
                      toupdate = true;
                    }
                  } else {
                    if (entity.room.label_text) {
                      if (entity.room.label_text == 'template') {
                        if (this._spritetext[i] != this._statewithtemplate(entity)) {
                          this._spritetext[i] = this._statewithtemplate(entity);
                          toupdate = true;
                        }
                      } else {
                        if (this._spritetext[i] != this._states[i]) {
                          this._spritetext[i] = this._states[i];
                          toupdate = true;
                        }
                      }
                    }
                  }

                  if (this._canvas[i] && toupdate) {
                    this._updateroom(entity, this._spritetext[i], this._unit_of_measurement[i], i);
                    this._updateroomcolor(entity, i);
                    torerender = true;
                  }
                }
              }
            } else {
              if (!this._loggedMissingEntities.has(entity.entity)) {
                this._loggedMissingEntities.add(entity.entity);
                console.warn('floor3d-card: Entity <' + entity.entity + '> not found in hass.states');
              }
            }
          });
          if (torerender) {
            this._render();
          }

          // --- Zoom entity watch ---
          // When zoom_entity is configured, fly the camera to the zoom area
          // whose name matches the entity state whenever the state changes.
          // "reset" / "none" returns to the default view.
          if (this._config.zoom_entity && hass.states[this._config.zoom_entity]) {
            const newZoomState = hass.states[this._config.zoom_entity].state;
            if (newZoomState !== this._lastZoomEntityState) {
              this._lastZoomEntityState = newZoomState;
              if (this._modelready && this._zoom && this._camera) {
                if (newZoomState === 'reset' || newZoomState === 'none') {
                  this._setCamera();
                  this._setLookAt();
                  this._controls.update();
                  this._render();
                } else {
                  const zoom = this._zoom.find((z: any) => z?.name === newZoomState);
                  if (zoom) this._flyToZoom(zoom, false); // false = don't write back
                }
              }
            }
          }

          // Update markers and room controls regardless of whether the
          // primary entity bindings changed, because their visibility
          // conditions may reference different entities.
          if (this._markerOverlay) {
            this._updateMarkersAndControls(hass);
          }

          // --- Dynamic sky live updates ---
          if (this._config.sky === 'yes' && this._sky) {
            // Sun position: update when azimuth or elevation changes
            const sunState     = hass.states['sun.sun'];
            const prevSunState = prevHass?.states['sun.sun'];
            const azimuthChanged   = sunState?.attributes?.['azimuth']   !== prevSunState?.attributes?.['azimuth'];
            const elevationChanged = sunState?.attributes?.['elevation'] !== prevSunState?.attributes?.['elevation'];
            const dayNightChanged  = sunState?.state !== prevSunState?.state;
            if (azimuthChanged || elevationChanged) {
              this._updateSunPosition();
            }
            if (dayNightChanged || azimuthChanged || elevationChanged) {
              this._updateMoonPosition();
            }
          }

          // Weather entity: update sky + particles when state changes; wind streaks on speed/bearing change
          if (this._config.weather_entity) {
            const ws  = hass.states[this._config.weather_entity];
            const pws = prevHass?.states[this._config.weather_entity];
            if (ws?.state !== pws?.state) {
              this._updateWeatherSky(ws.state);  // always update sky appearance
              if (this._weatherAnimationsEnabled) {
                this._createWeatherParticles(ws.state);
                this._initClouds(ws.state);
              }
            }
            if (ws && this._weatherAnimationsEnabled) {
              const newSpd = Number(ws.attributes?.['wind_speed']   ?? 0);
              const newBrg = Number(ws.attributes?.['wind_bearing'] ?? 270);
              const oldSpd = Number(pws?.attributes?.['wind_speed']   ?? 0);
              const oldBrg = Number(pws?.attributes?.['wind_bearing'] ?? 270);
              if (newSpd !== oldSpd || newBrg !== oldBrg || (newSpd > 18) !== (oldSpd > 18)) {
                this._updateWindStreaks(newSpd, newBrg);
              }
            }
          }

          // Moon phase entity: rebuild moon texture when state changes
          if (this._config.moon_entity) {
            const ms  = hass.states[this._config.moon_entity];
            const pms = prevHass?.states[this._config.moon_entity];
            if (ms?.state !== pms?.state) {
              this._updateMoonPhase();
            }
          }
        }
      }

      // Sky / weather / moon live updates — run regardless of entities config
      if (this._renderer && this._modelready) {
        // --- Dynamic sky live updates ---
        if (this._config.sky === 'yes' && this._sky) {
          const sunState     = hass.states['sun.sun'];
          const prevSunState = prevHass?.states['sun.sun'];
          const azimuthChanged   = sunState?.attributes?.['azimuth']   !== prevSunState?.attributes?.['azimuth'];
          const elevationChanged = sunState?.attributes?.['elevation'] !== prevSunState?.attributes?.['elevation'];
          const dayNightChanged  = sunState?.state !== prevSunState?.state;
          if (azimuthChanged || elevationChanged) {
            this._updateSunPosition();
          }
          if (dayNightChanged || azimuthChanged || elevationChanged) {
            this._updateMoonPosition();
          }
        }

        if (this._config.weather_entity) {
          const ws  = hass.states[this._config.weather_entity];
          const pws = prevHass?.states[this._config.weather_entity];
          if (ws?.state !== pws?.state) {
            this._updateWeatherSky(ws.state);  // always update sky appearance
            if (this._weatherAnimationsEnabled) {
              this._createWeatherParticles(ws.state);
              this._initClouds(ws.state);
            }
          }
          if (ws && this._weatherAnimationsEnabled) {
            const newSpd = Number(ws.attributes?.['wind_speed']   ?? 0);
            const newBrg = Number(ws.attributes?.['wind_bearing'] ?? 270);
            const oldSpd = Number(pws?.attributes?.['wind_speed']   ?? 0);
            const oldBrg = Number(pws?.attributes?.['wind_bearing'] ?? 270);
            if (newSpd !== oldSpd || newBrg !== oldBrg || (newSpd > 18) !== (oldSpd > 18)) {
              this._updateWindStreaks(newSpd, newBrg);
            }
          }
        }

        if (this._config.moon_entity) {
          const ms  = hass.states[this._config.moon_entity];
          const pms = prevHass?.states[this._config.moon_entity];
          if (ms?.state !== pms?.state) {
            this._updateMoonPhase();
          }
        }
      }
    } catch (e) {
      console.log(e);
      throw new Error('Error in hass: ' + e);
    }
  }

  private _initSky(): void {
    const effectController = {
      turbidity: 10,
      rayleigh: 3,
      mieCoefficient: 0.005,
      mieDirectionalG: 0.7,
      elevation: 15,
      azimuth: 0,
    };

    //init sky
    console.log('Init Sky');

    this._sky = new Sky();
    const skyScale = this._config.sky_distance ?? 100000;
    this._sky.scale.setScalar(skyScale);

    // Camera far plane must exceed the sky dome scale
    this._camera.far = Math.max(skyScale * 2, 200000);
    this._camera.updateProjectionMatrix();

    const uniforms = this._sky.material.uniforms;
    uniforms['turbidity'].value = effectController.turbidity;
    uniforms['rayleigh'].value = effectController.rayleigh;
    uniforms['mieCoefficient'].value = effectController.mieCoefficient;
    uniforms['mieDirectionalG'].value = effectController.mieDirectionalG;

    // Only add the sky mesh when sky_background is not 'no'.
    // With 'no', the sun direction / lighting / moon / weather still work
    // but the scene background stays transparent.
    if (this._config.sky_background !== 'no') {
      this._scene.add(this._sky);
    } else {
      // Ensure the renderer is fully transparent so the page shows through.
      this._scene.background = null;
      this._renderer.setClearColor(0x000000, 0);
    }

    // init ground

    console.log('Init Ground');

    if (this._config.ground !== 'none') {
      const groundGeo = new THREE.PlaneGeometry(10000, 10000);
      let groundColor = 0xffffff;
      let groundOpacity = 1.0;
      let groundTransparent = false;

      if (this._config.ground === 'transparent') {
        groundOpacity = 0.0;
        groundTransparent = true;
      } else if (this._config.ground) {
        // treat as a hex color string e.g. "#4a7c2f"
        try { groundColor = new THREE.Color(this._config.ground).getHex(); } catch (_) { /* ignore invalid */ }
      } else {
        // default: warm yellowish ground
        groundColor = new THREE.Color().setHSL(0.095, 1, 0.75).getHex();
      }

      const groundMat = new THREE.MeshLambertMaterial({
        color: groundColor,
        transparent: groundTransparent,
        opacity: groundOpacity,
      });
      const ground = new THREE.Mesh(groundGeo, groundMat);
      ground.position.y = -5;
      ground.rotation.x = -Math.PI / 2;
      ground.receiveShadow = false;
      ground.castShadow = false;
      this._scene.add(ground);
    }

    // init sun directional light

    console.log('Init Sun');

    this._sun = new THREE.DirectionalLight(0xffffff, 2.0);
    this._scene.add(this._sun);

    // shadow parameters
    const d = 1000;
    this._sun.castShadow = true;
    this._sun.shadow.mapSize.width = 1024;
    this._sun.shadow.mapSize.height = 1024;
    this._sun.shadow.camera.near = 4000;
    this._sun.shadow.camera.far = 6000;
    this._sun.shadow.camera.left = -d;
    this._sun.shadow.camera.right = d;
    this._sun.shadow.camera.top = d;
    this._sun.shadow.camera.bottom = -d;

    // Position sun from current sun.sun entity state
    this._updateSunPosition();

    // Initialise 3D moon and sun spheres above model
    this._initMoon();
    this._initSunMesh();

    //FOR DEBUG: this._scene.add(new THREE.CameraHelper(this._sun.shadow.camera));
  }

  /** Reposition the sun (sky shader + directional light) from the current sun.sun entity. */
  private _updateSunPosition(): void {
    if (!this._sky || !this._sun) return;

    // If sun.sun entity unavailable, use a sensible mid-afternoon default
    // so the sky renders correctly instead of a degenerate zero-vector sun.
    if (!this._hass?.states['sun.sun']) {
      const fallback = new THREE.Vector3(0.5, 0.3, 0.8).normalize();
      this._sky.material.uniforms['sunPosition'].value.copy(fallback);
      this._sun.position.copy(fallback.clone().multiplyScalar(5000));
      this._sun.intensity = 2.0;
      this._sunDirection = fallback;
      return;
    }

    const attrs = this._hass.states['sun.sun'].attributes;
    const azimuth   = Number(attrs['azimuth']   ?? 180);
    const elevation = Number(attrs['elevation']  ?? 15);

    const south = new THREE.Vector3();
    if (this._config.north) {
      south.set(-this._config.north.x, 0, -this._config.north.z);
    } else {
      south.set(0, 0, 1);
    }

    const sphere = new THREE.Spherical();
    sphere.setFromVector3(south);
    sphere.phi   = THREE.MathUtils.degToRad(90 - elevation);
    sphere.theta = THREE.MathUtils.degToRad(THREE.MathUtils.radToDeg(sphere.theta) - azimuth);

    const sunDir = new THREE.Vector3().setFromSphericalCoords(1, sphere.phi, sphere.theta);

    this._sun.intensity = sunDir.y < 0 ? 0 : 2.0;
    this._sky.material.uniforms['sunPosition'].value.copy(sunDir);
    this._sun.position.copy(sunDir.clone().multiplyScalar(5000));
    this._renderer.shadowMap.needsUpdate = true;

    // Normalized direction used for moon antipodal positioning
    this._sunDirection = sunDir.normalize();
    this._updateSunMeshPosition();
  }

  /** Update THREE.js sky shader uniforms + scene fog to match a HA weather state. */
  private _updateWeatherSky(state: string): void {
    if (!this._sky || !this._scene) return;
    const u = this._sky.material.uniforms;

    // [turbidity, rayleigh, fogDensity, fogColorHex]
    const params: Record<string, [number, number, number, number]> = {
      'sunny':           [10, 3, 0,        0xaaaaaa],
      'clear-night':     [10, 3, 0,        0xaaaaaa],
      'partlycloudy':    [13, 4, 0.00008,  0x999999],
      'cloudy':          [20, 6, 0.00015,  0x888888],
      'fog':             [28, 9, 0.0006,   0xbbbbbb],
      'rainy':           [20, 5, 0.00012,  0x888888],
      'lightning-rainy': [20, 5, 0.00012,  0x888888],
      'pouring':         [24, 6, 0.0002,   0x777777],
      'snowy':           [18, 5, 0.00012,  0xcccccc],
      'snowy-rainy':     [20, 5, 0.00015,  0xaaaaaa],
      'lightning':       [18, 5, 0.00012,  0x777777],
      'hail':            [22, 6, 0.00015,  0x777777],
      'windy':           [10, 3, 0,        0xaaaaaa],
      'windy-variant':   [10, 3, 0,        0xaaaaaa],
      'sandstorm':       [35, 7, 0.0008,   0xc8a070],
      'dust':            [35, 7, 0.0008,   0xc8a070],
      'exceptional':     [35, 7, 0.0008,   0xc8a070],
    };

    const [turbidity, rayleigh, fogDensity, fogColor] = params[state] ?? [10, 3, 0, 0xaaaaaa];
    u['turbidity'].value = turbidity;
    u['rayleigh'].value  = rayleigh;
    this._scene.fog = fogDensity > 0 ? new THREE.FogExp2(fogColor, fogDensity) : null;
  }

  /** Compute current lunar phase as a 0–1 fraction (0=new, 0.5=full). */
  private _computeMoonPhase(entityState?: string): number {
    if (entityState) {
      const stateMap: Record<string, number> = {
        'new_moon': 0, 'waxing_crescent': 0.125, 'first_quarter': 0.25,
        'waxing_gibbous': 0.375, 'full_moon': 0.5,
        'waning_gibbous': 0.625, 'last_quarter': 0.75, 'waning_crescent': 0.875,
      };
      return stateMap[entityState] ?? 0.5;
    }
    const knownNew = new Date('2000-01-06T18:14:00Z').getTime();
    const cycle = 29.53058770576 * 24 * 3600 * 1000;
    return ((Date.now() - knownNew) % cycle + cycle) % cycle / cycle;
  }

  /** Build a cartoon-style moon canvas texture with phase shadow. */
  private _buildMoonTexture(phase: number): THREE.CanvasTexture {
    const S = 256;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = S;
    const ctx = canvas.getContext('2d')!;
    const cx = S / 2, cy = S / 2, r = S / 2 - 12;

    // Outer soft glow
    const glow = ctx.createRadialGradient(cx, cy, r * 0.7, cx, cy, r + 10);
    glow.addColorStop(0, 'rgba(240,230,180,0.35)');
    glow.addColorStop(1, 'rgba(240,230,180,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, S, S);

    // Moon body gradient (creamy yellow-white)
    const bodyGrad = ctx.createRadialGradient(cx - r * 0.25, cy - r * 0.25, 0, cx, cy, r);
    bodyGrad.addColorStop(0, '#fffff0');
    bodyGrad.addColorStop(0.5, '#f5e9b0');
    bodyGrad.addColorStop(1, '#d4c870');
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = bodyGrad;
    ctx.fill();

    // Phase shadow (dark overlay for the unlit side)
    if (phase > 0.04 && phase < 0.96) { // skip new moon and full moon
      ctx.save();
      ctx.beginPath();
      if (phase <= 0.5) {
        // Waxing: dark on the left
        ctx.arc(cx, cy, r, Math.PI / 2, -Math.PI / 2); // left semicircle
        const ex = r * Math.cos(phase * Math.PI * 2);
        ctx.ellipse(cx, cy, Math.abs(ex), r, 0, -Math.PI / 2, Math.PI / 2, ex <= 0);
      } else {
        // Waning: dark on the right
        ctx.arc(cx, cy, r, -Math.PI / 2, Math.PI / 2); // right semicircle
        const ex = -r * Math.cos(phase * Math.PI * 2);
        ctx.ellipse(cx, cy, Math.abs(ex), r, 0, Math.PI / 2, -Math.PI / 2, ex <= 0);
      }
      ctx.fillStyle = 'rgba(10,15,30,0.82)';
      ctx.fill();
      ctx.restore();
    }

    // Subtle cartoon craters
    const craters = [[cx + r*0.25, cy - r*0.2, r*0.09], [cx - r*0.15, cy + r*0.3, r*0.07], [cx + r*0.1, cy + r*0.1, r*0.05]];
    for (const [x, y, cr] of craters) {
      ctx.beginPath();
      ctx.arc(x, y, cr, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(160,148,80,0.28)';
      ctx.fill();
    }

    // Clip everything to circle
    ctx.globalCompositeOperation = 'destination-in';
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';

    const moonTex = new THREE.CanvasTexture(canvas);
    moonTex.colorSpace = THREE.SRGBColorSpace;
    return moonTex;
  }

  /** Initialise the 3D moon mesh with phase texture. Called from _initSky(). */
  private _initMoon(): void {
    if (this._config.show_moon === 'no') return;

    // Clean up existing
    if (this._moonMesh) {
      this._scene.remove(this._moonMesh);
      (this._moonMesh.material as THREE.MeshStandardMaterial).map?.dispose();
      (this._moonMesh.material as THREE.MeshStandardMaterial).emissiveMap?.dispose();
      this._moonMesh.geometry.dispose();
      (this._moonMesh.material as THREE.Material).dispose();
      this._moonMesh = undefined;
    }

    const moonState = this._config.moon_entity
      ? this._hass?.states[this._config.moon_entity]?.state : undefined;
    const phase = this._computeMoonPhase(moonState);
    const tex   = this._buildMoonTexture(phase);

    const r = (this._modelBboxDiagonal || 300) * 0.055 * (this._config.moon_size ?? 1);
    const geo = new THREE.SphereGeometry(r, 32, 32);
    const mat = new THREE.MeshStandardMaterial({
      map: tex,
      emissiveMap: tex,
      emissive: new THREE.Color(0xffffff),
      emissiveIntensity: 0.9,
      roughness: 1,
      metalness: 0,
    });
    this._moonMesh = new THREE.Mesh(geo, mat);
    this._moonMesh.name = '__f3d_moon';
    this._moonMesh.visible = false;
    this._scene.add(this._moonMesh);
    this._updateMoonPosition();
  }

  /** Initialise the 3D sun sphere mesh. Called from _initSky(). */
  private _initSunMesh(): void {
    // Clean up existing
    if (this._sunMesh) {
      this._scene.remove(this._sunMesh);
      this._sunMesh.geometry.dispose();
      (this._sunMesh.material as THREE.Material).dispose();
      this._sunMesh = undefined;
    }

    const r = (this._modelBboxDiagonal || 300) * 0.035 * (this._config.sun_size ?? 1);
    const geo = new THREE.SphereGeometry(r, 32, 32);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffe680,
      transparent: true,
      opacity: 0.88,
      fog: false,
    });
    this._sunMesh = new THREE.Mesh(geo, mat);
    this._sunMesh.name = '__f3d_sun';
    this._sunMesh.visible = false;
    this._scene.add(this._sunMesh);
    this._updateSunMeshPosition();
  }

  /** Position moon sphere antipodal to the sun at configured distance; show only at night. */
  private _updateMoonPosition(): void {
    if (!this._moonMesh || !this._sunDirection) return;
    const isNight = this._hass?.states['sun.sun']?.state === 'below_horizon';
    this._moonMesh.visible = isNight;
    const dist = this._config.moon_distance ?? (this._modelBboxDiagonal || 300) * 1.5;
    const moonDir = this._sunDirection.clone().negate();
    this._moonMesh.position.copy(moonDir.multiplyScalar(dist));
  }

  /** Position sun sphere along the sun direction at configured distance; show only during day. */
  private _updateSunMeshPosition(): void {
    if (!this._sunMesh || !this._sunDirection) return;
    const isAboveHorizon = (this._sunDirection.y ?? 0) > -0.05;
    const isDay = this._hass?.states['sun.sun']?.state !== 'below_horizon';
    this._sunMesh.visible = isDay && isAboveHorizon;
    const dist = this._config.sun_distance ?? (this._modelBboxDiagonal || 300) * 1.5;
    this._sunMesh.position.copy(this._sunDirection.clone().multiplyScalar(dist));
  }

  /** Rebuild the moon phase canvas texture when moon_entity state changes. */
  private _updateMoonPhase(): void {
    if (!this._moonMesh) return;
    const moonState = this._config.moon_entity
      ? this._hass?.states[this._config.moon_entity]?.state : undefined;
    const phase = this._computeMoonPhase(moonState);
    const tex   = this._buildMoonTexture(phase);
    const mat   = this._moonMesh.material as THREE.MeshStandardMaterial;
    mat.map?.dispose();
    mat.emissiveMap?.dispose();
    mat.map = tex;
    mat.emissiveMap = tex;
    mat.needsUpdate = true;
  }

  /** Create a soft disc canvas texture for Point particles (snow, hail, sand, wind). */
  private _makeDiscSprite(color: string, size = 32): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, color);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
    return new THREE.CanvasTexture(canvas);
  }

  /** Remove active wind streak system from the scene. */
  private _removeWindSystem(): void {
    if (!this._windSystem) return;
    this._scene?.remove(this._windSystem.mesh);
    this._windSystem.mesh.geometry.dispose();
    (this._windSystem.mesh.material as THREE.Material).dispose();
    this._windSystem = undefined;
  }

  // ---------------------------------------------------------------------------
  // 3D Cloud puff system
  // ---------------------------------------------------------------------------

  /** Number of cloud puffs to show for a given HA weather state. */
  private _cloudCountForState(state: string): number {
    const map: Record<string, number> = {
      'sunny': 0, 'clear-night': 0,
      'partlycloudy': 3,
      'cloudy': 6,
      'fog': 5,
      'rainy': 5,   'lightning-rainy': 7, 'pouring': 8,
      'snowy': 5,   'snowy-rainy': 6,     'hail': 6,
      'lightning': 7,
      'windy': 2,   'windy-variant': 2,
      'sandstorm': 4, 'dust': 4, 'exceptional': 4,
    };
    return map[state] ?? 4;
  }

  /**
   * Build a single cartoony cloud from overlapping semi-transparent spheres.
   * @param baseRadius - radius of the central sphere in world units
   * @param tint - THREE hex color for the sphere material
   */
  private _makeCloud(baseRadius: number, tint: number): THREE.Group {
    const group = new THREE.Group();
    const add = (r: number, x: number, y: number, z: number, op: number) => {
      const geo = new THREE.SphereGeometry(r, 8, 6);
      const mat = new THREE.MeshBasicMaterial({
        color: tint, transparent: true, opacity: op, fog: false, depthWrite: false,
      });
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      group.add(m);
    };
    const r = baseRadius;
    add(r,          0,       0,        0,    0.92); // centre
    add(r * 0.72,   r * 0.9, 0,        0,    0.87); // right
    add(r * 0.72,  -r * 0.9, 0,        0,    0.87); // left
    add(r * 0.62,   r * 0.4, r * 0.55, 0,    0.83); // top-right bump
    add(r * 0.58,  -r * 0.3, r * 0.60, 0,    0.80); // top-left bump
    return group;
  }

  /** Remove all cloud puffs from the scene and free GPU resources. */
  private _removeClouds(): void {
    if (!this._cloudSystem) return;
    this._scene?.remove(this._cloudSystem.group);
    this._cloudSystem.group.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      }
    });
    this._cloudSystem = undefined;
  }

  /**
   * Build or rebuild the cloud puff system for the given weather state.
   * Clouds drift slowly in the wind direction and loop around the scene.
   * Called on model-ready init and whenever weather_entity state changes.
   */
  private _initClouds(weatherState: string): void {
    this._removeClouds();
    const count = this._cloudCountForState(weatherState);
    if (count === 0 || !this._scene) return;

    const bbox   = this._modelBboxDiagonal || 300;
    const height = this._config.cloud_distance ?? bbox * 0.9;
    const spread = bbox * 1.5;
    const baseR  = bbox * 0.1 * (this._config.cloud_size ?? 1.0);

    // Sandy/dusty weather → warm beige tint
    const isSandy = ['sandstorm', 'dust', 'exceptional'].includes(weatherState);
    const tint    = isSandy ? 0xd4b896 : 0xffffff;

    // Drift direction from weather entity wind_bearing (falls back to gentle westerly)
    const weatherAttrs = this._config.weather_entity
      ? this._hass?.states[this._config.weather_entity]?.attributes : null;
    const windBearing = Number(weatherAttrs?.['wind_bearing'] ?? 270);
    const windSpeedKmh = Number(weatherAttrs?.['wind_speed'] ?? 15);

    // Meteorological bearing → TO direction vector (same maths as _updateWindStreaks)
    let northX = 0, northZ = 1;
    if (this._config.north) {
      const n = new THREE.Vector3(
        this._config.north.x ?? 0, 0, this._config.north.z ?? 1,
      ).normalize();
      northX = n.x; northZ = n.z;
    }
    const eastX = northZ, eastZ = -northX;
    const bRad  = THREE.MathUtils.degToRad(windBearing);
    const driftDX = -(Math.sin(bRad) * eastX + Math.cos(bRad) * northX);
    const driftDZ = -(Math.sin(bRad) * eastZ + Math.cos(bRad) * northZ);

    // Cloud drift speed: 30–70 % of wind speed in world-units/s, capped 5–22 u/s
    const baseSpeed = Math.min(Math.max(windSpeedKmh * 0.5, 5), 22);

    const group  = new THREE.Group();
    group.name   = '__f3d_clouds';
    const clouds: { mesh: THREE.Group; vel: THREE.Vector3 }[] = [];

    for (let ci = 0; ci < count; ci++) {
      const scale = 0.60 + Math.random() * 0.75;
      const cloud = this._makeCloud(baseR * scale, tint);

      // Scatter in a disc at the configured height
      const angle  = (ci / count) * Math.PI * 2 + (Math.random() - 0.5) * 1.5;
      const radius = spread * (0.15 + Math.random() * 0.85);
      cloud.position.set(
        Math.cos(angle) * radius,
        height + (Math.random() - 0.5) * baseR * 1.5,
        Math.sin(angle) * radius,
      );
      cloud.rotation.y = Math.random() * Math.PI * 2;

      // Per-cloud speed variation so they don't march in lockstep
      const spd = baseSpeed * (0.55 + Math.random() * 0.9);
      const vel = new THREE.Vector3(driftDX * spd, 0, driftDZ * spd);

      group.add(cloud);
      clouds.push({ mesh: cloud, vel });
    }

    this._scene.add(group);
    this._cloudSystem = { group, clouds, spread: spread * 1.3 };
    this._startOrStopAnimationLoop();
  }

  /** Remove active weather particles and lightning light from the scene. */
  private _removeWeatherParticles(): void {
    if (this._weatherSystem) {
      this._scene?.remove(this._weatherSystem.mesh);
      this._weatherSystem.mesh.geometry.dispose();
      (this._weatherSystem.mesh.material as THREE.Material).dispose();
      this._weatherSystem = undefined;
    }
    if (this._lightningLight) {
      this._scene?.remove(this._lightningLight);
      this._lightningLight = undefined;
    }
    this._lightningTimer = 0;
    this._lightningPhase = 0;
  }

  /**
   * Build a 3D particle/streak system for the given HA weather state and add to scene.
   * Particles are animated each frame in _animationLoop().
   */
  private _createWeatherParticles(state: string): void {
    this._removeWeatherParticles();
    if (!this._scene || this._config.weather_precipitation === 'no') return;

    const spread = Math.max(this._modelBboxDiagonal || 400, 400) * 1.5;
    const maxY   = Math.max(this._modelBboxDiagonal || 200, 200) * 0.8;

    // Helper: create a Points mesh with frustum culling disabled
    const makePoints = (
      positions: Float32Array,
      velocities: Float32Array,
      tex: THREE.CanvasTexture,
      sizePx: number,
      opacity: number,
      type: 'snow' | 'hail' | 'sand' | 'wind',
    ) => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      // sizeAttenuation:false = pixel size constant regardless of camera distance,
      // so particles stay visible from any zoom level.
      const mat = new THREE.PointsMaterial({
        map: tex, size: sizePx, transparent: true, opacity,
        depthWrite: false, sizeAttenuation: false,
      });
      const mesh = new THREE.Points(geo, mat);
      mesh.name = '__f3d_weather';
      mesh.frustumCulled = false; // never cull — positions change every frame
      this._scene.add(mesh);
      this._weatherSystem = { mesh, velArray: velocities, spread, maxY, type, segLen: 0 };
    };

    // Apply particle_density multiplier to all counts (default 1.0).
    const densityMul = Math.max(0.1, this._config?.particle_density ?? 1.0);

    // Rain / Pouring / Snowy-rainy: LineSegments (streak look)
    if (state === 'rainy' || state === 'lightning-rainy' || state === 'pouring' || state === 'snowy-rainy') {
      const count  = Math.round((state === 'pouring' ? 600 : state === 'snowy-rainy' ? 220 : 400) * densityMul);
      const segLen = state === 'pouring' ? 18 : 12;
      const col    = state === 'pouring' ? 0x8899cc : 0x99aadd;

      const positions = new Float32Array(count * 6);
      const velY      = new Float32Array(count);

      for (let i = 0; i < count; i++) {
        const x = (Math.random() - 0.5) * spread * 2;
        const y = Math.random() * (maxY + segLen);
        const z = (Math.random() - 0.5) * spread * 2;
        const v = 150 + Math.random() * 100; // faster fall for visibility
        positions[i * 6]     = x;  positions[i * 6 + 1] = y + segLen;  positions[i * 6 + 2] = z;
        positions[i * 6 + 3] = x;  positions[i * 6 + 4] = y;           positions[i * 6 + 5] = z;
        velY[i] = v;
      }

      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      const mat = new THREE.LineBasicMaterial({
        color: col, transparent: true, opacity: 0.65, depthWrite: false,
      });
      const mesh = new THREE.LineSegments(geo, mat);
      mesh.name = '__f3d_weather';
      mesh.frustumCulled = false; // positions change every frame
      this._scene.add(mesh);
      this._weatherSystem = { mesh, velArray: velY, spread, maxY, type: 'rain', segLen };

      if (state === 'lightning-rainy') {
        this._lightningLight = new THREE.PointLight(0xc8d8ff, 0, spread * 0.8, spread * 2);
        this._lightningLight.position.set(0, maxY * 0.9, 0);
        this._scene.add(this._lightningLight);
        this._lightningTimer = Math.random() * 5;
      }
      this._startOrStopAnimationLoop();
      return;
    }

    // Lightning only
    if (state === 'lightning') {
      this._lightningLight = new THREE.PointLight(0xc8d8ff, 0, spread * 0.8, spread * 2);
      this._lightningLight.position.set(0, maxY * 0.9, 0);
      this._scene.add(this._lightningLight);
      this._lightningTimer = Math.random() * 5;
      this._startOrStopAnimationLoop();
      return;
    }

    // Snow
    if (state === 'snowy') {
      const count = Math.round(350 * densityMul);
      const tex   = this._makeDiscSprite('rgba(220,235,255,0.95)');
      const positions  = new Float32Array(count * 3);
      const velocities = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        positions[i*3]   = (Math.random() - 0.5) * spread * 2;
        positions[i*3+1] = Math.random() * maxY;
        positions[i*3+2] = (Math.random() - 0.5) * spread * 2;
        velocities[i*3]   = (Math.random() - 0.5) * 10;
        velocities[i*3+1] = -(20 + Math.random() * 20); // faster fall
        velocities[i*3+2] = (Math.random() - 0.5) * 10;
      }
      makePoints(positions, velocities, tex, 14, 0.88, 'snow');
      this._startOrStopAnimationLoop();
      return;
    }

    // Hail
    if (state === 'hail') {
      const count = Math.round(200 * densityMul);
      const tex   = this._makeDiscSprite('rgba(210,225,255,0.98)');
      const positions  = new Float32Array(count * 3);
      const velocities = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        positions[i*3]   = (Math.random() - 0.5) * spread * 2;
        positions[i*3+1] = Math.random() * maxY;
        positions[i*3+2] = (Math.random() - 0.5) * spread * 2;
        velocities[i*3]   = (Math.random() - 0.5) * 15;
        velocities[i*3+1] = -(120 + Math.random() * 80); // fast hail
        velocities[i*3+2] = (Math.random() - 0.5) * 15;
      }
      makePoints(positions, velocities, tex, 10, 0.92, 'hail');
      this._startOrStopAnimationLoop();
      return;
    }

    // Sandstorm / dust — keep low (below model top) so it doesn't bury the house
    if (state === 'sandstorm' || state === 'dust' || state === 'exceptional') {
      const count = Math.round(350 * densityMul);
      const tex   = this._makeDiscSprite('rgba(200,155,70,0.82)');
      const sandMaxY = maxY * 0.45; // stay below roofline
      const positions  = new Float32Array(count * 3);
      const velocities = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        positions[i*3]   = (Math.random() - 0.5) * spread * 2;
        positions[i*3+1] = Math.random() * sandMaxY;
        positions[i*3+2] = (Math.random() - 0.5) * spread * 2;
        velocities[i*3]   = 80 + Math.random() * 60;
        velocities[i*3+1] = (Math.random() - 0.5) * 10;
        velocities[i*3+2] = (Math.random() - 0.5) * 20;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      const mat = new THREE.PointsMaterial({
        map: tex, size: 8, transparent: true, opacity: 0.7,
        depthWrite: false, sizeAttenuation: false,
      });
      const mesh = new THREE.Points(geo, mat);
      mesh.name = '__f3d_weather';
      mesh.frustumCulled = false;
      this._scene.add(mesh);
      this._weatherSystem = { mesh, velArray: velocities, spread, maxY: sandMaxY, type: 'sand', segLen: 0 };
      this._startOrStopAnimationLoop();
      return;
    }

    // 'windy'/'windy-variant': wind streaks handled by _updateWindStreaks() (speed-based, not state-based).
    // Clear/cloudy/fog/partlycloudy/windy: sky uniforms handle visuals; no particles needed.
  }

  /**
   * Build or rebuild the wind streak system from the weather entity's wind_speed and wind_bearing
   * attributes. Shows horizontal line streaks in the wind direction whenever wind_speed > 18 km/h,
   * regardless of the overall weather state (can coexist with rain, snow, etc.).
   */
  private _updateWindStreaks(windSpeed: number, bearing: number): void {
    this._removeWindSystem();
    if (windSpeed <= 18 || !this._scene || this._config.weather_precipitation === 'no') return;

    // Compute north/east basis vectors from config
    let northX = 0, northZ = 1;
    if (this._config.north) {
      const n = new THREE.Vector3(
        this._config.north.x ?? 0, 0, this._config.north.z ?? 1,
      ).normalize();
      northX = n.x; northZ = n.z;
    }
    // east = rotate north 90° CW around Y: east = (northZ, 0, -northX)
    const eastX = northZ;
    const eastZ = -northX;

    // Meteorological bearing = direction FROM which wind blows
    // Wind blows TO = -(FROM direction)
    const bRad   = THREE.MathUtils.degToRad(bearing);
    const wdx    = -(Math.sin(bRad) * eastX + Math.cos(bRad) * northX);
    const wdz    = -(Math.sin(bRad) * eastZ + Math.cos(bRad) * northZ);
    const windDir = new THREE.Vector3(wdx, 0, wdz).normalize();

    const spread = Math.max(this._modelBboxDiagonal || 400, 400) * 1.5;
    const maxY   = Math.max(this._modelBboxDiagonal || 200, 200) * 0.5;

    // Speed: world units/s proportional to km/h
    const baseSpeed = windSpeed * 12; // 20 km/h → 240 u/s, 60 km/h → 720 u/s

    // Count: proportional to wind speed, capped; scaled by particle_density
    const densityMulWind = Math.max(0.1, this._config?.particle_density ?? 1.0);
    const count = Math.max(1, Math.round(Math.min(Math.floor(windSpeed * 8), 200) * densityMulWind));

    const positions  = new Float32Array(count * 6);
    const speeds     = new Float32Array(count);
    const segLengths = new Float32Array(count);

    // Perpendicular (across-wind) direction in XZ plane
    const perpX = -windDir.z;
    const perpZ =  windDir.x;

    for (let i = 0; i < count; i++) {
      // Random position: along wind and across wind
      const along  = (Math.random() - 0.5) * spread * 2;
      const across = (Math.random() - 0.5) * spread * 2;
      const sx = windDir.x * along + perpX * across;
      const sy = Math.random() * maxY;
      const sz = windDir.z * along + perpZ * across;

      // Streak length proportional to wind speed, with randomness
      const slen = windSpeed * 2.5 * (0.4 + Math.random() * 1.4);
      // Per-streak speed variation so they don't all move in lockstep
      const spd  = 0.7 + Math.random() * 0.6;

      segLengths[i] = slen;
      speeds[i]     = spd;

      // Start = tail, end = head (downwind from start)
      positions[i*6]   = sx;             positions[i*6+1] = sy; positions[i*6+2] = sz;
      positions[i*6+3] = sx + windDir.x * slen; positions[i*6+4] = sy; positions[i*6+5] = sz + windDir.z * slen;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    // Light blue streaks, like wind icon colors
    const mat = new THREE.LineBasicMaterial({
      color: 0xaaddff, transparent: true, opacity: Math.min(0.3 + windSpeed * 0.01, 0.65),
      depthWrite: false,
    });
    const mesh = new THREE.LineSegments(geo, mat);
    mesh.name = '__f3d_wind';
    mesh.frustumCulled = false;
    this._scene.add(mesh);

    this._windSystem = { mesh, count, windDir, baseSpeed, speeds, segLengths, spread, maxY };
    this._startOrStopAnimationLoop();
  }

  private _initTorch(): void {
    this._torch = new THREE.DirectionalLight(0xffffff, 0.2);
    this._torchTarget = new THREE.Object3D();
    this._torchTarget.name = 'Torch Target';
    this._torch.target = this._torchTarget;
    this._torch.matrixAutoUpdate = true;
    this._scene.add(this._torch);
    this._scene.add(this._torchTarget);

    this._torch.castShadow = false;

    this._torch.position.copy(this._camera.position);
    this._torch.rotation.copy(this._camera.rotation);
    this._camera.getWorldDirection(this._torch.target.position);

    if (this._hass.states[this._config.globalLightPower]) {
      if (!Number.isNaN(this._hass.states[this._config.globalLightPower].state)) {
        this._torch.intensity = Number(this._hass.states[this._config.globalLightPower].state);
      }
    } else {
      if (this._config.globalLightPower) {
        this._torch.intensity = Number(this._config.globalLightPower);
      }
    }
  }

  private _initAmbient(): void {
    let intensity = 0.5;

    if (this._hass.states[this._config.globalLightPower]) {
      if (!Number.isNaN(this._hass.states[this._config.globalLightPower].state)) {
        intensity = Number(this._hass.states[this._config.globalLightPower].state);
      }
    } else {
      if (this._config.globalLightPower) {
        intensity = Number(this._config.globalLightPower);
      }
    }

    if (this._config.sky == 'yes') {
      this._ambient_light = new THREE.HemisphereLight(0xffffff, 0x000000, 0.2);
      this._ambient_light.groundColor.setHSL(0.095, 1, 0.75);
      this._ambient_light.intensity = intensity;
    } else {
      this._ambient_light = new THREE.AmbientLight(0xffffff, 0.2);
      this._ambient_light.intensity = intensity;
    }

    this._scene.add(this._ambient_light);
  }

  protected async display3dmodel(): Promise<void> {
    //load the model into the GL Renderer

    // Disable r152+ default ColorManagement and restore r130 light pipeline.
    // Existing light intensity values were authored for r130's non-physical mode
    // (physicallyCorrectLights = false). r170 makes physical lights the only mode,
    // but disabling ColorManagement keeps the color/brightness pipeline compatible.
    THREE.ColorManagement.enabled = false;

    console.log('Start Build Renderer');
    this._modelready = false;

    //create and initialize scene and camera

    this._scene = new THREE.Scene();

    this._camera = new THREE.PerspectiveCamera(45, 1, 0.1, 10000);

    // create and initialize renderer

    // WebGPU opt-in: use WebGPURenderer when configured and supported, else WebGLRenderer.
    const useWebGPU = this._config.webgpu === 'yes' && typeof navigator !== 'undefined' && !!(navigator as any).gpu;

    if (useWebGPU) {
      try {
        // Dynamic import keeps WebGPU bundle out of WebGL-only builds.
        // @ts-ignore — three/webgpu is not in @types/three's node-resolution paths
        const { WebGPURenderer } = await import('three/webgpu');
        const gpuRenderer = new WebGPURenderer({ antialias: true, alpha: true });
        await gpuRenderer.init();
        this._renderer = gpuRenderer as unknown as THREE.WebGLRenderer;
        console.info('floor3d-card: WebGPU renderer active');
      } catch (e) {
        console.warn('floor3d-card: WebGPU init failed, falling back to WebGL', e);
        this._renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true, alpha: true });
      }
    } else {
      this._renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true, alpha: true });
    }

    // Handle WebGL context loss (e.g. Android backgrounding reclaims GPU).
    this._renderer.domElement.addEventListener('webglcontextlost', (e) => {
      e.preventDefault(); // allow the browser to attempt restoration
      console.log('floor3d-card: WebGL context lost');
      if (this._to_animate) this._renderer?.setAnimationLoop(null);
      this._modelready = false;
    }, false);
    this._renderer.domElement.addEventListener('webglcontextrestored', () => {
      console.log('floor3d-card: WebGL context restored, reloading model');
      this.display3dmodel();
    }, false);

    // WebGPU renderer doesn't expose capabilities.maxTextures; default to 16.
    this._maxtextureimage = (this._renderer as any).capabilities?.maxTextures ?? 16;
    console.log('Max Texture Image Units: ' + this._maxtextureimage);
    console.log('Max Texture Image Units: number of lights casting shadow should be less than the above number');

    const availableshadows = Math.max(6, this._maxtextureimage - 4);

    this._renderer.domElement.style.width = '100%';
    this._renderer.domElement.style.height = '100%';
    this._renderer.domElement.style.display = 'block';

    this._applyBackground();

    // Match r130: linear output by default, sRGB only when sky shader is active.
    this._renderer.outputColorSpace = (this._config.sky === 'yes')
      ? THREE.SRGBColorSpace
      : THREE.LinearSRGBColorSpace;
    this._renderer.toneMapping = THREE.LinearToneMapping;
    //this._renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this._renderer.toneMappingExposure = 0.6;
    this._renderer.localClippingEnabled = true;

    if (this._config.path && this._config.path != '') {
      let path = this._config.path;
      const lastChar = path.charAt(path.length - 1);
      if (lastChar == '.') {
        path = '';
      } else if (lastChar != '/') {
        path = path + '/';
      }
      console.log('Path: ' + path);

      let fileExt = this._config.objfile.split('?')[0].split('.').pop();

      if (fileExt == 'obj') {
        //waterfront format
        if (this._config.mtlfile && this._config.mtlfile != '') {
          const mtlLoader: MTLLoader = new MTLLoader();
          mtlLoader.setPath(path);
          mtlLoader.load(
            this._config.mtlfile,
            this._onLoaded3DMaterials.bind(this),
            this._onLoadMaterialProgress.bind(this),
            function (error: unknown): void {
              throw new Error(String(error));
            },
          );
        } else {
          const objLoader: OBJLoader = new OBJLoader();
          objLoader.load(
            path + this._config.objfile,
            this._onLoaded3DModel.bind(this),
            this._onLoadObjectProgress.bind(this),
            function (error: unknown): void {
              throw new Error(String(error));
            },
          );
        }
        this._modeltype = ModelSource.OBJ;
      } else if (fileExt == 'glb') {
        //glb format
        const loader = new GLTFLoader().setPath(path);
        loader.setMeshoptDecoder(MeshoptDecoder);
        loader.load(
          this._config.objfile,
          this._onLoadedGLTF3DModel.bind(this),
          this._onloadedGLTF3DProgress.bind(this),
          function (error: unknown): void {
            throw new Error(String(error));
          },
        );
        this._modeltype = ModelSource.GLB;
      }
    } else {
      throw new Error('Path is empty');
    }
    console.log('End Build Renderer');
  }

  private _onLoadError(event: ErrorEvent): void {
    this._showError(event.error);
  }

  private _onloadedGLTF3DProgress(_progress: ProgressEvent): void {
    this._content.innerText = 'Loading: ' + Math.round((_progress.loaded / _progress.total) * 100) + '%';
  }

  private _onLoadMaterialProgress(_progress: ProgressEvent): void {
    //progress function called at regular intervals during material loading process
    this._content.innerText = '1/2: ' + Math.round((_progress.loaded / _progress.total) * 100) + '%';
  }

  private _onLoadObjectProgress(_progress: ProgressEvent): void {
    //progress function called at regular intervals during object loading process
    this._content.innerText = '2/2: ' + Math.round((_progress.loaded / _progress.total) * 100) + '%';
  }

  private _onLoadedGLTF3DModel(gltf: GLTF) {
    this._onLoaded3DModel(gltf.scene);
  }

  private _onLoaded3DModel(object: Object3D): void {
    // Object Loaded Event: last root object passed to the function

    console.log('Object loaded start');

    this._initobjects(object);

    this._bboxmodel = new THREE.Object3D();

    this._levels.forEach((element) => {
      this._bboxmodel.add(element);
    });

    this._scene.add(this._bboxmodel);

    this._bboxmodel.updateMatrixWorld(true);

    // Freeze local-matrix auto-recomputation on all loaded model objects.
    // Three.js calls updateMatrix() (Euler→Quaternion→Matrix4) on every object
    // with matrixAutoUpdate=true during each render traversal. For static objects
    // (walls, floors, furniture) this is pure waste after the initial load.
    // Objects that DO need updates (rotating fans, TWEEN-animated doors/covers)
    // call updateMatrix() explicitly — see _animationLoop and TWEEN onUpdate callbacks.
    this._bboxmodel.traverse((obj) => { obj.matrixAutoUpdate = false; });

    this._content.innerText = 'Finished with errors: check the console log';

    if (this._config.show_axes) {
      if (this._config.show_axes == 'yes') {
        this._scene.add(new THREE.AxesHelper(300));
      }
    }

    if (this._config.shadow && this._config.shadow == 'yes') {
      console.log('Shadow On');
      this._renderer.shadowMap.enabled = true;
      this._renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      this._renderer.shadowMap.autoUpdate = false;
    } else {
      console.log('Shadow Off');
      this._renderer.shadowMap.enabled = false;
    }

    this._add3dObjects();

    console.log('Object loaded end');

    if (this._content && this._renderer) {
      this._modelready = true;
      // Anchor positions computed from the just-loaded model; clear any stale cache.
      this._anchorWorldPosCache.clear();
      // Reset missing-entity log deduplication so new config errors surface once.
      this._loggedMissingEntities.clear();
      console.log('Show canvas');
      this._levelbar = document.createElement('div');
      this._zoombar = document.createElement('div');
      this._selectionbar = document.createElement('div');
      this._weatherbar = document.createElement('div');
      this._animationsbar = document.createElement('div');
      this._content.innerText = '';
      this._content.appendChild(this._levelbar);
      this._content.appendChild(this._zoombar);
      this._content.appendChild(this._selectionbar);
      this._content.appendChild(this._weatherbar);
      this._content.appendChild(this._animationsbar);
      this._content.appendChild(this._renderer.domElement);
      this._selectedlevel = -1;

      render(this._getSelectionBar(), this._selectionbar);

      this._content.addEventListener('mousedown', this._mousedownEventListener);
      this._content.addEventListener('mouseup', this._mouseupEventListener);
      this._content.addEventListener('dblclick', this._performActionListener);
      this._content.addEventListener('touchstart', this._performActionListener);
      this._content.addEventListener('keydown', this._performActionListener);

      // Long-press touch listeners for mobile object-ID discovery
      this._content.addEventListener('touchstart', (e: TouchEvent) => this._discoverTouchStart(e), { passive: true });
      this._content.addEventListener('touchmove', (e: TouchEvent) => this._discoverTouchCancel(e), { passive: true });
      this._content.addEventListener('touchend', () => this._discoverTouchCancel(), { passive: true });

      this._setCamera();

      this._controls = new OrbitControls(this._camera, this._renderer.domElement);

      // Cap DPR to reduce pixel count on HiDPI/Retina screens (2–3× DPR devices).
      // Default cap of 1.5 cuts 44–75% of pixels vs native DPR with minimal quality loss.
      this._renderer.setPixelRatio(Math.min(window.devicePixelRatio, this._config?.max_pixel_ratio ?? 1.5));

      this._controls.maxPolarAngle = (0.85 * Math.PI) / 2;
      this._controls.addEventListener('change', this._changeListener);

      this._setLookAt();

      this._controls.update();

      if (this._config.lock_camera == 'yes') {
        /*
                this._controls.enableRotate = false;
                this._controls.enableZoom = false;
                this._controls.enablePan = false;
        */
        this._controls.enabled = false;
      }

      if (this._config.sky && this._config.sky == 'yes') {
        this._initSky();
      }

      if (!this._config.sky || this._config.sky == 'no') {
        this._initTorch();
      }

      this._initAmbient();

      this._getOverlay();

      this._initMarkerOverlay();

      this._manageZoom();

      const initialLevel = typeof this._config.initialLevel === 'undefined' ? -1 : this._config.initialLevel;
      this._setVisibleLevel(initialLevel);

      this._resizeCanvas();

      // Schedule a second resize after the current frame — clientWidth can be 0
      // if the browser hasn't finished layout when the async model callback fires
      // (e.g. switching between dashboards with different card sizes).
      requestAnimationFrame(() => {
        if (!this._renderer || !this._modelready) return;
        this._resizeCanvas();
        if (!this._to_animate) this._render();
      });

      /*
      this._zoom.forEach(element => {

        this._bboxmodel.localToWorld(element.position);
        this._bboxmodel.localToWorld(element.target);

      });
      */

      this._intersectionObserver.observe(this);

      // Always observe — cards in a responsive grid also need resize handling.
      this._resizeObserver.observe(this._card);
    }
  }

  private _initobjects(object: THREE.Object3D) {
    console.log('Ïnit Objects, Levels and Raycasting');

    let level = 0;
    this._levels = [];
    this._raycasting = [];
    this._raycastinglevels = [];
    //TODO: explore solution with layers

    console.log('Found level 0');

    this._levels[0] = new THREE.Object3D();
    this._raycastinglevels[0] = [];

    const regex = /lvl(?<level>\d{3})/;

    let imported_objects: THREE.Object3D[] = [];

    object.traverse((element) => {
      imported_objects.push(element);
    });

    imported_objects.forEach((element) => {
      let found;

      found = element.name.match(regex);

      if (found) {
        if (!this._levels[Number(found.groups?.level)]) {
          console.log('Found level ' + found.groups?.level);
          this._levels[Number(found.groups?.level)] = new THREE.Object3D();
          this._raycastinglevels[Number(found.groups?.level)] = [];
        }

        element.userData = { level: Number(found.groups?.level) };
        element.name = element.name.slice(6);
        this._levels[Number(found.groups?.level)].add(element);
        level = Number(found.groups?.level);
      } else {
        element.userData = { level: 0 };
        this._levels[0].add(element);
        level = 0;
      }

      element.receiveShadow = true;

      if (element.name.includes('transparent_slab')) {
        element.castShadow = true;
        if ((element as THREE.Mesh).material instanceof THREE.MeshPhongMaterial) {
          ((element as THREE.Mesh).material as THREE.MeshPhongMaterial).depthWrite = false;
        } else if ((element as THREE.Mesh).material instanceof THREE.MeshBasicMaterial) {
          ((element as THREE.Mesh).material as THREE.MeshBasicMaterial).depthWrite = false;
        } else if ((element as THREE.Mesh).material instanceof THREE.MeshStandardMaterial) {
          ((element as THREE.Mesh).material as THREE.MeshStandardMaterial).transparent = true;
          ((element as THREE.Mesh).material as THREE.MeshStandardMaterial).opacity = 0;
          ((element as THREE.Mesh).material as THREE.MeshStandardMaterial).depthWrite = false;
        }
        return;
      }

      if (this._modeltype == ModelSource.GLB) {
        if (element.name.includes('_hole_')) {
          element.castShadow = false;
          if ((element as THREE.Mesh).material instanceof THREE.MeshStandardMaterial) {
            ((element as THREE.Mesh).material as THREE.MeshStandardMaterial).transparent = true;
            ((element as THREE.Mesh).material as THREE.MeshStandardMaterial).opacity = 0;
          }
          return;
        }
      }

      this._raycastinglevels[level].push(element);
      //this._raycasting.push(element);

      if (element instanceof THREE.Mesh) {
        if (!Array.isArray((element as THREE.Mesh).material)) {
          if (((element as THREE.Mesh).material as THREE.Material).opacity != 1) {
            if ((element as THREE.Mesh).material instanceof THREE.MeshPhongMaterial) {
              ((element as THREE.Mesh).material as THREE.MeshPhongMaterial).depthWrite = false;
            } else if ((element as THREE.Mesh).material instanceof THREE.MeshBasicMaterial) {
              ((element as THREE.Mesh).material as THREE.MeshBasicMaterial).depthWrite = false;
            } else if ((element as THREE.Mesh).material instanceof THREE.MeshStandardMaterial) {
              ((element as THREE.Mesh).material as THREE.MeshBasicMaterial).depthWrite = false;
            }
            element.castShadow = false;
            return;
          }
        }
      }

      const shadow = this._config.shadow ? this._config.shadow : 'no';

      if (shadow == 'no') {
        element.castShadow = false;
      } else {
        element.castShadow = true;
      }

      return;
    });

    this._displaylevels = [];
    this._levels.forEach((level, index) => {
      if (level) {
        this._displaylevels.push(true);
        this._raycasting = this._raycasting.concat(this._raycastinglevels[index]);
      }
    });
    console.log('End Init Objects. Number of levels found: ' + this._levels.length);
  }

  private _setVisibleLevel(level: number) {
    this._levels.forEach((element, i) => {
      if (level == -1) {
        this._displaylevels[i] = true;
      } else {
        this._displaylevels[i] = i == level;
      }
      element.visible = this._displaylevels[i];
    });
    this._updateRaycasting();
    render(this._getLevelBar(), this._levelbar);
  }

  private _toggleVisibleLevel(level: number): void {
    this._levels.forEach((element, i) => {
      if (level == -1) {
        this._displaylevels[i] = true;
      } else if (level == i) {
        this._displaylevels[i] = !this._displaylevels[i];
      }
      element.visible = this._displaylevels[i];
    });
    this._updateRaycasting();
  }

  private _updateRaycasting() {
    this._raycasting = [];
    this._displaylevels.forEach((visible, index) => {
      if (visible) {
        this._raycasting = this._raycasting.concat(this._raycastinglevels[index]);
      }
    });
  }

  /**
   * Render the weather-animations toggle button (bottom-right corner).
   * Only shown when weather_entity is configured and hide_weather_ui !== 'yes'.
   */
  private _getWeatherBar(): TemplateResult {
    if (!this._config?.weather_entity) return html``;
    if (this._config.hide_weather_ui === 'yes') return html``;

    const on   = this._weatherAnimationsEnabled;
    const icon = on ? 'mdi:weather-cloudy' : 'mdi:cloud-off-outline';

    return html`
      <div style="position:absolute;bottom:10px;right:10px;z-index:10;pointer-events:auto;">
        <div
          title="${on ? 'Hide weather effects' : 'Show weather effects'}"
          style="
            background:rgba(0,0,0,0.55);
            border-radius:50%;
            width:36px;height:36px;
            display:flex;align-items:center;justify-content:center;
            cursor:pointer;
            box-shadow:0 2px 6px rgba(0,0,0,0.4);
            opacity:${on ? 0.75 : 0.45};
            transition:opacity 0.2s;
          "
          @click=${this._handleWeatherToggleClick.bind(this)}
        >
          <ha-icon .icon=${icon} style="color:white;width:22px;height:22px;"></ha-icon>
        </div>
      </div>
    `;
  }

  private _handleWeatherToggleClick(ev): void {
    ev.stopPropagation();
    this._weatherAnimationsEnabled = !this._weatherAnimationsEnabled;
    const enabled = this._weatherAnimationsEnabled;

    // Toggle visibility of all active weather particle systems
    if (this._weatherSystem) this._weatherSystem.mesh.visible = enabled;
    if (this._cloudSystem)   this._cloudSystem.group.visible  = enabled;
    if (this._windSystem)    this._windSystem.mesh.visible    = enabled;
    if (this._lightningLight) {
      this._lightningLight.visible = enabled;
      if (!enabled) this._lightningLight.intensity = 0;
    }

    this._startOrStopAnimationLoop();
    if (!enabled) this._render();

    if (this._weatherbar) render(this._getWeatherBar(), this._weatherbar);
  }

  /**
   * Render the room-animations toggle button (bottom-right, to the left of weather button).
   * Only shown when animations are configured and hide_animations_ui !== 'yes'.
   */
  private _getAnimationsBar(): TemplateResult {
    if (!this._config?.animations?.length) return html``;
    if (this._config.hide_animations_ui === 'yes') return html``;

    const on   = this._animationsEnabled;
    const icon = on ? 'mdi:music-note' : 'mdi:music-note-off';
    // Offset left enough to clear the weather button (if present) without hardcoding
    const rightOffset = this._config.weather_entity && this._config.hide_weather_ui !== 'yes'
      ? 54   // weather button is at right:10, so sit 44px to its left
      : 10;

    return html`
      <div style="position:absolute;bottom:10px;right:${rightOffset}px;z-index:10;pointer-events:auto;">
        <div
          title="${on ? 'Hide room animations' : 'Show room animations'}"
          style="
            background:rgba(0,0,0,0.55);
            border-radius:50%;
            width:36px;height:36px;
            display:flex;align-items:center;justify-content:center;
            cursor:pointer;
            box-shadow:0 2px 6px rgba(0,0,0,0.4);
            opacity:${on ? 0.75 : 0.45};
            transition:opacity 0.2s;
          "
          @click=${this._handleAnimationsToggleClick.bind(this)}
        >
          <ha-icon .icon=${icon} style="color:white;width:22px;height:22px;"></ha-icon>
        </div>
      </div>
    `;
  }

  private _handleAnimationsToggleClick(ev): void {
    ev.stopPropagation();
    this._animationsEnabled = !this._animationsEnabled;
    const enabled = this._animationsEnabled;

    // Immediately hide/show all particle systems
    for (const sys of this._animParticleSystems.values()) {
      sys.active = enabled && sys.active; // keep active=false if it was already false
      if (!enabled) {
        sys.active = false;
        if (sys.sprites) sys.sprites.forEach(s => { s.visible = false; });
        if (sys.mesh)    sys.mesh.visible = false;
      }
    }

    // When re-enabling, let _updateMarkersAndControls re-evaluate entity states
    if (enabled && this._hass) this._updateMarkersAndControls(this._hass);

    this._startOrStopAnimationLoop();
    if (!enabled) this._render();

    if (this._animationsbar) render(this._getAnimationsBar(), this._animationsbar);
  }

  private _getZoomBar(): TemplateResult {
    if (this._config?.hide_zoom_areas_ui === 'yes') return html``;
    if (this._levels) {
      if (this._zoom.length > 0) {
        return html`
          <div class="category" style="opacity: 0.5; position: absolute; bottom: 0px; left: 0px">
            ${this._getZoomButtons()}
          </div>
        `;
      } else {
        return html``;
      }
    } else {
      return html``;
    }
  }

  private _getZoomButtons(): TemplateResult[] {
    const iconArray: TemplateResult[] = [];

    iconArray.push(html`
      <div class="row" style="background-color:black;">
        <font color="white">
          <floor3d-button style="opacity: 100%;" label="reset" .index=${-1} @click=${this._handleZoomClick.bind(this)}>
          </floor3d-button>
        </font>
      </div>
    `);

    this._zoom.forEach((element, index) => {
      if (element) {
        iconArray.push(html`
          <div class="row" style="background-color:black;">
            <font color="white">
              <floor3d-button label=${element.name} .index=${index} @click=${this._handleZoomClick.bind(this)}>
              </floor3d-button>
            </font>
          </div>
        `);
      }
    });

    return iconArray;
  }

  private _getLevelBar(): TemplateResult {
    if (this._levels) {
      if (this._levels.length > 1 && (this._config.hideLevelsMenu == null || this._config.hideLevelsMenu == 'no')) {
        return html` <div class="category" style="opacity: 0.5; position: absolute">${this._getLevelIcons()}</div> `;
      } else {
        return html``;
      }
    } else {
      return html``;
    }
  }

  private _getLevelIcons(): TemplateResult[] {
    const iconArray: TemplateResult[] = [];

    iconArray.push(html`
      <div class="row" style="background-color:black;">
        <font color="white">
          <ha-icon
            .icon=${`mdi:format-list-numbered`}
            style="opacity: 100%;"
            class="ha-icon-large"
            .index=${-1}
            @click=${this._handleLevelClick.bind(this)}
          >
          </ha-icon>
        </font>
      </div>
    `);

    this._levels.forEach((element, index) => {
      if (element) {
        iconArray.push(html`
          <div class="row" style="background-color:black;">
            <font color="white">
              <ha-icon
                .icon=${`mdi:numeric-${index}-box-multiple`}
                style=${this._displaylevels[index] ? 'opacity: 100%;' : 'opacity: 60%;'}
                class="ha-icon-large"
                .index=${index}
                @click=${this._handleLevelClick.bind(this)}
              >
              </ha-icon>
            </font>
          </div>
        `);
      }
    });

    return iconArray;
  }

  private _getSelectionBar(): TemplateResult {
    if (this._config.selectionMode == 'yes') {
      const buttonArray: TemplateResult[] = [];
      buttonArray.push(html`
        <div class="row" style="background-color:black;">
          <font color="white">
            <floor3d-button
              style="opacity: 100%;"
              label="clear selections (${this._selectedobjects.length})"
              @click=${this._handleClearSelectionsClick.bind(this)}
            >
            </floor3d-button>
          </font>
        </div>
      `);

      buttonArray.push(html`
        <div class="row" style="background-color:black;">
          <font color="white">
            <floor3d-button
              style="opacity: 100%;"
              label="${this._selectionModeEnabled ? 'Disable Selection' : 'Enable Selection'}"
              @click=${this._handleToggleSelectionMode.bind(this)}
            >
            </floor3d-button>
          </font>
        </div>
      `);

      return html`
        <div class="category" style="opacity: 0.5; position: absolute; bottom: 0px; right: 0px">${buttonArray}</div>
      `;
    } else {
      return html``;
    }
  }

  private _setSelectionMaterials(show: boolean): void {
    this._selectedobjects.forEach((objectName) => {
      let object: any = this._scene.getObjectByName(objectName);
      if (object) {
        object.material = show ? this._selectedmaterial : this._initialobjectmaterials[objectName];
      }
    });
    this._render();
  }

  private _handleClearSelectionsClick(ev): void {
    ev.stopPropagation();
    this._setSelectionMaterials(false);
    this._selectedobjects = [];
    console.log('Cleared selected objects');
    render(this._getSelectionBar(), this._selectionbar);
  }

  private _handleToggleSelectionMode(ev): void {
    ev.stopPropagation();
    this._selectionModeEnabled = !this._selectionModeEnabled;
    this._setSelectionMaterials(this._selectionModeEnabled);
    render(this._getSelectionBar(), this._selectionbar);
  }

  private _handleZoomClick(ev): void {
    ev.stopPropagation();
    if (ev.target.index == -1) {
      this._setCamera();
      this._setLookAt();
      this._controls.update();
      this._render();
      // Write "reset" back to zoom_entity if configured
      if (this._config?.zoom_entity && this._hass) {
        this._lastZoomEntityState = 'reset';
        this._hass.callService('input_select', 'select_option', {
          entity_id: this._config.zoom_entity,
          option: 'reset',
        });
      }
      return;
    }
    this._flyToZoom(this._zoom[ev.target.index]);
  }

  /**
   * Smoothly fly the camera to a zoom area (position + target lerp over ~800ms).
   * @param zoom       The zoom area config object.
   * @param writeBack  When true (default), sync state back to zoom_entity so
   *                   other HA components can read the current zoom area.
   *                   Pass false when called from set hass to avoid an echo loop.
   */
  private _flyToZoom(zoom: any, writeBack = true): void {
    if (!zoom || !this._camera || !this._controls) return;

    if (zoom.level != null) {
      this._setVisibleLevel(zoom.level);
    }

    // Sync zoom_entity so automations / other cards can read the current zoom.
    if (writeBack && this._config?.zoom_entity && this._hass && zoom.name) {
      const currentState = this._hass.states[this._config.zoom_entity]?.state;
      if (currentState !== zoom.name) {
        this._lastZoomEntityState = zoom.name; // prevent echo on the next hass update
        this._hass.callService('input_select', 'select_option', {
          entity_id: this._config.zoom_entity,
          option: zoom.name,
        });
      }
    }

    const startPos = this._camera.position.clone();
    const startTarget = this._controls.target.clone();
    const endPos = new THREE.Vector3(zoom.position.x, zoom.position.y, zoom.position.z);
    const endTarget = new THREE.Vector3(zoom.target.x, zoom.target.y, zoom.target.z);
    const duration = 750; // ms
    const startTime = performance.now();

    const animate = (now: number) => {
      if (!this._camera || !this._controls) return;
      const t = Math.min((now - startTime) / duration, 1);
      // ease-in-out cubic
      const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      this._camera.position.lerpVectors(startPos, endPos, ease);
      this._controls.target.lerpVectors(startTarget, endTarget, ease);
      this._controls.update();
      this._render();
      if (t < 1) requestAnimationFrame(animate);
    };
    requestAnimationFrame(animate);
  }

  private _handleLevelClick(ev): void {
    ev.stopPropagation();

    this._toggleVisibleLevel(ev.target.index);

    render(this._getLevelBar(), this._levelbar);

    this._render();
  }

  private _getOverlay(): void {
    if (this._config.overlay == 'yes') {
      console.log('Start config Overlay');
      const overlay = document.createElement('div');
      overlay.id = 'overlay';
      overlay.className = 'overlay';
      overlay.style.setProperty('position', 'absolute');
      if (this._config.overlay_alignment) {
        switch (this._config.overlay_alignment) {
          case 'top-left':
            overlay.style.setProperty('top', '0px');
            overlay.style.setProperty('left', '0px');
            break;
          case 'top-right':
            overlay.style.setProperty('top', '0px');
            overlay.style.setProperty('right', '0px');
            break;
          case 'bottom-left':
            overlay.style.setProperty('bottom', '0px');
            overlay.style.setProperty('left', '0px');
            break;
          case 'bottom-right':
            overlay.style.setProperty('bottom', '0px');
            overlay.style.setProperty('right', '0px');
            break;
          default:
            overlay.style.setProperty('top', '0px');
            overlay.style.setProperty('left', '0px');
        }
      }
      if (this._config.overlay_width) {
        overlay.style.setProperty('width', this._config.overlay_width + '%');
      } else {
        overlay.style.setProperty('width', '33%');
      }
      if (this._config.overlay_height) {
        overlay.style.setProperty('height', this._config.overlay_height + '%');
      } else {
        overlay.style.setProperty('height', '20%');
      }

      if (this._config.overlay_bgcolor) {
        overlay.style.setProperty('background-color', this._config.overlay_bgcolor);
      } else {
        overlay.style.setProperty('background-color', 'transparent');
      }
      if (this._config.overlay_fgcolor) {
        overlay.style.setProperty('color', this._config.overlay_fgcolor);
      } else {
        overlay.style.setProperty('color', 'black');
      }
      if (this._config.overlay_font) {
        overlay.style.fontFamily = this._config.overlay_font;
      }
      if (this._config.overlay_fontsize) {
        overlay.style.fontSize = this._config.overlay_fontsize;
      }

      overlay.style.setProperty('overflow', 'hidden');
      overlay.style.setProperty('white-space', 'nowrap');
      let zindex = '';

      try {
        zindex = this._getZIndex(this._renderer.domElement.parentNode);
      } catch (error) {
        console.log(error);
      }

      if (zindex) {
        overlay.style.setProperty('z-index', (Number(zindex) + 1).toString(10));
      } else {
        overlay.style.setProperty('z-index', '999');
      }

      (this._renderer.domElement.parentNode as HTMLElement).style.setProperty('position', 'relative');
      this._renderer.domElement.parentNode.appendChild(overlay);
      this._overlay = overlay;
      console.log('End config Overlay');
    }
  }

  private _setCamera(): void {
    const box: THREE.Box3 = new THREE.Box3().setFromObject(this._bboxmodel);

    this._modelX = this._bboxmodel.position.x = -(box.max.x - box.min.x) / 2;
    this._modelY = this._bboxmodel.position.y = -box.min.y;
    this._modelZ = this._bboxmodel.position.z = -(box.max.z - box.min.z) / 2;

    // Store the bounding-box diagonal so _updateOverlayPositions can scale
    // markers / controls proportionally to camera distance.
    const bsize = box.getSize(new THREE.Vector3());
    this._modelBboxDiagonal = bsize.length() || 300;

    if (this._config.camera_position) {
      this._camera.position.set(
        this._config.camera_position.x,
        this._config.camera_position.y,
        this._config.camera_position.z,
      );
    } else {
      this._camera.position.set(box.max.x * 1.3, box.max.y * 5, box.max.z * 1.3);
    }

    if (this._config.camera_rotate) {
      this._camera.rotation.set(
        this._config.camera_rotate.x,
        this._config.camera_rotate.y,
        this._config.camera_rotate.z,
      );
    } else {
      this._camera.rotation.set(0, 0, 0);
    }

    this._camera.updateProjectionMatrix();
  }

  private _setLookAt(): void {
    const box: THREE.Box3 = new THREE.Box3().setFromObject(this._bboxmodel);

    if (this._config.camera_target) {
      this._controls.target.set(
        this._config.camera_target.x,
        this._config.camera_target.y,
        this._config.camera_target.z,
      );
    } else {
      this._camera.lookAt(box.max.multiplyScalar(0.5));
    }
    this._camera.updateProjectionMatrix();
  }

  private _setNoShadowLight(object: THREE.Object3D): void {
    object.receiveShadow = true;
    object.castShadow = false;

    return;
  }

  private _onLoaded3DMaterials(materials: MTLLoader.MaterialCreator): void {
    // Materials Loaded Event: last root material passed to the function
    console.log('Material loaded start');
    materials.preload();
    let path = this._config.path;
    const lastChar = path.substr(-1);
    if (lastChar != '/') {
      path = path + '/';
    }
    const objLoader: OBJLoader = new OBJLoader();
    objLoader.setMaterials(materials);
    objLoader.load(
      path + this._config.objfile,
      this._onLoaded3DModel.bind(this),
      this._onLoadObjectProgress.bind(this),
      function (error: unknown): void {
        throw new Error(String(error));
      },
    );
    console.log('Material loaded end');
  }

  /**
   * Expands wildcard patterns in object_ids (e.g. "Wall_*") against the loaded scene.
   * Must be called after the model is in the scene but before entity setup iterates _object_ids.
   * Glob rules: * matches any sequence of characters within a name segment.
   */
  private _expandWildcardObjectIds(): void {
    if (!this._scene || !this._object_ids) return;

    for (const entry of this._object_ids) {
      const needsExpansion = entry.objects.some((o) => o.object_id.includes('*'));
      if (!needsExpansion) continue;

      const expanded: { object_id: string }[] = [];
      for (const obj of entry.objects) {
        if (!obj.object_id.includes('*')) {
          expanded.push(obj);
          continue;
        }
        // Build a regex from the glob pattern, escaping special regex chars first
        const escaped = obj.object_id.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
        const regex   = new RegExp('^' + escaped.replace(/\*/g, '.*') + '$');
        this._scene.traverse((child) => {
          if (child instanceof THREE.Mesh && child.name && regex.test(child.name)) {
            expanded.push({ object_id: child.name });
          }
        });
      }
      entry.objects = expanded;
    }
  }

  private _add3dObjects(): void {
    try {
      // Add-Modify the objects bound to the entities in the card config
      console.log('Add Objects Start');
      if (this._states && this._config.entities) {
        // Expand wildcard object_ids (e.g. "Wall_*") against the loaded scene before any entity setup.
        this._expandWildcardObjectIds();

        this._round_per_seconds = [];
        this._axis_to_rotate = [];
        this._rotation_state = [];
        this._rotation_index = [];
        this._animated_transitions = [];
        this._pivot = [];
        this._axis_for_door = [];
        this._degrees = [];
        this._slidingdoor = [];
        this._objposition = [];
        this._slidingdoorposition = [];
        this._to_animate = false;
        this._zoom = [];

        this._config.entities.forEach((entity, i) => {
          try {
            this._objposition.push([0, 0, 0]);
            this._pivot.push(null);
            this._axis_for_door.push(null);
            this._degrees.push(0);
            this._slidingdoor.push(null);
            this._slidingdoorposition.push([]);
            if (this._hass.states[entity.entity]) {
              if (entity.type3d == 'rotate') {
                this._round_per_seconds.push(entity.rotate.round_per_second);
                this._axis_to_rotate.push(entity.rotate.axis);
                this._rotation_state.push(0);
                this._rotation_index.push(i);
                let bbox: THREE.Box3;
                let hinge: any;
                if (entity.rotate.hinge) {
                  hinge = this._scene.getObjectByName(entity.rotate.hinge);
                } else {
                  hinge = this._scene.getObjectByName(this._object_ids[i].objects[0].object_id);
                }
                bbox = new THREE.Box3().setFromObject(hinge);
                this._pivot[i] = new THREE.Vector3();
                this._pivot[i].subVectors(bbox.max, bbox.min).multiplyScalar(0.5);
                this._pivot[i].add(bbox.min);

                this._object_ids[i].objects.forEach((element) => {
                  let _obj: any = this._scene.getObjectByName(element.object_id);
                  this._centerobjecttopivot(_obj, this._pivot[i]);
                  _obj.geometry.applyMatrix4(
                    new THREE.Matrix4().makeTranslation(-this._pivot[i].x, -this._pivot[i].y, -this._pivot[i].z),
                  );
                });
              }
              if (entity.type3d == 'door') {
                if (entity.door.doortype != 'swing' && entity.door.doortype != 'slide') {
                  throw new Error('Invalid door type: ' + entity.door.doortype + '. Valid types are: swing, slide');
                }

                if (entity.door.doortype == 'swing') {
                  // console.log("Start Add Door Swing");
                  let position = new THREE.Vector3();
                  if (entity.door.hinge) {
                    let hinge: THREE.Mesh = this._scene.getObjectByName(entity.door.hinge) as THREE.Mesh;
                    hinge.geometry.computeBoundingBox();
                    let boundingBox = hinge.geometry.boundingBox;
                    position.subVectors(boundingBox.max, boundingBox.min);
                    switch (Math.max(position.x, position.y, position.z)) {
                      case position.x:
                        this._axis_for_door[i] = new THREE.Vector3(1, 0, 0);
                        break;
                      case position.z:
                        this._axis_for_door[i] = new THREE.Vector3(0, 0, 1);
                        break;
                      case position.y:
                      default:
                        this._axis_for_door[i] = new THREE.Vector3(0, 1, 0);
                    }
                    position.multiplyScalar(0.5);
                    position.add(boundingBox.min);
                    position.applyMatrix4(hinge.matrixWorld);
                  } else {
                    let pane: THREE.Mesh;

                    if (entity.door.pane) {
                      pane = this._scene.getObjectByName(entity.door.pane) as THREE.Mesh;
                    } else {
                      pane = this._scene.getObjectByName(this._object_ids[i].objects[0].object_id) as THREE.Mesh;
                    }

                    pane.geometry.computeBoundingBox();
                    let boundingBox = pane.geometry.boundingBox;
                    position.subVectors(boundingBox.max, boundingBox.min);
                    const side = entity.door.swing_side || entity.door.side;

                    if (side) {
                      switch (side) {
                        case 'up':
                          position.x = position.x / 2;
                          position.z = position.z / 2;
                          position.y = position.y;
                          if (position.x > position.z) {
                            this._axis_for_door[i] = new THREE.Vector3(1, 0, 0);
                          } else {
                            this._axis_for_door[i] = new THREE.Vector3(0, 0, 1);
                          }
                          break;
                        case 'down':
                          position.x = position.x / 2;
                          position.z = position.z / 2;
                          position.y = 0;
                          if (position.x > position.z) {
                            this._axis_for_door[i] = new THREE.Vector3(1, 0, 0);
                          } else {
                            this._axis_for_door[i] = new THREE.Vector3(0, 0, 1);
                          }
                          break;
                        case 'left':
                          if (position.x > position.z) {
                            position.x = 0;
                            position.z = position.z / 2;
                          } else {
                            position.z = 0;
                            position.x = position.x / 2;
                          }
                          this._axis_for_door[i] = new THREE.Vector3(0, 1, 0);
                          position.y = 0;
                          break;
                        case 'right':
                          if (position.x > position.z) {
                            position.z = position.z / 2;
                          } else {
                            position.x = position.x / 2;
                          }
                          this._axis_for_door[i] = new THREE.Vector3(0, 1, 0);
                          position.y = 0;
                          break;
                        default:
                          throw new Error('Invalid side: ' + side + '. Valid sides are: up, down, left, right');
                      }
                    }
                    position.add(boundingBox.min);
                    position.applyMatrix4(pane.matrixWorld);
                  }

                  this._pivot[i] = position;
                  if (typeof entity.door.swing_degrees !== 'undefined') {
                    this._degrees[i] = entity.door.swing_degrees;
                  } else if (typeof entity.door.degrees !== 'undefined') {
                    this._degrees[i] = entity.door.degrees;
                  } else {
                    this._degrees[i] = 90;
                  }

                  this._object_ids[i].objects.forEach((element) => {
                    let _obj: any = this._scene.getObjectByName(element.object_id);

                    this._centerobjecttopivot(_obj, this._pivot[i]);

                    _obj.geometry.applyMatrix4(
                      new THREE.Matrix4().makeTranslation(-this._pivot[i].x, -this._pivot[i].y, -this._pivot[i].z),
                    );
                  });

                  // console.log("End Add Door Swing");
                }
                if (entity.door.doortype == 'slide') {
                  // if (entity.door.doortype == 'slide') {
                  // console.log("Start Add Door Slide");

                  this._object_ids[i].objects.forEach((element) => {
                    let _obj: any = this._scene.getObjectByName(element.object_id);
                    let objbbox = new THREE.Box3().setFromObject(_obj);
                    this._slidingdoorposition[i].push(objbbox.min);
                    this._centerobjecttopivot(_obj, objbbox.min);
                    _obj.geometry.applyMatrix4(
                      new THREE.Matrix4().makeTranslation(-objbbox.min.x, -objbbox.min.y, -objbbox.min.z),
                    );
                  });

                  // console.log("End Add Door Slide");
                }
              }
              if (entity.type3d == 'cover') {
                const pane: THREE.Mesh = this._scene.getObjectByName(entity.cover.pane) as THREE.Mesh;

                if (pane) {
                  this._object_ids[i].objects.forEach((element) => {
                    let _obj: any = this._scene.getObjectByName(element.object_id);
                    let objbbox = new THREE.Box3().setFromObject(_obj);
                    this._slidingdoorposition[i].push(objbbox.min);
                    this._centerobjecttopivot(_obj, objbbox.min);
                    _obj.geometry.applyMatrix4(
                      new THREE.Matrix4().makeTranslation(-objbbox.min.x, -objbbox.min.y, -objbbox.min.z),
                    );
                  });

                  let boxpane: THREE.Box3 = new THREE.Box3().setFromObject(pane);

                  let panevertices: THREE.Vector3[] = [];

                  switch (entity.cover.side) {
                    case 'up':
                      panevertices = [
                        new THREE.Vector3(boxpane.min.x, boxpane.max.y, boxpane.min.z), // 000
                        new THREE.Vector3(boxpane.min.x, boxpane.max.y, boxpane.max.z), // 001
                        new THREE.Vector3(boxpane.max.x, boxpane.max.y, boxpane.min.z), // 010
                        new THREE.Vector3(boxpane.max.x, boxpane.max.y, boxpane.max.z), // 011
                      ];
                      break;
                    case 'down':
                      panevertices = [
                        new THREE.Vector3(boxpane.min.x, boxpane.min.y, boxpane.min.z), // 000
                        new THREE.Vector3(boxpane.min.x, boxpane.min.y, boxpane.max.z), // 001
                        new THREE.Vector3(boxpane.max.x, boxpane.min.y, boxpane.min.z), // 010
                        new THREE.Vector3(boxpane.max.x, boxpane.min.y, boxpane.max.z), // 011
                      ];
                      break;
                  }

                  panevertices.sort((firstel, secondel) => {
                    if (firstel.x < secondel.x) {
                      return -1;
                    }
                    if (firstel.x > secondel.x) {
                      return 1;
                    }
                    return 0;
                  });

                  const coverplane = new THREE.Plane();

                  coverplane.setFromCoplanarPoints(panevertices[2], panevertices[1], panevertices[0]);

                  const clipPlanes = [coverplane];

                  this._object_ids[i].objects.forEach((element) => {
                    let _obj: any = this._scene.getObjectByName(element.object_id);
                    (_obj.material as THREE.Material).clippingPlanes = clipPlanes;
                  });

                  //(pane.material as THREE.Material).clippingPlanes = clipPlanes;

                  if (this._config.shadow) {
                    if (this._config.shadow == 'yes') {
                      (pane.material as THREE.Material).clipShadows = true;
                    } else {
                      (pane.material as THREE.Material).clipShadows = false;
                    }
                  }

                  //const planehelper = new THREE.PlaneHelper(coverplane, 200);
                  //this._scene.add(planehelper);

                  this._updatecover(entity, this._states[i], i);
                }
              }
              if (entity.type3d == 'light') {
                // Add Virtual Light Objects
                this._object_ids[i].objects.forEach((element) => {
                  const _foundobject: any = this._scene.getObjectByName(element.object_id);
                  if (_foundobject) {
                    const box: THREE.Box3 = new THREE.Box3();
                    box.setFromObject(_foundobject);

                    let light!: THREE.Light;

                    let x: number, y: number, z: number;

                    x = (box.max.x - box.min.x) / 2 + box.min.x;
                    z = (box.max.z - box.min.z) / 2 + box.min.z;
                    y = (box.max.y - box.min.y) / 2 + box.min.y;

                    if (entity.light.vertical_alignment) {
                      switch (entity.light.vertical_alignment) {
                        case 'top':
                          y = box.max.y;
                          break;
                        case 'middle':
                          y = (box.max.y - box.min.y) / 2 + box.min.y;
                          break;
                        case 'bottom':
                          y = box.min.y;
                          break;
                      }
                    }

                    let decay: number;
                    let distance: number;

                    if (entity.light.decay) {
                      decay = Number(entity.light.decay);
                    } else {
                      decay = 2;
                    }
                    // In r130 (physicallyCorrectLights=false), decay controlled the softness
                    // of a LINEAR falloff curve. In r170 physical mode the same value drives
                    // an INVERSE-SQUARE falloff (1/d^decay), making lights ~10,000× dimmer at
                    // typical model scales. Force decay=0 (constant, no falloff) to restore
                    // the r130 "illuminates the full room" appearance.
                    decay = 0;

                    if (entity.light.distance) {
                      distance = Number(entity.light.distance);
                    } else {
                      distance = 600;
                    }

                    if (entity.light.light_target || entity.light.light_direction) {
                      const angle = entity.light.angle ? THREE.MathUtils.degToRad(entity.light.angle) : Math.PI / 10;

                      const slight: THREE.SpotLight = new THREE.SpotLight(
                        new THREE.Color('#ffffff'),
                        0,
                        distance,
                        angle,
                        0.5,
                        decay,
                      );
                      //this._bboxmodel.add(slight);
                      this._levels[_foundobject.userData.level].add(slight);
                      let target = new THREE.Object3D();
                      //this._bboxmodel.add(target);
                      this._levels[_foundobject.userData.level].add(target);
                      slight.position.set(x, y, z);
                      if (entity.light.light_direction) {
                        target.position.set(
                          x + entity.light.light_direction.x,
                          y + entity.light.light_direction.y,
                          z + entity.light.light_direction.z,
                        );
                      } else {
                        const tobj: THREE.Object3D = this._scene.getObjectByName(entity.light.light_target);

                        if (tobj) {
                          const tbox: THREE.Box3 = new THREE.Box3();
                          tbox.setFromObject(tobj);

                          let tx: number, ty: number, tz: number;

                          tx = (tbox.max.x - tbox.min.x) / 2 + tbox.min.x;
                          tz = (tbox.max.z - tbox.min.z) / 2 + tbox.min.z;
                          ty = (tbox.max.y - tbox.min.y) / 2 + tbox.min.y;

                          target.position.set(tx, ty, tz);
                        }
                      }

                      if (target) {
                        slight.target = target;
                      }

                      light = slight;
                    } else {
                      const plight: THREE.PointLight = new THREE.PointLight(
                        new THREE.Color('#ffffff'),
                        0,
                        distance,
                        decay,
                      );
                      this._levels[_foundobject.userData.level].add(plight);
                      plight.position.set(x, y, z);
                      light = plight;
                    }

                    this._setNoShadowLight(_foundobject);
                    _foundobject.traverseAncestors(this._setNoShadowLight.bind(this));

                    if (entity.light.shadow == 'no') {
                      light.castShadow = false;
                    } else {
                      light.castShadow = true;
                      light.shadow.bias = -0.0001;
                    }
                    light.name = element.object_id + '_light';
                  }
                });
              }
              if (entity.type3d == 'color') {
                // Clone Material to allow object color changes based on Color Conditions Objects
                let j = 0;
                this._object_ids[i].objects.forEach((element) => {
                  let _foundobject: any = this._scene.getObjectByName(element.object_id);
                  this._initialmaterial[i][j] = _foundobject.material;
                  if (!Array.isArray(_foundobject.material)) {
                    this._clonedmaterial[i][j] = _foundobject.material.clone();
                  }
                  j = j + 1;
                });
              }
              if (entity.type3d == 'text') {
                // Clone object to print the text
                this._object_ids[i].objects.forEach((element) => {
                  let _foundobject: any = this._scene.getObjectByName(element.object_id);

                  let box: THREE.Box3 = new THREE.Box3();
                  box.setFromObject(_foundobject);

                  let _newobject = _foundobject.clone();

                  //(_newobject as Mesh).scale.set(1.005, 1.005, 1.005);
                  _newobject.name = 'f3dobj_' + _foundobject.name;
                  //this._bboxmodel.add(_newobject);
                  this._levels[_foundobject.userData.level].add(_newobject);
                });
              }
            }

            // Static opacity — set on matched objects once at load time.
            // Works with any type3d and with wildcard object_ids.
            if (entity.opacity !== undefined) {
              const opVal = Math.min(1, Math.max(0, Number(entity.opacity)));
              const applyMat = (mat: THREE.Material) => {
                mat.transparent = opVal < 1;
                mat.opacity = opVal;
                mat.needsUpdate = true;
              };
              let j = 0;
              this._object_ids[i].objects.forEach((element) => {
                const obj = this._scene.getObjectByName(element.object_id);
                if (obj) {
                  // Apply directly to mesh materials (handles nested groups/children)
                  (obj as THREE.Mesh).traverse((child) => {
                    if (!(child instanceof THREE.Mesh)) return;
                    if (Array.isArray(child.material)) {
                      (child.material as THREE.Material[]).forEach(applyMat);
                    } else if (child.material) {
                      applyMat(child.material as THREE.Material);
                    }
                  });
                  // Also patch cloned materials so type3d:'color' state changes preserve opacity
                  if (this._initialmaterial[i]?.[j]) applyMat(this._initialmaterial[i][j]);
                  if (this._clonedmaterial[i]?.[j])  applyMat(this._clonedmaterial[i][j]);
                }
                j++;
              });
            }
          } catch (error) {
            console.log(error);
            throw new Error('Object issue for Entity: <' + entity.entity + '> ' + error);
          }
        });
        this._config.entities.forEach((entity, i) => {
          if (entity.entity !== '') {
            if (entity.type3d == 'light') {
              this._updatelight(entity, i);
            } else if (entity.type3d == 'color') {
              this._updatecolor(entity, i);
            } else if (entity.type3d == 'hide') {
              this._updatehide(entity, i);
            } else if (entity.type3d == 'show') {
              this._updateshow(entity, i);
            } else if (entity.type3d == 'door') {
              this._updatedoor(entity, i);
            } else if (entity.type3d == 'text') {
              this._canvas[i] = this._createTextCanvas(entity.text, this._text[i], this._unit_of_measurement[i]);
              this._updatetext(entity, this._text[i], this._canvas[i], this._unit_of_measurement[i]);
            } else if (entity.type3d == 'rotate') {
              this._rotatecalc(entity, i);
            } else if (entity.type3d == 'room') {
              this._createroom(entity, i);
              this._updateroom(entity, this._spritetext[i], this._unit_of_measurement[i], i);
            }
          }
        });
      }
      console.log('Add 3D Object End');
    } catch (e) {
      console.log(e);
      throw new Error('Error adding 3D Object: ' + e);
    }
  }

  // manage all entity types

  private _manageZoom(): void {
    if (this._config.zoom_areas) {
      this._config.zoom_areas.forEach((element) => {
        // For each element of the Zoom Area array calculate zoom position and initialize zoom array

        if (element.object_id && element.object_id != '') {
          let _foundobject: any = this._scene.getObjectByName(element.object_id);

          if (_foundobject && _foundobject instanceof THREE.Mesh) {
            const _targetMesh: THREE.Mesh = _foundobject as THREE.Mesh;
            let targetBox = new THREE.Box3().setFromObject(_targetMesh);

            /*this._centerobjecttopivot(_targetMesh, targetBox.min);
            _targetMesh.geometry.applyMatrix4(
              new THREE.Matrix4().makeTranslation(-targetBox.min.x, -targetBox.min.y, -targetBox.min.z),
            );
            targetBox = new THREE.Box3().setFromObject(_targetMesh);
            */

            let targetVector: THREE.Vector3 = new THREE.Vector3();
            targetVector.addVectors(targetBox.min, targetBox.max.sub(targetBox.min).multiplyScalar(0.5));

            let positionVector: THREE.Vector3;
            if (element.direction) {
              positionVector = new THREE.Vector3(element.direction.x, element.direction.y, element.direction.z);
            } else {
              positionVector = new THREE.Vector3(0, 1, 0);
            }
            positionVector.normalize();
            positionVector.multiplyScalar(element.distance ? element.distance : 500);
            positionVector.add(targetVector);

            let rotationVector: THREE.Vector3;
            if (element.rotation) {
              rotationVector = new THREE.Vector3(element.rotation.x, element.rotation.y, element.rotation.z);
            } else {
              rotationVector = new THREE.Vector3(0, 0, 0);
            }

            this._zoom.push({
              name: element.zoom,
              target: targetVector,
              position: positionVector,
              rotation: rotationVector,
              level: element.level,
            });
          }
        }
      });

      render(this._getZoomBar(), this._zoombar);
    }
  }

  private _createroom(entity: Floor3dCardConfig, i: number): void {
    // createroom

    console.log('Create Room');

    const elevation: number = entity.room.elevation ? entity.room.elevation : 250;
    const transparency: number = entity.room.transparency ? entity.room.transparency : 50;
    const color: string = entity.room.color ? entity.room.color : '#ffffff';

    const _foundroom: THREE.Object3D = this._scene.getObjectByName(entity.object_id);

    if (_foundroom) {
      if (_foundroom.name.includes('room') && _foundroom instanceof THREE.Mesh) {
        const _roomMesh: THREE.Mesh = _foundroom as THREE.Mesh;

        if (_roomMesh.geometry instanceof THREE.BufferGeometry) {
          // Work exclusively from the world-space bounding box.  The original
          // implementation re-centered the room mesh pivot and translated its
          // geometry: that mutation is not world-neutral when the mesh carries
          // its own local transform (typical of GLB exports) and, with
          // matrixAutoUpdate frozen after load, visibly shifted the room base.
          // Nothing ever rotates the source mesh, so no pivot change is needed.
          const roomBox = new THREE.Box3().setFromObject(_roomMesh);

          const dimensions = new THREE.Vector3().subVectors(roomBox.max, roomBox.min);
          // Vertical expansion: elevation/2 on both ends, box kept pinned to the floor.
          dimensions.y += elevation;

          const newRoomGeometry: THREE.BoxGeometry = new THREE.BoxGeometry(
            dimensions.x - 4,
            dimensions.y - 4,
            dimensions.z - 4,
          );

          // BoxGeometry is origin-centered: position its center so the box min
          // corner sits at roomBox.min + 2 on each axis (the -4 shrink above
          // leaves a 2-unit inset per side).
          const meshPosition = roomBox.min.clone().addScaledVector(dimensions, 0.5);

          const newRoomMaterial: THREE.MeshPhongMaterial = new THREE.MeshPhongMaterial({
            color: 0xff0000,
            opacity: 0,
            transparent: true,
          });

          newRoomMaterial.depthWrite = false;
          newRoomMaterial.color.set(new THREE.Color(color));
          newRoomMaterial.emissive.set(new THREE.Color(color));
          newRoomMaterial.opacity = (100 - transparency) / 100;

          newRoomMaterial.needsUpdate = true;

          const newRoomMesh: THREE.Mesh = new THREE.Mesh(newRoomGeometry, newRoomMaterial);

          newRoomMesh.name = this._rooms[i];

          const newSprite: THREE.Sprite = new THREE.Sprite();

          newSprite.name = this._sprites[i];

          this._canvas[i] = this._createTextCanvas(entity.room, this._spritetext[i], this._unit_of_measurement[i]);

          const sprite_width: number = entity.room.width ? entity.room.width : 150;
          const sprite_height: number = entity.room.height ? entity.room.height : 75;
          newSprite.scale.set(sprite_width, sprite_height, 5);

          const spritePosition = new THREE.Vector3(
            meshPosition.x,
            roomBox.max.y + elevation + sprite_height / 2,
            meshPosition.z,
          );
          newSprite.visible = false;

          if (entity.room.label) {
            if (entity.room.label == 'yes') {
              newSprite.visible = true;
            }
          }

          this._levels[_roomMesh.userData.level].add(newSprite);
          this._levels[_roomMesh.userData.level].add(newRoomMesh);

          newRoomMesh.position.copy(meshPosition);
          newSprite.position.copy(spritePosition);

          this._updateroomcolor(entity, i);
        }
      }
    }

    return;
  }

  private _updateroom(entity: Floor3dCardConfig, text: string, uom: string, i: number): void {
    //update sprite text and other change conditions

    const _roomMesh: THREE.Object3D = this._scene.getObjectByName(this._rooms[i]);
    const _roomSprite: THREE.Object3D = this._scene.getObjectByName(this._sprites[i]);
    const _roomCanvas: HTMLCanvasElement = this._canvas[i];

    if (_roomMesh && entity) {
      let roomsprite: THREE.Sprite = _roomSprite as THREE.Sprite;

      this._updateTextCanvas(entity.room, _roomCanvas, text + uom);

      this._applyTextCanvasSprite(_roomCanvas, roomsprite);
    }
  }

  private _updatecover(item: Floor3dCardConfig, state: string, i: number): void {
    let pane = this._scene.getObjectByName(item.cover.pane);

    if (this._position[i] == null) {
      if (state == 'open') {
        this._position[i] = 100;
      }
      if (state == 'closed') {
        this._position[i] = 0;
      }
    }

    if (!pane) {
      pane = this._scene.getObjectByName(this._object_ids[i].objects[0].object_id);
    }
    this._translatedoor(pane, this._position[i], item.cover.side, i, state);
    this._renderer.shadowMap.needsUpdate = true;
  }

  private _createTextCanvas(entity: Floor3dCardConfig, text: string, uom: string): HTMLCanvasElement {
    const canvas = document.createElement('canvas');

    this._updateTextCanvas(entity, canvas, text + uom);

    return canvas;
  }

  private _updateTextCanvas(entity: Floor3dCardConfig, canvas: HTMLCanvasElement, text: string): void {
    //Manages the update of the text entities according to their configuration and the new text of the entity state

    const ctx = canvas.getContext('2d');

    // Prepare the font to be able to measure
    let fontSize = 56;
    ctx.font = `${fontSize}px ${entity.font ? entity.font : 'monospace'}`;

    const textMetrics = ctx.measureText(text);

    let width = textMetrics.width;
    let height = fontSize;

    let perct = 1.0;
    if (entity.span) {
      perct = parseFloat(entity.span) / 100.0;
    }
    // Resize canvas to match text size

    width = width / perct;
    height = height / perct;
    canvas.width = width;
    canvas.height = height;
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';

    // Re-apply font since canvas is resized.
    ctx.font = `${fontSize}px ${entity.font ? entity.font : 'monospace'}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    ctx.fillStyle = entity.textbgcolor ? entity.textbgcolor : 'transparent';
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);

    ctx.fillStyle = entity.textfgcolor ? entity.textfgcolor : 'white';

    ctx.fillText(text, width / 2, height / 2);
  }

  private _applyTextCanvas(canvas: HTMLCanvasElement, object: THREE.Object3D) {
    // put the canvas texture with the text on top of the generic object: consider merge with the applyTextCanvasSprite
    const _foundobject: any = object;
    let fileExt = this._config.objfile.split('?')[0].split('.').pop();

    if (_foundobject instanceof THREE.Mesh) {
      const texture = new THREE.CanvasTexture(canvas);
      texture.repeat.set(1, 1);

      if (fileExt == 'glb') {
        texture.flipY = false;
      }
      if (((_foundobject as THREE.Mesh).material as THREE.MeshBasicMaterial).name.startsWith('f3dmat')) {
        ((_foundobject as THREE.Mesh).material as THREE.MeshBasicMaterial).map = texture;
      } else {
        const material = new THREE.MeshBasicMaterial({
          map: texture,
          transparent: true,
        });
        material.name = 'f3dmat' + _foundobject.name;

        (_foundobject as THREE.Mesh).material = material;
      }
    }
  }

  private _applyTextCanvasSprite(canvas: HTMLCanvasElement, object: THREE.Sprite) {
    // put the canvas texture with the text on top of the Sprite object: consider merge with the applyTextCanvas

    const texture = new THREE.CanvasTexture(canvas);
    texture.repeat.set(1, 1);

    if (object.material.name.startsWith('f3dmat')) {
      (object.material as THREE.SpriteMaterial).map = texture;
    } else {
      const material = new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
      });
      material.name = 'f3dmat' + object.name;

      object.material = material;
    }
  }

  private _TemperatureToRGB(t: number): number[] {
    let temp = 10000 / t; //kelvins = 1,000,000/mired (and that /100)
    let r: number, g: number, b: number;
    let rgb: number[] = [0, 0, 0];

    if (temp <= 66) {
      r = 255;
      g = temp;
      g = 99.470802 * Math.log(g) - 161.119568;

      if (temp <= 19) {
        b = 0;
      } else {
        b = temp - 10;
        b = 138.517731 * Math.log(b) - 305.044793;
      }
    } else {
      r = temp - 60;
      r = 329.698727 * Math.pow(r, -0.13320476);

      g = temp - 60;
      g = 288.12217 * Math.pow(g, -0.07551485);

      b = 255;
    }
    rgb = [Math.floor(r), Math.floor(g), Math.floor(b)];
    return rgb;
  }

  private _RGBToHex(r: number, g: number, b: number): string {
    // RGB Color array to hex string converter
    let rs: string = r.toString(16);
    let gs: string = g.toString(16);
    let bs: string = b.toString(16);

    if (rs.length == 1) rs = '0' + rs;
    if (gs.length == 1) gs = '0' + gs;
    if (bs.length == 1) bs = '0' + bs;

    return '#' + rs + gs + bs;
  }

  private _updatetext(entity: Floor3dCardConfig, state: string, canvas: HTMLCanvasElement, uom: string): void {
    const _foundobject: any = this._scene.getObjectByName(entity.object_id);

    if (_foundobject) {
      this._updateTextCanvas(entity.text, canvas, state + uom);
      this._applyTextCanvas(canvas, _foundobject);
    }
  }

  private _updatelight(entity: Floor3dCardConfig, i: number): void {
    // Illuminate the light object when, for the bound device, one of its attribute gets modified in HA. See set hass property

    this._object_ids[i].objects.forEach((element) => {
      const light: any = this._scene.getObjectByName(element.object_id + '_light');

      if (!light) {
        return;
      }
      let max: number;

      if (entity.light.lumens) {
        max = entity.light.lumens;
      } else {
        max = 800;
      }

      if (this._states[i] == 'on') {
        if (this._brightness[i] != -1) {
          light.intensity = 0.003 * max * (this._brightness[i] / 255);
        } else {
          light.intensity = 0.003 * max;
        }
        if (!this._color[i]) {
          if (entity.light.color) {
            light.color = this._colorToThree(entity.light.color);
          } else {
            light.color = new THREE.Color('#ffffff');
          }
        } else {
          light.color = new THREE.Color(this._RGBToHex(this._color[i][0], this._color[i][1], this._color[i][2]));
        }
      } else {
        light.intensity = 0;
        //light.color = new THREE.Color('#000000');
      }
      if (this._config.extralightmode) {
        if (this._config.extralightmode == 'yes') {
          this._manage_light_shadows(entity, light);
        }
      }
      this._renderer.shadowMap.needsUpdate = true;
    });
  }

  private _manage_light_shadows(entity: Floor3dCardConfig, light: THREE.Light): void {
    if (this._config.shadow == 'yes') {
      if (entity.light.shadow == 'yes') {
        if (light.intensity > 0) {
          light.castShadow = true;
        } else {
          light.castShadow = false;
        }
      }
    }
  }

  private _updatedoor(entity: Floor3dCardConfig, i: number): void {
    // perform action on door objects
    // console.log("Update Door Start");

    const _obj: any = this._scene.getObjectByName(this._object_ids[i].objects[0].object_id);

    let door: THREE.Mesh;

    door = _obj;

    if (door) {
      if (entity.door.doortype) {
        if (entity.door.doortype != 'swing' && entity.door.doortype != 'slide') {
          throw new Error('Invalid door type: ' + entity.door.doortype + '. Valid types are: swing, slide');
        }

        if (entity.door.doortype == 'swing') {
          this._rotatedoorpivot(entity, i);
        }
        if (entity.door.doortype == 'slide') {
          // if (entity.door.doortype == 'slide') {
          let pane = this._scene.getObjectByName(entity.door.pane);
          if (!pane) {
            pane = this._scene.getObjectByName(this._object_ids[i].objects[0].object_id);
          }
          let percentage: number;
          if (typeof entity.door.slide_percentage !== 'undefined') {
            percentage = entity.door.slide_percentage;
          } else {
            percentage = entity.door.percentage;
          }
          this._translatedoor(
            pane,
            percentage != null ? percentage : 100,
            entity.door.slide_side || entity.door.side,
            i,
            this._states[i],
          );
        }
      }
    }
    this._renderer.shadowMap.needsUpdate = true;
    // console.log("Update Door End");
  }

  private _centerobjecttopivot(object: THREE.Mesh, pivot: THREE.Vector3) {
    //Center a Mesh  along is defined pivot point

    object.applyMatrix4(new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z));
    object.position.copy(pivot);
    // Model objects have matrixAutoUpdate=false (frozen after load for perf).
    // Without an explicit updateMatrix() the position change above never reaches
    // matrix/matrixWorld, while the caller's geometry translation (-pivot) is
    // applied immediately to the vertices — the mesh visibly shifts by -pivot
    // (e.g. a room base moving when a room entity is configured).
    object.updateMatrix();
  }

  private _rotatedoorpivot(entity: Floor3dCardConfig, index: number) {
    // console.log("Rotate Door Start");

    //For a swing door, rotate the objects along the configured axis and the degrees of opening
    this._object_ids[index].objects.forEach((element) => {
      let _obj: any = this._scene.getObjectByName(element.object_id);

      //this._centerobjecttopivot(_obj, this._pivot[index]);
      const targetRotation: THREE.Vector3 = new THREE.Vector3(0, 0, 0);
      const direction = entity.door.swing_direction || entity.door.direction;

      if (this._states[index] == 'on') {
        if (direction == 'inner') {
          //_obj.rotateOnAxis(this._axis_for_door[index], -Math.PI * this._degrees[index] / 180);
          if (this._axis_for_door[index].y == 1) {
            targetRotation.y = (-Math.PI * this._degrees[index]) / 180;
          } else if (this._axis_for_door[index].x == 1) {
            targetRotation.x = (-Math.PI * this._degrees[index]) / 180;
          } else if (this._axis_for_door[index].z == 1) {
            targetRotation.z = (-Math.PI * this._degrees[index]) / 180;
          }
        } else if (direction == 'outer') {
          //_obj.rotateOnAxis(this._axis_for_door[index], Math.PI * this._degrees[index] / 180);
          if (this._axis_for_door[index].y == 1) {
            targetRotation.y = (Math.PI * this._degrees[index]) / 180;
          } else if (this._axis_for_door[index].x == 1) {
            targetRotation.x = (Math.PI * this._degrees[index]) / 180;
          } else if (this._axis_for_door[index].z == 1) {
            targetRotation.z = (Math.PI * this._degrees[index]) / 180;
          }
        } else {
          throw new Error('Invalid swing direction: ' + direction + '. Valid directions are: inner, outer');
        }
      }

      if (targetRotation.equals(_obj.rotation)) return;

      new TWEEN.Tween(_obj.rotation)
        .to(targetRotation, 1200)
        .easing(TWEEN.Easing.Cubic.InOut)
        .onUpdate(() => {
          // matrixAutoUpdate is frozen; recompute local matrix after each TWEEN step.
          (_obj as THREE.Object3D).updateMatrix();
        })
        .onComplete(() => {
          // Stop animation loop if all tweens finished
          this._startOrStopAnimationLoop();
        })
        .start();
      this._startOrStopAnimationLoop();
    });

    // console.log("Rotate Door End");
  }

  private _translatedoor(pane: THREE.Object3D, percentage: number, side: string, index: number, doorstate: string) {
    // console.log("Translate Door Start");
    //For a slide door, translate the objects according to the configured directions and percentage of opening

    let translate: THREE.Vector3 = new THREE.Vector3(0, 0, 0);

    let size: THREE.Vector3 = new THREE.Vector3();
    let center: THREE.Vector3 = new THREE.Vector3();

    //TBD let pane = this._scene.getObjectByName(item.door.pane);

    let bbox = new THREE.Box3().setFromObject(pane);

    size.subVectors(bbox.max, bbox.min);

    if (doorstate == 'on' || doorstate == 'open') {
      if (side == 'left') {
        if (size.x > size.z) {
          translate.z += 0;
          translate.x += (-size.x * percentage) / 100;
          translate.y = 0;
        } else {
          translate.z += (-size.z * percentage) / 100;
          translate.x += 0;
          translate.y += 0;
        }
      } else if (side == 'right') {
        if (size.x > size.z) {
          translate.z += 0;
          translate.x += (+size.x * percentage) / 100;
          translate.y += 0;
        } else {
          translate.z += (+size.z * percentage) / 100;
          translate.x += 0;
          translate.y += 0;
        }
      } else if (side == 'down') {
        translate.y += (-size.y * percentage) / 100;
        translate.x += 0;
        translate.z += 0;
      } else if (side == 'up') {
        translate.y += (+size.y * percentage) / 100;
        translate.x += 0;
        translate.z += 0;
      } else {
        throw new Error('Invalid side: ' + side + '. Valid sides are: up, down, left, right');
      }
    }

    this._object_ids[index].objects.forEach((element, i) => {
      let _obj: any = this._scene.getObjectByName(element.object_id);
      const originalPosition = this._slidingdoorposition[index][i];

      let targetPosition: THREE.Vector3 = new THREE.Vector3(
        originalPosition.x + translate.x,
        originalPosition.y + translate.y,
        originalPosition.z + translate.z,
      );

      if (targetPosition.equals(_obj.position)) return;

      new TWEEN.Tween(_obj.position)
        .to(targetPosition, 1200)
        .easing(TWEEN.Easing.Cubic.InOut)
        .onUpdate(() => {
          // matrixAutoUpdate is frozen; recompute local matrix after each TWEEN step.
          (_obj as THREE.Object3D).updateMatrix();
        })
        .onComplete(() => {
          // Stop animation loop if all tweens finished
          this._startOrStopAnimationLoop();
        })
        .start();
    });

    this._startOrStopAnimationLoop();
    // console.log("Translate Door End");
  }

  private _updateroomcolor(item: any, index: number): void {
    // Change the color of the room when, for the bound entity, when the state matches the condition

    let _room: any = this._scene.getObjectByName(this._rooms[index]);

    const color: string = item.room.color ? item.room.color : '#ffffff';

    if (_room && _room instanceof THREE.Mesh) {
      let i: any;
      let defaultcolor = true;

      const _object: any = _room;

      for (i in item.colorcondition) {
        if (this._states[index] == item.colorcondition[i].state) {
          const colorcond: THREE.Color = this._colorToThree(item.colorcondition[i].color);
          _object.material.color.set(colorcond);
          _object.material.emissive.set(colorcond);
          defaultcolor = false;
          break;
        }
      }
      if (defaultcolor) {
        _object.material.color.set(color);
        _object.material.emissive.set(color);
      }
    }
  }

  private _updatecolor(item: any, index: number): void {
    // Change the color of the object when, for the bound device, the state matches the condition

    let j = 0;
    this._object_ids[index].objects.forEach((element) => {
      let _object: any = this._scene.getObjectByName(element.object_id);

      if (_object) {
        let i: any;
        let defaultcolor = true;
        for (i in item.colorcondition) {
          if (this._states[index] == item.colorcondition[i].state) {
            const colorarray = item.colorcondition[i].color.split(',');
            let color = '';
            if (colorarray.length == 3) {
              color = this._RGBToHex(Number(colorarray[0]), Number(colorarray[1]), Number(colorarray[2]));
            } else {
              color = item.colorcondition[i].color;
            }
            if (!Array.isArray(_object.material)) {
              _object.material = this._clonedmaterial[index][j];
              _object.material.color.set(color);
            }
            defaultcolor = false;
            break;
          }
        }
        if (defaultcolor) {
          if (this._initialmaterial[index][j]) {
            _object.material = this._initialmaterial[index][j];
          }
        }
      }
      j += 1;
    });
  }

  private _updatehide(entity: Floor3dCardConfig, index: number): void {
    // hide the object when the state is equal to the configured value
    this._object_ids[index].objects.forEach((element) => {
      //object clickable: check layers solution
      const _object: any = this._scene.getObjectByName(element.object_id);

      if (_object) {
        if (this._states[index] == entity.hide.state) {
          //TODO: Layers to hide ?
          _object.visible = false;
        } else {
          _object.visible = true;
        }
      }
    });
    this._renderer.shadowMap.needsUpdate = true;
  }

  private _updateshow(entity: Floor3dCardConfig, index: number): void {
    // hide the object when the state is equal to the configured value
    this._object_ids[index].objects.forEach((element) => {
      const _object: any = this._scene.getObjectByName(element.object_id);

      if (_object) {
        if (this._states[index] == entity.show.state) {
          _object.visible = true;
        } else {
          //TODO: Layers to hide ?
          _object.visible = false;
        }
      }
    });
    this._renderer.shadowMap.needsUpdate = true;
  }

  // end of manage entity types

  // https://lit-element.polymer-project.org/guide/lifecycle#shouldupdate
  protected shouldUpdate(_changedProps: PropertyValues): boolean {
    return true;
    //return hasConfigOrEntityChanged(this, _changedProps, false);
  }

  private _rotatecalc(entity: Floor3dCardConfig, i: number) {
    let j = this._rotation_index.indexOf(i);

    //1 if the entity is on, 0 if the entity is off
    this._rotation_state[j] = this._states[i] == 'on' ? 1 : 0;

    //If the entity is on and it has the 'percentage' attribute, convert the percentage integer
    //into a decimal and store it as the rotation state
    if (this._rotation_state[j] != 0 && this._hass.states[entity.entity].attributes['percentage']) {
      this._rotation_state[j] = this._hass.states[entity.entity].attributes['percentage'] / 100;
    }

    //If the entity is on and it is reversed, set the rotation state to the negative value of itself
    if (
      this._rotation_state[j] != 0 &&
      this._hass.states[entity.entity].attributes['direction'] &&
      this._hass.states[entity.entity].attributes['direction'] == 'reverse'
    ) {
      this._rotation_state[j] = 0 - this._rotation_state[j];
    }

    this._startOrStopAnimationLoop();
  }

  private _needsAnimationLoop() {
    // Check rotations, Tween, active weather / lightning / wind / clouds, and animation particles
    const weatherRunning = this._weatherAnimationsEnabled && (
      !!this._weatherSystem || !!this._lightningLight || !!this._windSystem || !!this._cloudSystem
    );
    // Mirror the weather guard: don't drive the loop for particles when the
    // animations toggle is off, even if sys.active is somehow still true.
    const particlesRunning = this._animationsEnabled &&
      [...this._animParticleSystems.values()].some(s => s.active);
    return this._rotation_state.some((item) => item !== 0) ||
           TWEEN.getAll().length > 0 ||
           weatherRunning ||
           particlesRunning;
  }

  // If every rotating entity and Tween is stopped, disable animation
  private _startOrStopAnimationLoop() {
    if (this._needsAnimationLoop()) {
      if (this._to_animate) return;
      this._to_animate = true;
      if (!this._clock) this._clock = new THREE.Clock();
      this._renderer.setAnimationLoop(() => this._animationLoop());
    } else {
      this._to_animate = false;
      // Do NOT null the clock — weather particles need it if they start later
      this._renderer.setAnimationLoop(null);
    }
  }

  private _animationLoop() {
    // FPS cap: bail out early when running faster than the configured target.
    // setAnimationLoop fires at vsync (~60fps); we only do GPU work at target_fps.
    const now = performance.now();
    const targetMs = 1000 / Math.min(60, Math.max(5, this._config?.target_fps ?? 30));
    if (now - this._lastFrameTime < targetMs) return;
    this._lastFrameTime = now;

    if (!this._clock) this._clock = new THREE.Clock();
    // Cap delta to prevent particle/rotation jumps after tab-blur or FPS catch-up.
    const clockDelta = Math.min(this._clock.getDelta(), 0.1);
    let rotateBy = clockDelta * Math.PI * 2;

    this._rotation_state.forEach((state, index) => {
      if (state == 0) return;

      this._object_ids[this._rotation_index[index]].objects.forEach((element) => {
        let _obj = this._scene.getObjectByName(element.object_id);
        if (_obj) {
          switch (this._axis_to_rotate[index]) {
            case 'x':
              _obj.rotation.x += this._round_per_seconds[index] * this._rotation_state[index] * rotateBy;
              break;
            case 'y':
              _obj.rotation.y += this._round_per_seconds[index] * this._rotation_state[index] * rotateBy;
              break;
            case 'z':
              _obj.rotation.z += this._round_per_seconds[index] * this._rotation_state[index] * rotateBy;
              break;
          }
          // matrixAutoUpdate is frozen on loaded objects; recompute local matrix manually.
          _obj.updateMatrix();
        }
      });
    });

    TWEEN.update();

    // --- Weather particle animation ---
    if (this._weatherSystem) {
      const ws = this._weatherSystem;
      const pos = ws.mesh.geometry.attributes['position'].array as Float32Array;
      const dt = clockDelta;

      if (ws.type === 'rain') {
        // LineSegments: each pair of vertices (top, bottom) falls together
        for (let i = 0; i < ws.velArray.length; i++) {
          const dy = ws.velArray[i] * dt;
          pos[i * 6 + 1] -= dy;
          pos[i * 6 + 4] -= dy;
          if (pos[i * 6 + 4] < 0) {
            const x = (Math.random() - 0.5) * ws.spread * 2;
            const z = (Math.random() - 0.5) * ws.spread * 2;
            pos[i * 6]     = x; pos[i * 6 + 1] = ws.maxY + ws.segLen; pos[i * 6 + 2] = z;
            pos[i * 6 + 3] = x; pos[i * 6 + 4] = ws.maxY;             pos[i * 6 + 5] = z;
          }
        }
      } else if (ws.type === 'snow' || ws.type === 'hail') {
        // Points: [vx, vy, vz] triplets
        const n = ws.velArray.length / 3;
        for (let i = 0; i < n; i++) {
          pos[i*3]   += ws.velArray[i*3]   * dt;
          pos[i*3+1] += ws.velArray[i*3+1] * dt;
          pos[i*3+2] += ws.velArray[i*3+2] * dt;
          if (pos[i*3+1] < 0) {
            pos[i*3]   = (Math.random() - 0.5) * ws.spread * 2;
            pos[i*3+1] = ws.maxY;
            pos[i*3+2] = (Math.random() - 0.5) * ws.spread * 2;
          }
        }
      } else if (ws.type === 'sand' || ws.type === 'wind') {
        // Points: horizontal movement; wrap in X
        const n = ws.velArray.length / 3;
        for (let i = 0; i < n; i++) {
          pos[i*3]   += ws.velArray[i*3]   * dt;
          pos[i*3+1] += ws.velArray[i*3+1] * dt;
          pos[i*3+2] += ws.velArray[i*3+2] * dt;
          // Wrap in X when particle exits spread volume
          if (pos[i*3] > ws.spread) {
            pos[i*3] = -ws.spread + Math.random() * ws.spread * 0.2;
            pos[i*3+1] = Math.random() * (ws.type === 'wind' ? ws.maxY * 0.6 : ws.maxY);
            pos[i*3+2] = (Math.random() - 0.5) * ws.spread * 2;
          }
        }
      }

      ws.mesh.geometry.attributes['position'].needsUpdate = true;
      // frustumCulled = false on this mesh — no bounding sphere recomputation needed.
    }

    // --- Wind streak animation ---
    if (this._windSystem) {
      const ws  = this._windSystem;
      const pos = ws.mesh.geometry.attributes['position'].array as Float32Array;
      const dt  = clockDelta;
      // Across-wind perpendicular direction (for wrapping respawn)
      const perpX = -ws.windDir.z;
      const perpZ =  ws.windDir.x;

      for (let i = 0; i < ws.count; i++) {
        const v  = ws.baseSpeed * ws.speeds[i] * dt;
        const dx = ws.windDir.x * v;
        const dz = ws.windDir.z * v;

        // Move start (tail) point
        pos[i*6]   += dx;
        pos[i*6+2] += dz;

        // Wrap: check if head has passed the downwind boundary
        const projHead = (pos[i*6] + ws.windDir.x * ws.segLengths[i]) * ws.windDir.x
                       + (pos[i*6+2] + ws.windDir.z * ws.segLengths[i]) * ws.windDir.z;
        if (projHead > ws.spread) {
          // Teleport tail to the upwind side, random lateral offset
          const newAlong  = -(ws.spread * (0.5 + Math.random() * 0.5));
          const newAcross = (Math.random() - 0.5) * ws.spread * 2;
          pos[i*6]   = ws.windDir.x * newAlong + perpX * newAcross;
          pos[i*6+1] = Math.random() * ws.maxY;
          pos[i*6+2] = ws.windDir.z * newAlong + perpZ * newAcross;
        }

        // Recompute head from current tail position
        const slen = ws.segLengths[i];
        pos[i*6+3] = pos[i*6]   + ws.windDir.x * slen;
        pos[i*6+4] = pos[i*6+1]; // horizontal streak — same Y
        pos[i*6+5] = pos[i*6+2] + ws.windDir.z * slen;
      }

      ws.mesh.geometry.attributes['position'].needsUpdate = true;
      // frustumCulled = false on this mesh — no bounding sphere recomputation needed.
    }

    // --- Lightning flash ---
    if (this._lightningLight) {
      this._lightningTimer -= clockDelta;
      if (this._lightningTimer <= 0) {
        if (this._lightningPhase === 0) {
          // First flash
          this._lightningLight.intensity = 3 + Math.random() * 2;
          this._lightningTimer = 0.05 + Math.random() * 0.05;
          this._lightningPhase = 1;
        } else if (this._lightningPhase === 1) {
          // Brief off
          this._lightningLight.intensity = 0;
          this._lightningTimer = 0.04 + Math.random() * 0.04;
          this._lightningPhase = 2;
        } else if (this._lightningPhase === 2) {
          // Second flash (optional)
          if (Math.random() > 0.4) {
            this._lightningLight.intensity = 2 + Math.random() * 2;
            this._lightningTimer = 0.05 + Math.random() * 0.04;
            this._lightningPhase = 3;
          } else {
            this._lightningLight.intensity = 0;
            this._lightningTimer = 4 + Math.random() * 6;
            this._lightningPhase = 0;
          }
        } else {
          // Cooldown
          this._lightningLight.intensity = 0;
          this._lightningTimer = 4 + Math.random() * 6;
          this._lightningPhase = 0;
        }
      }
    }

    // --- Cloud puff drift ---
    if (this._cloudSystem) {
      const cs = this._cloudSystem;
      const dt = clockDelta;
      for (const c of cs.clouds) {
        c.mesh.position.x += c.vel.x * dt;
        c.mesh.position.z += c.vel.z * dt;
        // Wrap: when a cloud drifts past the spread radius, loop it back
        const d2 = c.mesh.position.x * c.mesh.position.x + c.mesh.position.z * c.mesh.position.z;
        if (d2 > cs.spread * cs.spread) {
          // Teleport to the opposite side with a bit of jitter
          const backAngle = Math.atan2(c.mesh.position.z, c.mesh.position.x) + Math.PI;
          const r = cs.spread * (0.25 + Math.random() * 0.45);
          const jitter = (Math.random() - 0.5) * 0.7;
          c.mesh.position.x = Math.cos(backAngle + jitter) * r;
          c.mesh.position.z = Math.sin(backAngle + jitter) * r;
        }
      }
    }

    // --- 3-D animation particle systems (music notes + AC flow) ---
    if (this._animParticleSystems.size > 0) {
      const dt = clockDelta;

      for (const sys of this._animParticleSystems.values()) {
        if (!sys.active) continue;

        if (sys.type === 'music_notes' && sys.sprites && sys.spriteMats && sys.phases) {
          const speed      = sys.noteSpeed!;   // stored at init (0.28 × note_speed multiplier)
          const travelDist = sys.travelDist!;
          const noteScale  = sys.noteScale!;
          const origin     = sys.origin;
          const count      = sys.sprites.length;

          for (let i = 0; i < count; i++) {
            sys.phases[i] += dt * speed;
            if (sys.phases[i] > 1) sys.phases[i] -= 1;

            const p  = sys.phases[i];
            const op = Math.sin(p * Math.PI);   // 0→1→0 fade

            const sprite = sys.sprites[i];
            // Avoid matrix recalculation + render cost when sprite is fully transparent.
            if (op < 0.01) {
              sprite.visible = false;
              continue;
            }
            sprite.visible = true;
            const y      = origin.y + p * travelDist;
            const xDrift = sys.drifts![i] * Math.sin(p * Math.PI * 1.5);
            const scl    = noteScale * (0.55 + op * 0.55);
            sprite.position.set(origin.x + xDrift, y, origin.z);
            sprite.scale.set(scl, scl, scl);
            sys.spriteMats[i].opacity = op * 0.92;
          }

        } else if (sys.type === 'ac_flow' && sys.mesh && sys.acPhases) {
          const speed  = 0.42;   // ~2.4 s per streak cycle
          const origin = sys.origin;
          const count  = sys.count!;
          const maxLen = sys.maxLen!;
          const sdx    = sys.sdx!; const sdy = sys.sdy!; const sdz = sys.sdz!;
          const pos    = sys.mesh.geometry.attributes['position'].array as Float32Array;

          for (let i = 0; i < count; i++) {
            sys.acPhases[i] += dt * speed;
            if (sys.acPhases[i] > 1) sys.acPhases[i] -= 1;

            const p  = sys.acPhases[i];
            const p0 = Math.max(0, p - 0.3);   // tail lags head by 0.3 phase

            // Each streak travels along its own pre-computed flat-arc direction
            pos[i*6]   = origin.x + sdx[i] * p0 * maxLen;
            pos[i*6+1] = origin.y + sdy[i] * p0 * maxLen;
            pos[i*6+2] = origin.z + sdz[i] * p0 * maxLen;

            pos[i*6+3] = origin.x + sdx[i] * p * maxLen;
            pos[i*6+4] = origin.y + sdy[i] * p * maxLen;
            pos[i*6+5] = origin.z + sdz[i] * p * maxLen;
          }

          sys.mesh.geometry.attributes['position'].needsUpdate = true;
          // frustumCulled = false on this mesh — no bounding sphere recomputation needed.
        }
      }
    }

    this._renderer.render(this._scene, this._camera);
    this._updateOverlayPositions();
  }

  // https://lit-element.polymer-project.org/guide/templates

  protected render(): TemplateResult | void {
    if (!this._config) return html``;
    if (this._config.show_error) {
      return this._showError(localize('common.show_error'));
    }

    return html`
      <ha-card
        tabindex="0"
        .style=${`${
          this._config.style || 'overflow: hidden; width: auto; position: relative; padding: 0;'
        }`}
        id="${this._card_id}"
      >
      </ha-card>
    `;
  }

  private _handleAction(ev: ActionHandlerEvent): void {
    //not implemented to not interfere with  the Action handler of the Three.js canvas object
    if (this.hass && this._config && ev.detail.action) {
      handleAction(this, this.hass, this._config, ev.detail.action);
    }
  }

  private _showWarning(warning: string): TemplateResult {
    return html`<hui-warning>${warning}</hui-warning>`;
  }

  private _showError(error: string): TemplateResult {
    const errorCard = document.createElement('hui-error-card');
    errorCard.setConfig({
      type: 'error',
      error,
      origConfig: this._config,
    });

    return html`${errorCard}`;
  }

  // ---------------------------------------------------------------------------
  // Object ID discovery helpers (edit mode)
  // ---------------------------------------------------------------------------

  /**
   * Returns all named object IDs present in the loaded 3D scene.
   * Called by the editor to populate autocomplete for anchor fields.
   */
  public getObjectIds(): string[] {
    if (!this._scene) return [];
    const ids = new Set<string>();
    this._scene.traverse((obj) => {
      if (obj.name && obj.name.trim() !== '') ids.add(obj.name);
    });
    return Array.from(ids).sort();
  }

  /** Show a brief toast notification over the card (replaces window.prompt for object/camera data). */
  private _showToast(message: string, detail?: string): void {
    const existing = this._card?.querySelector('.floor3d-toast') as HTMLElement;
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'floor3d-toast';
    toast.style.cssText = [
      'position:absolute;bottom:16px;left:50%;transform:translateX(-50%)',
      'background:rgba(30,30,30,0.92);color:#fff;padding:10px 18px',
      'border-radius:8px;font-size:13px;z-index:9999;pointer-events:none',
      'max-width:90%;word-break:break-all;text-align:center',
      'box-shadow:0 4px 12px rgba(0,0,0,0.4)',
    ].join(';');

    toast.innerHTML = `<strong>${message}</strong>${detail ? `<br><code style="font-size:11px;opacity:0.85">${detail}</code>` : ''}`;
    (this._card || document.body).appendChild(toast);

    // Fade out
    setTimeout(() => {
      toast.style.transition = 'opacity 0.4s';
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 450);
    }, 2500);
  }

  private _discoverTouchStart(e: TouchEvent): void {
    if (!this._modelready) return;
    const t = e.touches[0];
    this._discoverTouchOrigin = { x: t.clientX, y: t.clientY, e };
    this._discoverLongPressTimeout = setTimeout(() => {
      // Save origin before cancel (cancel sets _discoverTouchOrigin to null)
      const origin = this._discoverTouchOrigin;
      this._discoverTouchCancel();
      if (!origin) return;
      this._discoverObjectAtTouch(origin.x, origin.y);
    }, 700);
  }

  private _discoverTouchCancel(ev?: TouchEvent): void {
    if (ev && this._discoverTouchOrigin) {
      // Cancel only if finger moved more than 12px (ignore micro-vibrations)
      const t = ev.touches[0] || ev.changedTouches[0];
      if (t) {
        const dx = t.clientX - this._discoverTouchOrigin.x;
        const dy = t.clientY - this._discoverTouchOrigin.y;
        if (dx * dx + dy * dy < 144) return; // 12px threshold
      }
    }
    if (this._discoverLongPressTimeout) {
      clearTimeout(this._discoverLongPressTimeout);
      this._discoverLongPressTimeout = null;
    }
    this._discoverTouchOrigin = null;
  }

  private _discoverObjectAtTouch(clientX: number, clientY: number): void {
    // Convert clientX/Y to offsetX/Y relative to the canvas container
    const rect = this._content.getBoundingClientRect();
    const fakeEvent = { offsetX: clientX - rect.left, offsetY: clientY - rect.top };
    const intersects = this._getintersect(fakeEvent);
    if (intersects.length > 0 && intersects[0].object.name) {
      const name = intersects[0].object.name;
      this._copyToClipboardAndToast(name, 'Object ID');
    } else {
      // Show camera data on long-press on empty space
      const cam = this._camera;
      const tgt = this._controls.target;
      const yaml =
        `camera_position: { x: ${cam.position.x.toFixed(3)}, y: ${cam.position.y.toFixed(3)}, z: ${cam.position.z.toFixed(3)} }\n` +
        `camera_rotate: { x: ${cam.rotation.x.toFixed(4)}, y: ${cam.rotation.y.toFixed(4)}, z: ${cam.rotation.z.toFixed(4)} }\n` +
        `camera_target: { x: ${tgt.x.toFixed(3)}, y: ${tgt.y.toFixed(3)}, z: ${tgt.z.toFixed(3)} }`;
      this._copyToClipboardAndToast(yaml, 'Camera YAML');
    }
  }

  private _copyToClipboardAndToast(text: string, label: string): void {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(
        () => this._showToast(`${label} copied`, text),
        () => this._showToast(label, text),
      );
    } else {
      this._showToast(label, text);
    }
  }

  // ---------------------------------------------------------------------------
  // Marker / Room-Control Overlay System
  // ---------------------------------------------------------------------------

  /**
   * Create the transparent overlay div that sits on top of the Three.js canvas.
   * Markers and room controls are rendered as HTML elements inside this overlay.
   */
  private _initMarkerOverlay(): void {
    if (!this._content) return;
    if (this._markerOverlay) {
      this._markerOverlay.remove();
    }

    this._markerOverlay = document.createElement('div');
    this._markerOverlay.style.cssText =
      'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;overflow:hidden;';
    this._content.style.position = 'relative';
    this._content.appendChild(this._markerOverlay);

    this._markerElements.clear();
    this._roomControlElements.clear();
    this._animationElements.clear();

    // Inject CSS keyframes for room animations (music notes, AC snowflakes)
    const style = document.createElement('style');
    style.textContent = `
      @keyframes f3d-note-float {
        0%   { opacity: 0; transform: translateY(0) rotate(-10deg) scale(0.9); }
        15%  { opacity: 1; }
        85%  { opacity: 1; transform: translateY(-48px) rotate(8deg) scale(1.05); }
        100% { opacity: 0; transform: translateY(-62px) rotate(14deg) scale(0.9); }
      }
      @keyframes f3d-flake-float {
        0%   { opacity: 0; transform: translateY(0)    rotate(0deg)   scale(0.8); }
        15%  { opacity: 1; }
        85%  { opacity: 1; transform: translateY(-44px) rotate(120deg) scale(1.05); }
        100% { opacity: 0; transform: translateY(-58px) rotate(180deg) scale(0.9); }
      }
      @keyframes f3d-zzz {
        0%   { opacity: 0; transform: translate(0, 0)    scale(0.7); }
        20%  { opacity: 1; }
        80%  { opacity: 0.9; }
        100% { opacity: 0; transform: translate(6px, -18px) scale(1.1); }
      }
    `;
    this._markerOverlay.appendChild(style);

    // Apply weather sky uniforms + spawn 3D particles if configured
    if (this._config.weather_entity && this._hass) {
      const ws = this._hass.states[this._config.weather_entity];
      if (ws) {
        this._updateWeatherSky(ws.state);
        if (this._weatherAnimationsEnabled) {
          this._createWeatherParticles(ws.state);
          this._initClouds(ws.state);
          this._updateWindStreaks(
            Number(ws.attributes?.['wind_speed']   ?? 0),
            Number(ws.attributes?.['wind_bearing'] ?? 270),
          );
        }
      }
    }

    // Render weather + animations toggle buttons
    if (this._weatherbar)    render(this._getWeatherBar(),    this._weatherbar);
    if (this._animationsbar) render(this._getAnimationsBar(), this._animationsbar);

    // Build marker elements
    if (this._config.markers) {
      for (const marker of this._config.markers) {
        const el = this._createMarkerElement(marker);
        this._markerOverlay.appendChild(el);
        this._markerElements.set(marker.id, el);
      }
    }

    // Build room control elements
    if (this._config.room_controls) {
      for (const control of this._config.room_controls) {
        const el = this._createRoomControlElement(control);
        this._markerOverlay.appendChild(el);
        this._roomControlElements.set(control.id, el);
      }
    }

    // Build animation elements.
    // music_notes and ac_flow are handled as 3D particle systems (_animParticleSystems).
    // Any other (future) types still get an HTML overlay element.
    if (this._config.animations) {
      for (const anim of this._config.animations) {
        if (anim.type === 'music_notes' || anim.type === 'ac_flow') continue;
        const el = this._createAnimationElement(anim);
        this._markerOverlay.appendChild(el);
        this._animationElements.set(anim.id, el);
      }
    }

    // Initialise 3-D particle systems for music_notes / ac_flow animations
    this._initAnimParticleSystems();
  }

  /**
   * Create the HTML element for a single marker.
   */
  private _createMarkerElement(marker: MarkerConfig): HTMLElement {
    const size = marker.size || 48;
    const wrapper = document.createElement('div');
    wrapper.style.cssText = `position:absolute;width:${size}px;height:${size}px;transform:translate(-50%,-50%);display:none;pointer-events:auto;cursor:pointer;`;
    wrapper.dataset.markerId = marker.id;

    // Inner content depending on marker type
    if (marker.type === 'person' || (marker.type === 'avatar' && marker.image)) {
      const img = document.createElement('img');
      img.src = marker.type === 'person' ? '' : marker.image;
      img.dataset.personEntity = marker.type === 'person' ? marker.entity : '';
      img.style.cssText = `width:${size}px;height:${size}px;border-radius:50%;object-fit:cover;border:2px solid ${marker.color || 'white'};box-shadow:0 2px 8px rgba(0,0,0,0.5);`;
      img.alt = marker.label || marker.id;
      wrapper.appendChild(img);
    } else if (marker.type === 'icon') {
      const icon = document.createElement('ha-icon');
      (icon as any).icon = marker.icon || 'mdi:account';
      icon.style.cssText = `width:${size}px;height:${size}px;color:${marker.color || 'white'};filter:drop-shadow(0 2px 4px rgba(0,0,0,0.5));`;
      wrapper.appendChild(icon);
    } else if (marker.type === 'dot') {
      const dot = document.createElement('div');
      dot.style.cssText = `width:${size}px;height:${size}px;border-radius:50%;background:${marker.color || '#4caf50'};border:2px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.5);`;
      wrapper.appendChild(dot);
    } else {
      // badge — icon + optional label pill
      const badge = document.createElement('div');
      badge.style.cssText = `display:flex;flex-direction:column;align-items:center;gap:2px;`;
      const icon = document.createElement('ha-icon');
      (icon as any).icon = marker.icon || 'mdi:account';
      icon.style.cssText = `width:${size}px;height:${size}px;color:${marker.color || 'white'};filter:drop-shadow(0 2px 4px rgba(0,0,0,0.5));`;
      badge.appendChild(icon);
      if (marker.label) {
        const lbl = document.createElement('div');
        lbl.textContent = marker.label;
        lbl.style.cssText =
          'background:rgba(0,0,0,0.65);color:white;font-size:11px;padding:1px 5px;border-radius:8px;white-space:nowrap;';
        badge.appendChild(lbl);
      }
      wrapper.appendChild(badge);
    }

    // Tooltip
    if (marker.label) {
      wrapper.title = marker.label;
    }

    // Sleep / Zzz overlay — three staggered Z characters that float upward.
    // Hidden by default; shown by _updateMarkersAndControls when sleep_entity is active.
    if (marker.sleep_entity) {
      const size = marker.size || 48;
      const zzz = document.createElement('div');
      zzz.dataset.zzzOverlay = 'true';
      // Cover the full wrapper so Z spans are positioned relative to the avatar's
      // top-left corner, not the wrapper's right edge.
      zzz.style.cssText =
        'position:absolute;top:0;left:0;width:100%;height:100%;display:none;pointer-events:none;overflow:visible;';
      // Three Z spans: small → medium → large, staggered in position and delay.
      // left/top are percentages of marker size so they scale with different sizes.
      const zDefs = [
        { fontSize: size * 0.19, left: size * 0.62, top: -size * 0.06, delay: '0s' },
        { fontSize: size * 0.23, left: size * 0.68, top: -size * 0.22, delay: '0.55s' },
        { fontSize: size * 0.28, left: size * 0.74, top: -size * 0.40, delay: '1.1s' },
      ];
      for (const d of zDefs) {
        const z = document.createElement('span');
        z.textContent = 'Z';
        z.style.cssText = [
          'position:absolute',
          `font-size:${Math.round(d.fontSize)}px`,
          'font-weight:bold',
          'color:rgba(180,220,255,0.95)',
          'text-shadow:0 1px 3px rgba(0,0,0,0.6)',
          `left:${d.left.toFixed(1)}px`,
          `top:${d.top.toFixed(1)}px`,
          `animation:f3d-zzz 2.4s ease-in-out ${d.delay} infinite`,
        ].join(';');
        zzz.appendChild(z);
      }
      wrapper.appendChild(zzz);
    }

    // Click action
    const action = marker.action || 'more-info';
    if (action === 'more-info') {
      wrapper.addEventListener('click', () => {
        if (this._hass) {
          fireEvent(this, 'hass-more-info', { entityId: marker.entity });
        }
      });
    }

    return wrapper;
  }

  /**
   * Create the HTML element for a single room control.
   */
  private _createRoomControlElement(control: RoomControlConfig): HTMLElement {
    const size = control.size || 40;
    const wrapper = document.createElement('div');
    wrapper.style.cssText = `position:absolute;width:${size}px;height:${size}px;transform:translate(-50%,-50%);display:none;pointer-events:auto;cursor:pointer;`;
    wrapper.dataset.controlId = control.id;

    const inner = document.createElement('div');
    inner.style.cssText = `width:${size}px;height:${size}px;border-radius:50%;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(0,0,0,0.4);border:1px solid rgba(255,255,255,0.15);transition:border-color 0.2s;`;

    if (control.icon) {
      const icon = document.createElement('ha-icon');
      (icon as any).icon = control.icon;
      // start with the off color; _updateMarkersAndControls will correct it on first hass update
      icon.style.cssText = `width:${size * 0.6}px;height:${size * 0.6}px;color:${control.color_off || 'rgba(255,255,255,0.35)'};transition:color 0.2s;`;
      inner.appendChild(icon);
    }

    if (control.label) {
      wrapper.title = control.label;
    }

    wrapper.appendChild(inner);

    // Click action
    wrapper.addEventListener('click', () => {
      if (!this._hass) return;
      switch (control.control_type) {
        case 'toggle':
          this._hass.callService(control.entity.split('.')[0], 'toggle', { entity_id: control.entity });
          break;
        case 'more-info':
          fireEvent(this, 'hass-more-info', { entityId: control.entity });
          break;
        case 'service-call':
          if (control.service) {
            const [domain, service] = control.service.split('.');
            this._hass.callService(domain, service, { entity_id: control.entity, ...(control.service_data || {}) });
          }
          break;
        case 'media-toggle':
          this._hass.callService('media_player', 'media_play_pause', { entity_id: control.entity });
          break;
        default:
          fireEvent(this, 'hass-more-info', { entityId: control.entity });
      }
    });

    return wrapper;
  }

  // ---------------------------------------------------------------------------
  // 3-D particle / sprite animation helpers
  // ---------------------------------------------------------------------------

  /**
   * Build a canvas texture containing a single musical note symbol.
   * The texture is always white so we can tint it via SpriteMaterial.color.
   */
  private _buildNoteTexture(symbol: string): THREE.Texture {
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${size * 0.72}px serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0,0,0,0.4)';
    ctx.shadowBlur = 6;
    ctx.fillText(symbol, size / 2, size * 0.54);
    return new THREE.CanvasTexture(canvas);
  }

  /**
   * Convert a single direction keyword to a normalized THREE.Vector3 for AC flow.
   * Keywords: 'down' (default), 'up', 'north', 'south', 'east', 'west', 'bottom' (alias for down).
   */
  private _acFlowDirSingle(direction: string): THREE.Vector3 {
    const cfg = this._config;
    const nx = cfg?.north?.x ?? 0;
    const nz = cfg?.north?.z ?? -1;
    const ex = nz; const ez = -nx;   // east = 90° CW from north in XZ plane
    switch (direction.trim().toLowerCase()) {
      case 'up':                return new THREE.Vector3(0, 1, 0);
      case 'north':             return new THREE.Vector3(nx, 0, nz).normalize();
      case 'south':             return new THREE.Vector3(-nx, 0, -nz).normalize();
      case 'east':              return new THREE.Vector3(ex, 0, ez).normalize();
      case 'west':              return new THREE.Vector3(-ex, 0, -ez).normalize();
      case 'down': case 'bottom':
      default:                  return new THREE.Vector3(0, -1, 0);
    }
  }

  /**
   * Parse a flow_direction string into a normalized THREE.Vector3.
   *   • Single keyword : 'down', 'up', 'north', 'south', 'east', 'west'
   *   • Compound       : 'north|down', 'south|east'  (pipe-separated, sum + normalize)
   *   • Raw vector     : '0.7,-0.3,0'  (comma-separated x,y,z — auto-normalized)
   */
  private _acFlowDir(direction?: string): THREE.Vector3 {
    if (!direction) return new THREE.Vector3(0, -1, 0);

    // Raw xyz vector e.g. "0.7,-0.3,0" or "0.7, -0.3, 0.5"
    if (/^-?[\d.]+\s*,\s*-?[\d.]+\s*,\s*-?[\d.]+$/.test(direction.trim())) {
      const parts = direction.split(',').map(s => Number(s.trim()));
      const v = new THREE.Vector3(parts[0], parts[1], parts[2]);
      return v.length() > 0 ? v.normalize() : new THREE.Vector3(0, -1, 0);
    }

    // Compound e.g. "north|down"
    if (direction.includes('|')) {
      const sum = new THREE.Vector3();
      for (const part of direction.split('|')) sum.add(this._acFlowDirSingle(part));
      return sum.length() > 0 ? sum.normalize() : new THREE.Vector3(0, -1, 0);
    }

    return this._acFlowDirSingle(direction);
  }

  /**
   * Create 3-D particle systems for all `animations` in the config.
   *
   * Music notes → 8 THREE.Sprite objects cycling upward from the anchor.
   *   Size  : bbox × 0.032 × note_size  (default 1.0)
   *   Speed : 0.28 phase-units/s × note_speed  (default 1.0 ≈ 3.6 s per cycle)
   *
   * AC flow → 12 THREE.LineSegments fanning out in a FLAT ARC.
   *   The streaks are distributed evenly across ±(flow_spread/2)° around the main
   *   flow direction, all rotating around the world-up axis (Y) — giving the
   *   characteristic left-right spread of a wall-mounted split AC louver.
   *   For near-vertical flow the spread falls back to the north axis instead.
   *
   * Called once when the model is ready (from _initMarkerOverlay).
   */
  private _initAnimParticleSystems(): void {
    // Tear down any previous systems
    for (const sys of this._animParticleSystems.values()) {
      if (sys.sprites) sys.sprites.forEach(s => this._scene?.remove(s));
      if (sys.mesh)    this._scene?.remove(sys.mesh);
    }
    this._animParticleSystems.clear();

    if (!this._config.animations || !this._scene) return;

    const bbox = this._modelBboxDiagonal || 100;

    for (const anim of this._config.animations) {
      const origin = this._getAnchorWorldPos(anim.anchor, anim.z_offset || 0);
      if (!origin) continue;

      if (anim.type === 'music_notes') {
        // ---- Music notes: 8 sprites cycling upward ----
        const count      = 8;
        // note_size is a multiplier (default 1.0); base size is intentionally modest
        const noteScale  = bbox * 0.032 * (anim.note_size ?? 1.0);
        const travelDist = bbox * 0.16;
        // note_speed is a multiplier (default 1.0); base speed ≈ 3.6 s / cycle
        const noteSpeed  = 0.28 * (anim.note_speed ?? 1.0);

        const symbols    = ['♪', '♫', '♪', '♫', '♪', '♫', '♪', '♫'];
        const threeColor = this._colorToThree(anim.color || 'rgba(255,215,80,0.95)');

        const sprites: THREE.Sprite[]            = [];
        const spriteMats: THREE.SpriteMaterial[] = [];
        const phases: number[]                   = [];
        const drifts: number[]                   = [];

        for (let i = 0; i < count; i++) {
          const tex = this._buildNoteTexture(symbols[i]);
          const mat = new THREE.SpriteMaterial({
            map: tex, color: threeColor,
            transparent: true, opacity: 0, depthWrite: false, sizeAttenuation: true,
          });
          const sprite = new THREE.Sprite(mat);
          sprite.scale.set(noteScale, noteScale, noteScale);
          sprite.position.copy(origin);
          sprite.visible = false;
          this._scene.add(sprite);
          sprites.push(sprite);
          spriteMats.push(mat);
          phases.push(i / count);
          drifts.push((Math.random() - 0.5) * bbox * 0.06);
        }

        this._animParticleSystems.set(anim.id, {
          type: 'music_notes', active: false,
          origin, sprites, spriteMats, phases, drifts, noteScale, noteSpeed, travelDist,
        });

      } else if (anim.type === 'ac_flow') {
        // ---- AC flow: 12 streaks in a flat arc (wall-mount louver spread) ----
        const count = 12;
        const dir   = this._acFlowDir(anim.flow_direction);
        const maxLen = bbox * 0.22;   // total travel distance of each streak

        // Spread axis: rotate around world-UP for a horizontal left-right fan.
        // Fall back to the scene's north direction when flow is near-vertical.
        const worldUp  = new THREE.Vector3(0, 1, 0);
        const nx = this._config?.north?.x ?? 0;
        const nz = this._config?.north?.z ?? -1;
        const spreadAxis = Math.abs(dir.dot(worldUp)) > 0.85
          ? new THREE.Vector3(nx, 0, nz).normalize()  // near-vertical → spread along north
          : worldUp;                                   // horizontal/diagonal → spread L/R

        // Total fan arc in radians — default 110°, configurable via flow_spread
        const spreadHalf = ((anim.flow_spread ?? 110) / 2) * (Math.PI / 180);

        // Per-streak direction vectors (flat arc, evenly distributed)
        const sdx = new Float32Array(count);
        const sdy = new Float32Array(count);
        const sdz = new Float32Array(count);
        for (let i = 0; i < count; i++) {
          const t     = count <= 1 ? 0 : -1 + (2 * i) / (count - 1);  // -1 … +1
          const angle = t * spreadHalf;
          const rot   = new THREE.Quaternion().setFromAxisAngle(spreadAxis, angle);
          const sd    = dir.clone().applyQuaternion(rot);
          sdx[i] = sd.x; sdy[i] = sd.y; sdz[i] = sd.z;
        }

        const positions = new Float32Array(count * 6);
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));

        const mat = new THREE.LineBasicMaterial({
          color: this._colorToThree(anim.color_cool || '#4fc3f7'),
          transparent: true, opacity: 0.78, depthWrite: false,
        });
        const mesh = new THREE.LineSegments(geom, mat);
        mesh.frustumCulled = false;
        mesh.visible = false;
        this._scene.add(mesh);

        const acPhases = new Float32Array(count);
        for (let i = 0; i < count; i++) acPhases[i] = i / count; // stagger

        this._animParticleSystems.set(anim.id, {
          type: 'ac_flow', active: false,
          origin, mesh, material: mat, count, acPhases, maxLen, sdx, sdy, sdz,
        });
      }
    }

    this._startOrStopAnimationLoop();
  }

  /** Create a room animation overlay element (music notes or AC air flow). */
  private _createAnimationElement(anim: AnimationConfig): HTMLElement {
    const container = document.createElement('div');
    container.style.cssText = 'position:absolute;pointer-events:none;transform:translate(-50%,-50%);display:none;';

    if (anim.type === 'music_notes') {
      const color = anim.color || 'rgba(255,215,80,0.95)';
      // Three notes at staggered horizontal offsets and timing
      [['♪', -13, 0], ['♫', 1, 0.55], ['♪', 15, 1.1]].forEach(([note, xOff, delay]) => {
        const span = document.createElement('span');
        span.textContent = note as string;
        span.style.cssText = [
          'position:absolute',
          `font-size:18px`,
          `color:${color}`,
          'text-shadow:0 0 5px rgba(0,0,0,0.55)',
          `animation:f3d-note-float 1.6s ease-in-out ${delay}s infinite`,
          `left:${xOff}px`,
          'top:0',
          'user-select:none',
        ].join(';');
        container.appendChild(span);
      });

    } else if (anim.type === 'ac_flow') {
      // Store colors in dataset so they can be updated live without recreating the element.
      container.dataset.acCool = anim.color_cool || '#4fc3f7';
      container.dataset.acHeat = anim.color_heat || '#ff7043';
      container.dataset.acFan  = anim.color_fan  || 'rgba(210,210,210,0.85)';

      // Three snowflake icons with staggered horizontal positions and animation delays,
      // mirroring the music_notes layout.  Color is updated live in _updateMarkersAndControls.
      ([[-11, 0], [2, 0.6], [15, 1.2]] as [number, number][]).forEach(([xOff, delay]) => {
        const icon = document.createElement('ha-icon');
        (icon as any).icon = 'mdi:snowflake';
        icon.className = 'f3d-flake-icon';
        icon.style.cssText = [
          'position:absolute',
          'width:18px', 'height:18px',
          `color:${container.dataset.acCool}`,
          `animation:f3d-flake-float 2.0s ease-in-out ${delay}s infinite`,
          `left:${xOff}px`,
          'top:0',
        ].join(';');
        container.appendChild(icon);
      });
    }

    return container;
  }

  /** Apply a CSS transition to a marker element for a smooth room-to-room journey. */
  private _triggerMarkerJourney(markerId: string, el: HTMLElement): void {
    const existing = this._markerJourneyTimeouts.get(markerId);
    if (existing) window.clearTimeout(existing);
    el.style.transition = 'left 0.75s cubic-bezier(0.4,0,0.2,1), top 0.75s cubic-bezier(0.4,0,0.2,1)';
    const id = window.setTimeout(() => {
      el.style.transition = '';
      this._markerJourneyTimeouts.delete(markerId);
    }, 800);
    this._markerJourneyTimeouts.set(markerId, id);
  }

  /**
   * Project a world-space position to 2D screen coordinates.
   * Returns { x, y } in pixels relative to the canvas container, and
   * `behind` = true if the point is behind the camera.
   */
  private _projectToScreen(worldPos: THREE.Vector3): { x: number; y: number; behind: boolean } {
    if (!this._camera || !this._content) return { x: 0, y: 0, behind: true };

    // Reuse scratch vector to avoid a new THREE.Vector3 allocation every call.
    const ndc = this._ndcScratch.copy(worldPos).project(this._camera);
    const behind = ndc.z > 1;
    const x = ((ndc.x + 1) / 2) * this._content.clientWidth;
    const y = ((-ndc.y + 1) / 2) * this._content.clientHeight;
    return { x, y, behind };
  }

  /**
   * Convert a CSS color string to THREE.Color, stripping any alpha component first.
   * THREE.Color logs a console warning for rgba() strings ("Alpha component will be
   * ignored") — silencing it here prevents the warning from firing on every hass update
   * when the user has rgba() colors in colorcondition or light config.
   */
  private _colorToThree(css: string): THREE.Color {
    const noAlpha = css.replace(/rgba\s*\(\s*([^,]+),\s*([^,]+),\s*([^,]+)\s*,[^)]*\)/gi, 'rgb($1,$2,$3)');
    return new THREE.Color().setStyle(noAlpha);
  }

  /**
   * Get the world-space center of a named scene object, optionally shifted up
   * by z_offset (in model units).
   */
  private _getAnchorWorldPos(objectId: string, zOffset = 0): THREE.Vector3 | null {
    const cacheKey = zOffset === 0 ? objectId : `${objectId}:${zOffset}`;
    const cached = this._anchorWorldPosCache.get(cacheKey);
    if (cached) return cached;

    if (!this._scene) return null;
    const obj = this._scene.getObjectByName(objectId);
    if (!obj) return null;

    const box = new THREE.Box3().setFromObject(obj);
    const center = new THREE.Vector3();
    box.getCenter(center);
    if (zOffset !== 0) center.y += zOffset;
    this._anchorWorldPosCache.set(cacheKey, center);
    return center;
  }

  /**
   * Update the 2D positions of all overlay elements based on their 3D anchors.
   * Called after every render so elements stay locked to the scene.
   */
  private _updateOverlayPositions(): void {
    if (!this._markerOverlay || !this._camera) return;

    // Skip expensive projection + DOM writes when the camera hasn't moved.
    // Overlay positions are purely a function of camera pose — if the camera
    // is static there is nothing to update.
    const camPos    = this._camera.position;
    const camTarget = this._controls?.target;
    if (camTarget &&
        camPos.x === this._lastOverlayCamPos.x &&
        camPos.y === this._lastOverlayCamPos.y &&
        camPos.z === this._lastOverlayCamPos.z &&
        camTarget.x === this._lastOverlayCamTarget.x &&
        camTarget.y === this._lastOverlayCamTarget.y &&
        camTarget.z === this._lastOverlayCamTarget.z) {
      return;
    }
    if (camTarget) this._lastOverlayCamTarget.copy(camTarget);
    this._lastOverlayCamPos.copy(camPos);

    const GAP = 8; // px gap between stacked items sharing the same anchor

    // Reference distance for perspective scaling.  At this camera-to-anchor
    // distance the marker/control renders at its configured size (scale = 1.0).
    // Farther away → smaller (min 0.3); closer → capped at 1.0.
    // 0.5× the scene bounding-box diagonal puts full-size at roughly "one-room"
    // zoom distance, shrinking to ~30% when the whole floor plan is in view.
    const refDist = (this._modelBboxDiagonal || 300) * 0.5;

    // Compute a perspective scale factor for a given world-space anchor position.
    const perspScale = (worldPos: THREE.Vector3): number => {
      const dist = this._camera.position.distanceTo(worldPos);
      return Math.max(0.3, Math.min(1.0, refDist / dist));
    };

    // Collect all visible items, grouped by anchor ID so we can auto-stack them
    type OverlayItem = {
      el: HTMLElement;
      baseX: number;
      baseY: number;
      behind: boolean;
      size: number;    // configured CSS size in px
      scale: number;   // perspective scale (0.3 – 1.0)
      offsetX: number;
      offsetY: number;
    };
    const groups = new Map<string, OverlayItem[]>();

    // Markers
    if (this._config.markers) {
      for (const marker of this._config.markers) {
        const el = this._markerElements.get(marker.id);
        if (!el || el.style.display === 'none') continue;
        const anchorId = el.dataset.currentAnchor;
        if (!anchorId) continue;
        const worldPos = this._getAnchorWorldPos(anchorId, marker.z_offset || 0);
        if (!worldPos) continue;
        const { x, y, behind } = this._projectToScreen(worldPos);
        if (!groups.has(anchorId)) groups.set(anchorId, []);
        groups.get(anchorId)!.push({
          el, baseX: x, baseY: y, behind,
          size: marker.size || 48,
          scale: perspScale(worldPos),
          offsetX: marker.offset_x || 0,
          offsetY: marker.offset_y || 0,
        });
      }
    }

    // Room controls
    if (this._config.room_controls) {
      for (const control of this._config.room_controls) {
        const el = this._roomControlElements.get(control.id);
        if (!el || el.style.display === 'none') continue;
        const anchorId = control.anchor;
        if (!anchorId) continue;
        const worldPos = this._getAnchorWorldPos(anchorId, control.z_offset || 0);
        if (!worldPos) continue;
        const { x, y, behind } = this._projectToScreen(worldPos);
        if (!groups.has(anchorId)) groups.set(anchorId, []);
        groups.get(anchorId)!.push({
          el, baseX: x, baseY: y, behind,
          size: control.size || 40,
          scale: perspScale(worldPos),
          offsetX: control.offset_x || 0,
          offsetY: control.offset_y || 0,
        });
      }
    }

    // Animations — positioned independently at their own anchor (no stacking with other items)
    if (this._config.animations) {
      for (const anim of this._config.animations) {
        const el = this._animationElements.get(anim.id);
        if (!el || el.style.display === 'none') continue;
        const worldPos = this._getAnchorWorldPos(anim.anchor, anim.z_offset || 0);
        if (!worldPos) continue;
        const { x, y, behind } = this._projectToScreen(worldPos);
        // Use a unique key so animations never merge into the marker/control stacking group
        const key = `__anim_${anim.id}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push({
          el, baseX: x, baseY: y, behind,
          size: 0, scale: perspScale(worldPos),
          offsetX: anim.offset_x || 0, offsetY: anim.offset_y || 0,
        });
      }
    }

    // Apply positions. When multiple items share an anchor, spread them
    // horizontally as a centered chip row using their visual (scaled) size so
    // the spacing stays proportional to their on-screen footprint.
    // Manual offset_x/y is applied on top.
    for (const group of groups.values()) {
      const totalWidth = group.reduce((sum, item) => sum + item.size * item.scale, 0)
                         + GAP * (group.length - 1);
      let cursor = -totalWidth / 2;
      for (const item of group) {
        const vs = item.size * item.scale; // visual size after scaling
        const stackX = cursor + vs / 2;
        cursor += vs + GAP;
        if (item.behind) {
          item.el.style.opacity = '0';
        } else {
          item.el.style.opacity = '1';
          item.el.style.left = `${item.baseX + stackX + item.offsetX}px`;
          item.el.style.top  = `${item.baseY + item.offsetY}px`;
          item.el.style.transform = `translate(-50%,-50%) scale(${item.scale.toFixed(3)})`;
        }
      }
    }
  }

  /**
   * Update visibility and state for all markers and room controls based on
   * the current hass state. Called on every hass update.
   */
  private _updateMarkersAndControls(hass: HomeAssistant): void {
    if (!this._markerOverlay) return;

    // --- Markers ---
    if (this._config.markers) {
      for (const marker of this._config.markers) {
        const el = this._markerElements.get(marker.id);
        if (!el) continue;

        // Evaluate overall visibility condition
        let visible = true;
        if (marker.visible_when) {
          visible = evaluateCondition(hass, marker.visible_when);
        }

        // Get current room from entity state
        const entityState = hass.states[marker.entity];
        const currentRoom = entityState ? entityState.state : null;

        // For person type: update image from person_entity (or fallback to entity)
        if (marker.type === 'person') {
          const personEntityId = (marker as any).person_entity || marker.entity;
          const personState = hass.states[personEntityId];
          if (personState) {
            const img = el.querySelector('img') as HTMLImageElement | null;
            if (img) {
              const pic = personState.attributes?.entity_picture;
              if (pic) {
                img.src = pic;
                img.alt = personState.attributes?.friendly_name || marker.label || marker.id;
              }
            }
            el.title = marker.label || personState.attributes?.friendly_name || marker.id;
          }
        }

        // Sleep indicator: show/hide Zzz overlay based on sleep_entity state
        if (marker.sleep_entity) {
          const zzzEl = el.querySelector('[data-zzz-overlay]') as HTMLElement | null;
          if (zzzEl) {
            const sleepState = hass.states[marker.sleep_entity];
            const sleepStates = marker.sleep_states || ['on', 'sleeping', 'asleep'];
            const isSleeping = sleepState && sleepStates.includes(sleepState.state);
            zzzEl.style.display = isSleeping ? 'block' : 'none';
          }
        }

        // Check hide_states
        if (visible && currentRoom && marker.hide_states) {
          if (marker.hide_states.includes(currentRoom)) {
            visible = false;
          }
        }

        // Find anchor for current room
        const anchorId = currentRoom && marker.rooms ? marker.rooms[currentRoom] : null;

        if (!visible || !anchorId) {
          el.style.display = 'none';
          el.dataset.currentAnchor = '';
        } else {
          el.style.display = 'block';
          // Trigger journey animation when the marker moves to a different room
          const prevAnchor = el.dataset.currentAnchor;
          if (prevAnchor && prevAnchor !== anchorId) {
            this._triggerMarkerJourney(marker.id, el);
          }
          el.dataset.currentAnchor = anchorId;
          // Position is handled by _updateOverlayPositions() called below
        }
      }
    }

    // --- Room controls ---
    if (this._config.room_controls) {
      for (const control of this._config.room_controls) {
        const el = this._roomControlElements.get(control.id);
        if (!el) continue;

        // Evaluate visibility condition
        let visible = true;
        if (control.visible_when) {
          visible = evaluateCondition(hass, control.visible_when);
        }

        el.style.display = visible ? 'block' : 'none';

        if (visible) {
          // Apply state color to the icon itself; keep the container neutral
          const entityState = hass.states[control.entity];
          const state = entityState ? entityState.state : null;
          const inner = el.querySelector('div') as HTMLElement;
          if (inner) {
            // "off" states — anything not in this set is considered active/on.
            // Handles climate (heat/cool/fan_only/auto), covers, locks, alarms, etc.
            const INACTIVE = new Set(['off', 'unavailable', 'unknown', 'idle', 'standby', 'closed', 'locked', 'disarmed']);
            const isOn = state !== null && !INACTIVE.has(state);
            const icon = inner.querySelector('ha-icon') as HTMLElement;
            if (icon) {
              icon.style.color = isOn
                ? (control.color_on || 'rgba(255,200,50,0.9)')
                : (control.color_off || 'rgba(255,255,255,0.35)');
            }
            inner.style.borderColor = isOn
              ? 'rgba(255,255,255,0.3)'
              : 'rgba(255,255,255,0.1)';
          }
        }
      }
    }

    // --- Room animations (music notes, AC flow) — 3D particle systems ---
    if (this._config.animations) {
      let particleActiveChanged = false;

      for (const anim of this._config.animations) {
        // Legacy HTML-overlay types (none currently, but guard for future)
        if (anim.type !== 'music_notes' && anim.type !== 'ac_flow') {
          const el = this._animationElements.get(anim.id);
          if (!el) continue;
          const visible = anim.visible_when ? evaluateCondition(hass, anim.visible_when) : true;
          el.style.display = visible ? 'block' : 'none';
          continue;
        }

        const sys = this._animParticleSystems.get(anim.id);
        if (!sys) continue;

        const visibleWhen = anim.visible_when ? evaluateCondition(hass, anim.visible_when) : true;
        const entityState = hass.states[anim.entity];
        if (!entityState) {
          if (sys.active) { sys.active = false; particleActiveChanged = true; }
          if (sys.sprites) sys.sprites.forEach(s => { s.visible = false; });
          if (sys.mesh)    sys.mesh.visible = false;
          continue;
        }

        let shouldBeActive = visibleWhen && this._animationsEnabled;

        if (anim.type === 'music_notes') {
          const activeState  = anim.active_state || 'playing';
          const volumeLevel  = Number(entityState.attributes?.volume_level ?? 1);
          shouldBeActive = shouldBeActive
            && entityState.state === activeState
            && volumeLevel > 0;

        } else if (anim.type === 'ac_flow') {
          const hvacAction = entityState.attributes?.hvac_action;
          const isActive   = entityState.state !== 'off'
                          && hvacAction !== 'idle'
                          && hvacAction !== 'off';
          shouldBeActive = shouldBeActive && isActive;

          if (sys.material) {
            // Live-update streak color based on hvac_mode / hvac_action
            const hvacMode = entityState.attributes?.hvac_mode || entityState.state;
            let colorStr: string;
            if (hvacMode === 'heat' || hvacAction === 'heating') {
              colorStr = anim.color_heat || '#ff7043';
            } else if (hvacMode === 'fan_only' || hvacAction === 'fan') {
              colorStr = anim.color_fan  || 'rgba(210,210,210,0.85)';
            } else {
              colorStr = anim.color_cool || '#4fc3f7';
            }
            // Use _colorToThree to strip rgba() alpha and silence THREE.Color warnings.
            (sys.material as THREE.LineBasicMaterial).color.copy(this._colorToThree(colorStr));
          }
        }

        if (shouldBeActive !== sys.active) {
          sys.active = shouldBeActive;
          particleActiveChanged = true;
        }

        if (sys.sprites) sys.sprites.forEach(s => { s.visible = shouldBeActive; });
        if (sys.mesh)    sys.mesh.visible = shouldBeActive;
      }

      if (particleActiveChanged) this._startOrStopAnimationLoop();
    }

    // After updating visibility, sync overlay positions
    this._updateOverlayPositions();
  }

  // https://lit-element.polymer-project.org/guide/styles
  static get styles(): CSSResultGroup {
    return css``;
  }
}
