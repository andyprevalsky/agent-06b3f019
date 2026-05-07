export class LRUCache {
      constructor() { this.map = new Map(); }
      get(k: any) { return this.map.get(k); }
      set(k: any, v: any) { this.map.set(k, v); return this; }
      has(k: any) { return this.map.has(k); }
      delete(k: any) { return this.map.delete(k); }
      clear() { this.map.clear(); }
      map = new Map();
    }
    export default LRUCache;
