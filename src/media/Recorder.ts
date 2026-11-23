export interface RecordingResolution {
  width: number;
  height: number;
  dpr: number;
}

/**
 * Computes native WebGL backing dimensions for crisp Full-HD / 2K recording:
 * - Long edge is guaranteed >= 1920px (true 1080p+ even in compact/split browser windows)
 * - Long edge is capped <= 2560px (crisp 2K QHD while keeping real-time 60 FPS hardware encoding smooth)
 * - Both width and height are strictly even (required by H.264 / VP9 video encoders)
 */
export function computeRecordingResolution(
  cssWidth: number,
  cssHeight: number,
  deviceDpr: number
): RecordingResolution {
  const safeW = Math.max(320, cssWidth);
  const safeH = Math.max(240, cssHeight);
  const baseDpr = Math.max(1, Math.min(deviceDpr || 1, 2));
  const longCss = Math.max(safeW, safeH);

  const desiredLong = Math.max(1920, Math.min(2560, Math.round(longCss * baseDpr)));
  const recDpr = Math.min(3, desiredLong / longCss);

  // Round to nearest even integer (>= 2)
  const width = Math.max(2, Math.round((safeW * recDpr) / 2) * 2);
  const height = Math.max(2, Math.round((safeH * recDpr) / 2) * 2);
  return { width, height, dpr: width / safeW };
}

export class PerformanceRecorder {
  private mediaRecorder: MediaRecorder | null = null;
  private captureStream: MediaStream | null = null;
  private chunks: Blob[] = [];
  private startTime = 0;
  private recording = false;
  private activeWidth = 0;
  private activeHeight = 0;

  isRecording(): boolean {
    return this.recording;
  }

  getElapsedSec(): number {
    if (!this.recording) return 0;
    return (performance.now() - this.startTime) / 1000;
  }

  getActiveResolution(): { width: number; height: number } {
    return { width: this.activeWidth, height: this.activeHeight };
  }

  start(
    canvas: HTMLCanvasElement,
    audioStream: MediaStream | null,
    onEnded?: () => void
  ): boolean {
    if (this.recording) return false;
    if (typeof MediaRecorder === 'undefined') return false;

    const videoStream = canvas.captureStream(60);
    this.captureStream = videoStream;
    this.activeWidth = canvas.width;
    this.activeHeight = canvas.height;

    const tracks: MediaStreamTrack[] = [...videoStream.getVideoTracks()];
    if (audioStream) {
      tracks.push(...audioStream.getAudioTracks());
    }
    const combined = new MediaStream(tracks);

    // Prefer hardware-accelerated H.264 High/Main MP4 (sharpest 1080p/2K 60fps & native QuickTime/mobile playback),
    // falling back cleanly to VP9 / H.264 / VP8 WebM when MP4 MediaRecorder isn't supported.
    const preferredTypes = [
      'video/mp4;codecs=avc1.640032,mp4a.40.2',
      'video/mp4;codecs=avc1.4d0032,mp4a.40.2',
      'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
      'video/mp4',
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=h264,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ];
    const mimeType = preferredTypes.find((t) => MediaRecorder.isTypeSupported(t)) ?? '';

    try {
      this.chunks = [];
      this.mediaRecorder = new MediaRecorder(combined, {
        ...(mimeType ? { mimeType } : {}),
        videoBitsPerSecond: 20_000_000, // 20 Mbps for razor-sharp 1080p/2K 60fps HDR particles & Matrix rain
        audioBitsPerSecond: 256_000,
      });

      this.mediaRecorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) {
          this.chunks.push(ev.data);
        }
      };

      this.mediaRecorder.onstop = () => {
        const type = this.mediaRecorder?.mimeType || mimeType || 'video/webm';
        const ext = type.includes('mp4') ? 'mp4' : 'webm';
        const blob = new Blob(this.chunks, { type });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        a.href = url;
        a.download = `aether-strings-${this.activeWidth}x${this.activeHeight}-${ts}.${ext}`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        this.chunks = [];
        this.releaseCaptureStream();
        onEnded?.();
      };

      this.mediaRecorder.start(1000);
      this.startTime = performance.now();
      this.recording = true;
      return true;
    } catch (err) {
      console.error('[PerformanceRecorder] Failed to start:', err);
      this.recording = false;
      this.releaseCaptureStream();
      return false;
    }
  }

  stop(): void {
    if (!this.recording || !this.mediaRecorder) return;
    this.recording = false;
    if (this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
    } else {
      this.releaseCaptureStream();
    }
  }

  private releaseCaptureStream(): void {
    if (this.captureStream) {
      for (const track of this.captureStream.getTracks()) {
        track.stop();
      }
      this.captureStream = null;
    }
  }
}
