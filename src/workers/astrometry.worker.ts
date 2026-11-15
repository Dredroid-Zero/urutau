import {
  detectSources,
  reprojectFrame,
  type DetectOptions,
  type Frame,
  type GridSpec,
} from '../lib/astrometry';
import { stackReprojectedFrames } from '../lib/processing';

export type WorkerRequest =
  | {
      id: number;
      type: 'reproject';
      frame: Frame;
      grid: GridSpec;
      rejectMask: number;
    }
  | {
      id: number;
      type: 'detect';
      frame: Frame;
      options: DetectOptions;
    }
  | {
      id: number;
      type: 'stack';
      items: Array<{ data: Float32Array; variance?: Float32Array }>;
      width: number;
      height: number;
      method: 'median' | 'mean';
    };

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  try {
    if (msg.type === 'reproject') {
      const res = reprojectFrame(msg.frame, msg.grid, msg.rejectMask);
      (self as unknown as Worker).postMessage({ id: msg.id, ok: true, result: res });
    } else if (msg.type === 'detect') {
      const detections = detectSources(msg.frame, msg.options);
      (self as unknown as Worker).postMessage({ id: msg.id, ok: true, result: detections });
    } else if (msg.type === 'stack') {
      const res = stackReprojectedFrames(msg.items, msg.width, msg.height, msg.method);
      (self as unknown as Worker).postMessage({ id: msg.id, ok: true, result: res });
    }
  } catch (err) {
    (self as unknown as Worker).postMessage({
      id: msg.id,
      ok: false,
      error: (err as Error).message,
    });
  }
};
