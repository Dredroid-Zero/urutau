declare module 'aladin-lite' {
  const AladinLite: {
    init: Promise<void>;
    aladin: (selectorOrEl: string | HTMLElement, options?: Record<string, unknown>) => any;
    HiPS: (url: string, options?: Record<string, unknown>) => any;
  };
  export default AladinLite;
}

declare module 'gifenc' {
  export interface GifEncoderInstance {
    writeFrame: (
      index: Uint8Array,
      width: number,
      height: number,
      options?: { palette?: number[][]; delay?: number },
    ) => void;
    finish: () => void;
    bytes: () => Uint8Array;
  }
  export function GIFEncoder(): GifEncoderInstance;
  export function quantize(rgba: Uint8ClampedArray | Uint8Array, maxColors: number): number[][];
  export function applyPalette(rgba: Uint8ClampedArray | Uint8Array, palette: number[][]): Uint8Array;
}
