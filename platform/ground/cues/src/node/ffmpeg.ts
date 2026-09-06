/* ============================================================================
 * eis-cues/node — RTSP → frames, for the CCTV PIXEL fallback only.
 *
 * ONE stream, 1–2 fps, PNG frames piped from ffmpeg. This path is off unless
 * asked for (`EIS_CCTV_MODE=pixel`), so nothing on the demo or test path
 * depends on ffmpeg being installed or on an RTSP server being reachable —
 * failing here degrades the cctv rail and touches nothing else.
 *
 * Preflight is explicit: if ffmpeg is absent the source reports the failure
 * through `onError` and stays stopped, rather than hanging on a pipe that will
 * never carry a byte.
 * ========================================================================== */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';

import type { CameraFrame } from '../cctv/pixel.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IEND = Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

export const DEFAULT_FRAME_FPS = 1;
export const MAX_FRAME_FPS = 2;

export interface RtspFrameSourceOptions {
  cameraId: string;
  /** e.g. rtsp://127.0.0.1:8554/cam-east-north */
  url: string;
  /** Frames per second, clamped to [0.1, MAX_FRAME_FPS]. Default 1. */
  fps?: number;
  /** Scale the long edge down before detection. Default 640. */
  widthPx?: number;
  /** ffmpeg executable. Default 'ffmpeg' on PATH. */
  ffmpegPath?: string;
  onFrame(frame: CameraFrame): void | Promise<void>;
  onError(reason: string): void;
  now?: () => number;
}

/** True when the ffmpeg binary can be executed. */
export function ffmpegAvailable(ffmpegPath = 'ffmpeg'): boolean {
  try {
    const probe = spawnSync(ffmpegPath, ['-version'], { stdio: 'ignore' });
    return probe.status === 0;
  } catch {
    return false;
  }
}

/**
 * Pulls PNG frames out of one RTSP stream.
 *
 * The PNG splitter scans for the IEND chunk, which is the last 8 bytes of every
 * PNG, so a frame is only ever handed on once it is complete — a torn frame is
 * a fabricated observation.
 */
export class RtspFrameSource {
  private child?: ChildProcess;
  private buffer = Buffer.alloc(0);
  private running = false;
  private readonly now: () => number;

  constructor(private readonly options: RtspFrameSourceOptions) {
    this.now = options.now ?? Date.now;
  }

  start(): boolean {
    if (this.running) return true;
    const ffmpegPath = this.options.ffmpegPath ?? 'ffmpeg';
    if (!ffmpegAvailable(ffmpegPath)) {
      this.options.onError(
        `ffmpeg (${ffmpegPath}) is not available; the pixel fallback cannot run. ` +
        'Event mode is unaffected.',
      );
      return false;
    }
    const fps = Math.min(MAX_FRAME_FPS, Math.max(0.1, this.options.fps ?? DEFAULT_FRAME_FPS));
    const width = this.options.widthPx ?? 640;
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-rtsp_transport', 'tcp',
      '-i', this.options.url,
      '-vf', `fps=${fps},scale=${width}:-2`,
      '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1',
    ];
    this.running = true;
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    child.stdout?.on('data', (chunk: Buffer) => this.consume(chunk));
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim();
      if (text !== '') this.options.onError(`ffmpeg: ${text}`);
    });
    child.on('error', (err) => {
      this.running = false;
      this.options.onError(`ffmpeg failed to start: ${err.message}`);
    });
    child.on('close', (code) => {
      this.running = false;
      if (code !== 0 && code !== null) this.options.onError(`ffmpeg exited with code ${code}`);
    });
    return true;
  }

  stop(): void {
    this.running = false;
    this.child?.kill('SIGTERM');
    this.child = undefined;
    this.buffer = Buffer.alloc(0);
  }

  get isRunning(): boolean {
    return this.running;
  }

  private consume(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (!this.buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
        const start = this.buffer.indexOf(PNG_SIGNATURE);
        if (start < 0) {
          // Keep only enough tail to complete a signature split across chunks.
          if (this.buffer.length > PNG_SIGNATURE.length) {
            this.buffer = this.buffer.subarray(this.buffer.length - PNG_SIGNATURE.length + 1);
          }
          return;
        }
        this.buffer = this.buffer.subarray(start);
      }
      const end = this.buffer.indexOf(IEND);
      if (end < 0) return;
      const frameEnd = end + IEND.length;
      const png = this.buffer.subarray(0, frameEnd);
      this.buffer = this.buffer.subarray(frameEnd);
      const { width, height } = readPngSize(png);
      void this.options.onFrame({
        cameraId: this.options.cameraId,
        ts: this.now(),
        widthPx: width,
        heightPx: height,
        data: new Uint8Array(png),
      });
    }
  }
}

/** IHDR is always the first chunk: width/height at bytes 16..24. */
export function readPngSize(png: Uint8Array): { width: number; height: number } {
  if (png.length < 24) return { width: 0, height: 0 };
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}
