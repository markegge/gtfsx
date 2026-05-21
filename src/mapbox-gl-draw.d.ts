declare module '@mapbox/mapbox-gl-draw' {
  import type { IControl, Map as MapboxMap } from 'mapbox-gl';
  import type { Feature, FeatureCollection, Geometry } from 'geojson';

  // Minimal hand-typing of the @mapbox/mapbox-gl-draw API we actually use.
  // The package has no first-party types and DT's @types/mapbox__mapbox-gl-draw
  // lags upstream; widening to GeoJSON / object instead of `any` keeps callers
  // honest at the trust boundary without pulling a giant declaration.
  // Built-in interaction modes — handed to consumers who customize them
  // (e.g., direct_select extension). Treated as opaque per-mode objects.
  export interface DrawModes {
    direct_select: Record<string, unknown>;
    simple_select: Record<string, unknown>;
    draw_line_string: Record<string, unknown>;
    draw_polygon: Record<string, unknown>;
    draw_point: Record<string, unknown>;
    [mode: string]: Record<string, unknown>;
  }

  // Fired by mapbox-gl-draw via the underlying map's event bus.
  export interface DrawEvent<T extends Geometry = Geometry> {
    features: Array<Feature<T>>;
    action?: string;
  }

  export default class MapboxDraw implements IControl {
    static modes: DrawModes;

    constructor(options?: object);
    onAdd(map: MapboxMap): HTMLElement;
    onRemove(map: MapboxMap): void;
    add(geojson: Feature | FeatureCollection | Geometry): string[];
    get(featureId: string): Feature | undefined;
    getAll(): FeatureCollection;
    delete(ids: string | string[]): this;
    deleteAll(): this;
    set(featureCollection: FeatureCollection): string[];
    trash(): this;
    combineFeatures(): this;
    uncombineFeatures(): this;
    getMode(): string;
    changeMode(mode: string, options?: object): this;
    setFeatureProperty(featureId: string, property: string, value: unknown): this;
    getSelectedIds(): string[];
    getSelected(): FeatureCollection;
    getSelectedPoints(): FeatureCollection;
  }
}
