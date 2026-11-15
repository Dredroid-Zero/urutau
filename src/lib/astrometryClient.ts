import {
  detectSources,
  reprojectFrame,
  type DetectOptions,
  type Detection,
  type Frame,
  type GridSpec,
} from './astrometry';
import { stackReprojectedFrames } from './processing';

let workerInstance: Worker | null = null;
let nextRequestId = 1;
const pending = new Map<number, { resolve: (val: any) => void; reject: (err: Error) => void }>();

function getWorker(): Worker | null {
  if (typeof window === 'undefined' || typeof Worker === 'undefined') return null;
  if (!workerInstance) {
    try {
      workerInstance = new Worker(new URL('../workers/astrometry.worker.ts', import.meta.url), {
        type: 'module',
      });
      workerInstance.onmessage = (ev: MessageEvent<{ id: number; ok: boolean; result?: any; error?: string }>) => {
        const entry = pending.get(ev.data.id);
        if (!entry) return;
        pending.delete(ev.data.id);
        if (ev.data.ok) entry.resolve(ev.data.result);
        else entry.reject(new Error(ev.data.error || 'Worker task failed'));
      };
      workerInstance.onerror = () => {
        // Fallback smoothly if worker fails to load
        workerInstance = null;
      };
    } catch {
      return null;
    }
  }
  return workerInstance;
}

function runInWorker<T>(payload: Record<string, unknown>, fallback: () => T): Promise<T> {
  const w = getWorker();
  if (!w) {
    return Promise.resolve().then(fallback);
  }
  const id = nextRequestId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try {
      w.postMessage({ id, ...payload });
    } catch {
      pending.delete(id);
      resolve(fallback());
    }
  });
}

export function reprojectFrameAsync(
  frame: Frame,
  grid: GridSpec,
  rejectMask: number,
): Promise<ReturnType<typeof reprojectFrame>> {
  return runInWorker(
    { type: 'reproject', frame, grid, rejectMask },
    () => reprojectFrame(frame, grid, rejectMask),
  );
}

export function detectSourcesAsync(
  frame: Frame,
  options: DetectOptions,
): Promise<Detection[]> {
  return runInWorker(
    { type: 'detect', frame, options },
    () => detectSources(frame, options),
  );
}

export function stackFramesAsync(
  items: Array<{ data: Float32Array; variance?: Float32Array }>,
  width: number,
  height: number,
  method: 'median' | 'mean',
): Promise<ReturnType<typeof stackReprojectedFrames>> {
  return runInWorker(
    { type: 'stack', items, width, height, method },
    () => stackReprojectedFrames(items, width, height, method),
  );
}
