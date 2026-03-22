declare module '@mapbox/mapbox-gl-draw' {
  import type { IControl } from 'mapbox-gl';

  export default class MapboxDraw implements IControl {
    constructor(options?: any);
    onAdd(map: any): HTMLElement;
    onRemove(map: any): void;
    add(geojson: any): string[];
    get(featureId: string): any;
    getAll(): any;
    delete(ids: string | string[]): this;
    deleteAll(): this;
    set(featureCollection: any): string[];
    trash(): this;
    combineFeatures(): this;
    uncombineFeatures(): this;
    getMode(): string;
    changeMode(mode: string, options?: any): this;
    setFeatureProperty(featureId: string, property: string, value: any): this;
    getSelectedIds(): string[];
    getSelected(): any;
    getSelectedPoints(): any;
  }
}
