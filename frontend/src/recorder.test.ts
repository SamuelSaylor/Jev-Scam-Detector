import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClipRecorder, MAX_PENDING_CLIPS, type CaptureTime } from "./recorder";

// Browser recording and network I/O are the only fakes. Deliver stop events
// asynchronously, as MediaRecorder does, with one complete blob per recording.
class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  static stopEventDelay = 0;
  static isTypeSupported() { return true; }
  state = "inactive";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(_stream: MediaStream, _options: MediaRecorderOptions) {
    FakeMediaRecorder.instances.push(this);
  }
  start() { this.state = "recording"; }
  stop() {
    if (this.state === "inactive") throw new Error("Already stopped");
    this.state = "inactive";
    const id = FakeMediaRecorder.instances.indexOf(this);
    const deliver = () => {
      this.ondataavailable?.({ data: new Blob([`complete-webm-${id}`]) });
      this.onstop?.();
    };
    if (FakeMediaRecorder.stopEventDelay) setTimeout(deliver, FakeMediaRecorder.stopEventDelay);
    else queueMicrotask(deliver);
  }
}

function deferred() {
  let resolve = () => {};
  let reject = (_error: Error) => {};
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function setup() {
  const requests: ReturnType<typeof deferred>[] = [];
  const upload = vi.fn((_blob: Blob, _timing?: CaptureTime) => {
    const request = deferred();
    requests.push(request);
    return request.promise;
  });
  const onError = vi.fn();
  const recorder = new ClipRecorder({ stream: new MediaStream(), upload }, onError);
  return { recorder, requests, upload, onError };
}

async function settle() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(new Date("2026-04-01T00:00:00Z"));
  FakeMediaRecorder.instances = [];
  FakeMediaRecorder.stopEventDelay = 0;
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  vi.stubGlobal("MediaStream", class {});
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("ClipRecorder", () => {
  it("continues five-second capture during delayed uploads and uploads FIFO", async () => {
    const { recorder, upload, requests } = setup();
    recorder.start();
    for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(5000);
    expect(FakeMediaRecorder.instances).toHaveLength(4);
    expect(FakeMediaRecorder.instances[3]?.state).toBe("recording");
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0]?.[1]).toEqual({
      captureStartedAt: "2026-04-01T00:00:00.000Z",
      captureEndedAt: "2026-04-01T00:00:05.000Z",
    });
    const stopped = recorder.stop();
    await settle();
    for (let i = 0; i < 4; i++) {
      expect(await upload.mock.calls[i]?.[0].text()).toBe(`complete-webm-${i}`);
      requests[i]?.resolve();
      await settle();
    }
    await stopped;
    expect(upload).toHaveBeenCalledTimes(4);
    expect(FakeMediaRecorder.instances).toHaveLength(4);
  });

  it("flushes the final partial clip once and waits for transcription completion", async () => {
    const { recorder, upload, requests } = setup();
    recorder.start();
    await vi.advanceTimersByTimeAsync(1700);
    let finished = false;
    const stopped = recorder.stop().then(() => { finished = true; });
    const stoppedAgain = recorder.stop();
    await settle();
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0]?.[1]?.captureEndedAt).toBe("2026-04-01T00:00:01.700Z");
    await vi.advanceTimersByTimeAsync(30000);
    expect(finished).toBe(false);
    expect(FakeMediaRecorder.instances).toHaveLength(1);
    requests[0]?.resolve();
    await Promise.all([stopped, stoppedAgain]);
    expect(finished).toBe(true);
  });

  it("uses capture stop time even when final data delivery is delayed", async () => {
    const { recorder, upload, requests } = setup();
    FakeMediaRecorder.stopEventDelay = 2000;
    recorder.start();
    await vi.advanceTimersByTimeAsync(1000);
    const stopped = recorder.stop();
    expect(upload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(upload.mock.calls[0]?.[1]?.captureEndedAt).toBe("2026-04-01T00:00:01.000Z");
    requests[0]?.resolve();
    await stopped;
  });

  it("bounds complete clips and reports saturation without dropping accepted clips", async () => {
    const { recorder, upload, requests, onError } = setup();
    recorder.start();
    for (let i = 0; i < MAX_PENDING_CLIPS; i++) await vi.advanceTimersByTimeAsync(5000);
    expect(FakeMediaRecorder.instances).toHaveLength(MAX_PENDING_CLIPS);
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("backlog is full"));
    expect(() => recorder.start()).toThrow("backlog is full");
    for (let i = 0; i < MAX_PENDING_CLIPS; i++) {
      requests[i]?.resolve();
      await settle();
    }
    await recorder.stop();
    expect(upload).toHaveBeenCalledTimes(MAX_PENDING_CLIPS);
  });

  it.each(["Upload failed", "Transcription failed"])("drains queued clips and the partial clip after %s", async (message) => {
    const { recorder, upload, requests, onError } = setup();
    recorder.start();
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(1200);
    requests[0]?.reject(new Error(message));
    await settle();
    expect(onError).toHaveBeenCalledWith(message);
    expect(FakeMediaRecorder.instances[2]?.state).toBe("inactive");
    expect(upload).toHaveBeenCalledTimes(2);
    requests[1]?.resolve();
    await settle();
    expect(upload).toHaveBeenCalledTimes(3);
    requests[2]?.resolve();
    await recorder.stop();
    expect(upload.mock.calls[2]?.[1]?.captureEndedAt).toBe("2026-04-01T00:00:11.200Z");
  });

  it("keeps one bounded queue across stop and restart", async () => {
    const { recorder, upload, requests } = setup();
    recorder.start();
    await vi.advanceTimersByTimeAsync(1000);
    const firstStop = recorder.stop();
    await settle();
    recorder.start();
    await vi.advanceTimersByTimeAsync(5000);
    expect(upload).toHaveBeenCalledTimes(1);
    const secondStop = recorder.stop();
    await settle();
    for (let i = 0; i < 3; i++) {
      requests[i]?.resolve();
      await settle();
    }
    await Promise.all([firstStop, secondStop]);
    expect(upload).toHaveBeenCalledTimes(3);
  });
});
