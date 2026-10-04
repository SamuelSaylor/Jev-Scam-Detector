import type { Room } from "./room";

export type CaptureTime = NonNullable<Parameters<Room["upload"]>[1]>;
type Clip = { blob: Blob; timing: CaptureTime };

// Includes the clip currently uploading. Each clip is capped at 2 MiB.
export const MAX_PENDING_CLIPS = 6;

export class ClipRecorder {
  private recorder: MediaRecorder | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private active = false;
  private clips: Clip[] = [];
  private processing = false;
  private captureStopped: Promise<void> = Promise.resolve();
  private drained: Promise<void> = Promise.resolve();

  constructor(
    private room: Pick<Room, "stream" | "upload">,
    private onError: (message: string) => void,
  ) {}

  static supported() {
    return (
      typeof MediaRecorder !== "undefined" &&
      MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    );
  }

  start() {
    if (this.active) return;
    if (this.recorder)
      throw new Error("The final clip is still being captured. Wait before restarting.");
    if (!ClipRecorder.supported() || !this.room.stream)
      throw new Error(
        "WebM/Opus recording or microphone is unavailable. Use typed text.",
      );
    if (this.clips.length >= MAX_PENDING_CLIPS)
      throw new Error("Transcription backlog is full. Wait before restarting.");
    this.active = true;
    this.capture();
  }

  private capture() {
    if (!this.active || !this.room.stream) return;
    const chunks: Blob[] = [];
    const recorder = new MediaRecorder(this.room.stream, {
      mimeType: "audio/webm;codecs=opus",
    });
    this.recorder = recorder;
    const captureStartedAt = new Date().toISOString();
    let captureEndedAt: string | null = null;
    let finishCapture = () => {};
    this.captureStopped = new Promise<void>((resolve) => {
      finishCapture = resolve;
    });
    recorder.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data);
    };
    recorder.onerror = () => {
      void this.stop();
      this.onError("Recording failed. Typed text remains available.");
    };
    recorder.onstop = () => {
      if (this.timer !== null) clearTimeout(this.timer);
      this.timer = null;
      this.recorder = null;
      const clip = new Blob(chunks, { type: "audio/webm" });
      if (clip.size > 2 * 1024 * 1024) {
        this.active = false;
        this.onError("Clip exceeded 2 MiB. Typed text remains available.");
      } else if (clip.size) {
        this.clips.push({
          blob: clip,
          timing: {
            captureStartedAt,
            captureEndedAt: captureEndedAt ?? new Date().toISOString(),
          },
        });
      }
      if (this.clips.length >= MAX_PENDING_CLIPS) {
        this.active = false;
        this.onError("Transcription backlog is full. Capture stopped; queued clips will finish.");
      }
      // Restart before any network work. Each stop produces a complete WebM.
      if (this.active) this.capture();
      this.process();
      finishCapture();
    };
    recorder.start();
    this.timer = setTimeout(() => {
      captureEndedAt = new Date().toISOString();
      if (recorder.state === "recording") recorder.stop();
    }, 5000);
    // Record the stop request time, not the later onstop delivery time.
    this.stopCapture = () => {
      if (recorder.state !== "inactive") {
        captureEndedAt = new Date().toISOString();
        recorder.stop();
      }
    };
  }

  private stopCapture = () => {};

  private process() {
    if (this.processing) return;
    this.processing = true;
    this.drained = this.drain();
  }

  private async drain() {
    try {
      while (this.clips.length) {
        const clip = this.clips[0];
        if (!clip) break;
        try {
          await this.room.upload(clip.blob, clip.timing);
        } catch (error) {
          // Stop new capture, but still flush the partial clip and accepted queue.
          void this.stop();
          this.onError(
            error instanceof Error ? error.message : "The clip could not be uploaded.",
          );
        }
        this.clips.shift();
      }
    } finally {
      this.processing = false;
    }
  }

  async stop() {
    this.active = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (this.recorder) this.stopCapture();
    await this.captureStopped;
    await this.drained;
  }
}
