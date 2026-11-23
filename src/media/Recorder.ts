export class PerformanceRecorder {
  private mediaRecorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private startTime = 0;
  private recording = false;

  isRecording(): boolean {
    return this.recording;
  }

  getElapsedSec(): number {
    if (!this.recording) return 0;
    return (performance.now() - this.startTime) / 1000;
  }

  start(canvas: HTMLCanvasElement, audioStream: MediaStream | null): boolean {
    if (this.recording) return false;
    if (typeof MediaRecorder === 'undefined') return false;

    const videoStream = canvas.captureStream(60);
    const tracks: MediaStreamTrack[] = [...videoStream.getVideoTracks()];
    if (audioStream) {
      tracks.push(...audioStream.getAudioTracks());
    }
    const combined = new MediaStream(tracks);

    const preferredTypes = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
      'video/mp4',
    ];
    const mimeType = preferredTypes.find((t) => MediaRecorder.isTypeSupported(t)) ?? '';

    try {
      this.chunks = [];
      this.mediaRecorder = new MediaRecorder(combined, {
        ...(mimeType ? { mimeType } : {}),
        videoBitsPerSecond: 6_500_000,
        audioBitsPerSecond: 192_000,
      });

      this.mediaRecorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) {
          this.chunks.push(ev.data);
        }
      };

      this.mediaRecorder.onstop = () => {
        const type = this.mediaRecorder?.mimeType || 'video/webm';
        const ext = type.includes('mp4') ? 'mp4' : 'webm';
        const blob = new Blob(this.chunks, { type });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        a.href = url;
        a.download = `air-strings-${ts}.${ext}`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        this.chunks = [];
      };

      this.mediaRecorder.start(250);
      this.startTime = performance.now();
      this.recording = true;
      return true;
    } catch (err) {
      console.error('[PerformanceRecorder] Failed to start:', err);
      this.recording = false;
      return false;
    }
  }

  stop(): void {
    if (!this.recording || !this.mediaRecorder) return;
    this.recording = false;
    if (this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
    }
  }
}
