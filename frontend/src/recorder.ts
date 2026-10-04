import type { Room } from "./room";

export class ClipRecorder {
  private recorder: MediaRecorder | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private active = false;
  constructor(
    private room: Room,
    private onError: (message: string) => void,
  ) {}

  static supported() {
    return (
      typeof MediaRecorder !== "undefined" &&
      MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    );
  }

  start() {
    if (!ClipRecorder.supported() || !this.room.stream)
      throw new Error(
        "WebM/Opus recording or microphone is unavailable. Use typed text.",
      );
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
    recorder.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data);
    };
    recorder.onerror = () => {
      this.stop();
      this.onError("Recording failed. Typed text remains available.");
    };
    recorder.onstop = () => {
      if (!this.active) return;
      const clip = new Blob(chunks, { type: "audio/webm" });
      if (clip.size > 2 * 1024 * 1024) {
        this.stop();
        this.onError("Clip exceeded 2 MiB. Typed text remains available.");
        return;
      }
      if (clip.size === 0) {
        this.capture();
        return;
      }
      void this.room
        .upload(clip)
        .then(() => this.capture())
        .catch((error) => {
          if (!this.active) return;
          this.stop();
          this.onError(
            error instanceof Error
              ? error.message
              : "The clip could not be uploaded.",
          );
        });
    };
    recorder.start();
    this.timer = setTimeout(() => {
      if (recorder.state === "recording") recorder.stop();
    }, 5000);
  }

  stop() {
    this.active = false;
    if (this.timer) clearTimeout(this.timer);
    if (this.recorder?.state === "recording") this.recorder.stop();
    this.recorder = null;
  }
}
