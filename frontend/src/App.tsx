import { useEffect, useRef, useState, type FormEvent } from "react";
import { enter } from "./api";
import { ClipRecorder } from "./recorder";
import { Room } from "./room";
import type { Membership, Snapshot } from "./protocol";
import { Transcript, type TranscriptHandle } from "./Transcript";
import { Assessment } from "./Assessment";
import { assessmentView } from "./assessment-view";

type Screen =
  | { kind: "lobby" }
  | { kind: "joining" }
  | { kind: "call"; member: Membership; snapshot: Snapshot | null }
  | { kind: "ending" };
type Microphone = "off" | "requesting" | "on" | "muted" | "denied";

export default function App() {
  const [screen, setScreen] = useState<Screen>({ kind: "lobby" });
  const [sessionInput, setSessionInput] = useState("");
  const [text, setText] = useState("");
  const [message, setMessage] = useState("");
  const [connection, setConnection] = useState<
    RTCPeerConnectionState | "waiting"
  >("waiting");
  const [microphone, setMicrophone] = useState<Microphone>("off");
  const [recording, setRecording] = useState(false);
  const [sending, setSending] = useState(false);
  const room = useRef<Room | null>(null);
  const recorder = useRef<ClipRecorder | null>(null);
  const remoteAudio = useRef<HTMLAudioElement | null>(null);
  const transcript = useRef<TranscriptHandle>(null);

  useEffect(
    () => () => {
      recorder.current?.stop();
      room.current?.stop();
    },
    [],
  );

  async function join(sessionId?: string) {
    setMessage("");
    setScreen({ kind: "joining" });
    try {
      const member = await enter("live", sessionId);
      const instance = new Room(member, {
        onSnapshot: (snapshot) =>
          setScreen((current) =>
            current.kind === "call" &&
            current.member.sessionId === snapshot.sessionId
              ? { ...current, snapshot }
              : current,
          ),
        onAudio: (stream) => {
          if (remoteAudio.current) remoteAudio.current.srcObject = stream;
        },
        onConnection: setConnection,
        onMessage: setMessage,
        onEnd: () => {
          recorder.current?.stop();
          room.current?.stop();
          room.current = null;
          setScreen({ kind: "lobby" });
          setSessionInput("");
          setText("");
          setConnection("waiting");
          setMicrophone("off");
          setRecording(false);
        },
      });
      room.current = instance;
      setScreen({ kind: "call", member, snapshot: null });
      void instance.open();
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Cannot enter the room.",
      );
      setScreen({ kind: "lobby" });
    }
  }

  async function connectMicrophone() {
    const active = room.current;
    if (!active) return;
    setMicrophone("requesting");
    try {
      await active.startMicrophone();
      if (room.current !== active || !active.stream) return;
      setMicrophone("on");
      setMessage("");
    } catch {
      if (room.current !== active) return;
      setMicrophone("denied");
      setMessage(
        "Microphone access was denied or unavailable. You can still use typed text.",
      );
    }
  }

  function toggleRecording() {
    if (recording) {
      recorder.current?.stop();
      recorder.current = null;
      setRecording(false);
      return;
    }
    if (!room.current || !ClipRecorder.supported() || !room.current.stream) {
      setMessage(
        "Connect a microphone in a supported browser to transcribe live audio. Typed text still works.",
      );
      return;
    }
    const next = new ClipRecorder(room.current, (error) => {
      setMessage(error);
      setRecording(false);
      recorder.current = null;
    });
    recorder.current = next;
    try {
      next.start();
      setRecording(true);
      setMessage("");
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Recording is unavailable.",
      );
      recorder.current = null;
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!text.trim() || !room.current || sending) return;
    setSending(true);
    try {
      await room.current.submitText(text);
      setText("");
      setMessage("");
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Cannot send typed text.",
      );
    } finally {
      setSending(false);
    }
  }

  async function leave() {
    if (!room.current) return;
    const instance = room.current;
    recorder.current?.stop();
    recorder.current = null;
    room.current = null;
    setScreen({ kind: "ending" });
    try {
      await instance.leave();
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "The server did not confirm that the call ended.",
      );
    }
    setScreen({ kind: "lobby" });
    setMicrophone("off");
    setRecording(false);
    setConnection("waiting");
    setText("");
    setSessionInput("");
  }

  const active = screen.kind === "call" ? screen : null;
  const snapshot = active?.snapshot;
  const review = assessmentView(snapshot ?? null);

  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">
          <img className="brand-logo" src="/logo.png" alt="" />
          <span className="brand-word">
            <span>Jev Scam Detector</span>
            <span aria-hidden="true">Jev Scam Detector</span>
          </span>
        </span>
        <span className="top-slash" aria-hidden="true" />
      </header>
      {active ? (
        <main className="call-layout">
          <section className="call-header" aria-label="Call details">
            <div className="room-ticket">
              <strong aria-label="Room ID">{active.member.sessionId}</strong>
              <button
                type="button"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(active.member.sessionId)
                    .then(() => setMessage("Room ID copied."))
                    .catch(() => setMessage("Copy the room ID shown above."))
                }
              >
                Copy room ID
              </button>
            </div>
          </section>
          {message && (
            <p role="alert" className="notice">
              {message}
            </p>
          )}
          <div className="call-grid">
            <div className="call-main">
              <section className="people" aria-label="Call participants">
                <div className="person">
                  <span className="avatar">
                    {active.member.role === "host" ? "H" : "G"}
                  </span>
                  <div>
                    <strong>You</strong>
                    <span
                      className="mic-state"
                      role="img"
                      aria-label={`Microphone ${microphone}`}
                      title={`Microphone ${microphone}`}
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                        {microphone === "requesting" ? (
                          <circle cx="12" cy="12" r="8" strokeDasharray="3 3" />
                        ) : (
                          <>
                            <rect x="9" y="2" width="6" height="12" rx="3" />
                            <path d="M5 10a7 7 0 0 0 14 0M12 17v5m-4 0h8" />
                            {microphone !== "on" && <path d="M3 3l18 18" />}
                          </>
                        )}
                      </svg>
                    </span>
                  </div>
                </div>
                <div className="person">
                  <span className="avatar other">
                    {snapshot?.peer.role === "host" ? "H" : "G"}
                  </span>
                  <div>
                    <strong>Other participant</strong>
                    <span>
                      {snapshot?.peer.connected
                        ? "In room"
                        : snapshot?.peer.joined
                          ? "Offline. Waiting to reconnect"
                          : "Waiting to join"}
                    </span>
                  </div>
                </div>
              </section>
              <div className="connection-line" role="status">
                <span
                  className={`status-dot ${connection === "connected" ? "connected" : ""}`}
                />
                {connection === "connected"
                  ? "Audio peer connected"
                  : `Audio peer ${connection}`}{" "}
                <button
                  className="reconnect"
                  type="button"
                  onClick={() => room.current?.reconnect()}
                >
                  Reconnect to room
                </button>
              </div>
              <audio
                ref={remoteAudio}
                autoPlay
                playsInline
                aria-label="Remote participant audio"
              />
              <div className="controls">
                {microphone === "off" || microphone === "denied" ? (
                  <button
                    className="primary"
                    type="button"
                    onClick={() => void connectMicrophone()}
                  >
                    Connect microphone
                  </button>
                ) : microphone === "requesting" ? (
                  <button disabled>Requesting microphone</button>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      const muted = microphone === "on";
                      room.current?.setMuted(muted);
                      setMicrophone(muted ? "muted" : "on");
                    }}
                  >
                    {microphone === "on"
                      ? "Mute microphone"
                      : "Unmute microphone"}
                  </button>
                )}
                {active.member.mode === "live" && (
                  <button
                    type="button"
                    disabled={
                      microphone === "off" ||
                      microphone === "denied" ||
                      microphone === "requesting"
                    }
                    onClick={toggleRecording}
                  >
                    {recording
                      ? "Stop live transcription"
                      : "Start live transcription"}
                  </button>
                )}
                <button
                  className="danger"
                  type="button"
                  onClick={() => void leave()}
                >
                  End call for everyone
                </button>
              </div>
              {active.member.mode === "live" &&
                snapshot?.providerStatus.transcription === "unavailable" && (
                  <p className="privacy" role="status">
                    Transcription provider unavailable. Typed lines still work.
                  </p>
                )}
            </div>
            <div className="conversation">
              <Transcript
                ref={transcript}
                segments={snapshot?.segments ?? []}
                role={active.member.role}
                evidenceIds={
                  review.kind === "ready"
                    ? review.evidence.map((line) => line.id)
                    : []
                }
              />
              <form
                className="text-form"
                onSubmit={(event) => void submit(event)}
              >
                <label htmlFor="typed-line">Add a typed line</label>
                <div>
                  <input
                    id="typed-line"
                    value={text}
                    onChange={(event) => setText(event.target.value)}
                    placeholder="Type what was said"
                    maxLength={2000}
                  />
                  <button type="submit" disabled={sending || !text.trim()}>
                    Add typed line
                  </button>
                </div>
              </form>
            </div>
            <Assessment
              view={review}
              mode={active.member.mode}
              role={active.member.role}
              jumpTo={(id) => transcript.current?.jumpTo(id)}
            />
          </div>
        </main>
      ) : (
        <main className="welcome">
          <div className="burst" aria-hidden="true" />
          <div className="intro">
            <img className="hero-logo" src="/logo.png" alt="Jev Scam Detector" />
            <p className="context stamp">CALL CHECK</p>
            <div className="title-stack">
              <h1>
                <span className="title-line">CATCHING SCAMMERS</span>
                <span className="title-line accent live">LIVE!</span>
              </h1>
            </div>
          </div>
          <form
            className="entry"
            onSubmit={(event) => {
              event.preventDefault();
              if (sessionInput.trim()) void join(sessionInput.trim());
            }}
          >
            <button
              className="primary"
              type="button"
              disabled={screen.kind !== "lobby"}
              onClick={() => void join()}
            >
              Create room
            </button>
            <label htmlFor="room-input">Room ID, if joining</label>
            <input
              id="room-input"
              value={sessionInput}
              onChange={(event) => setSessionInput(event.target.value)}
              autoComplete="off"
            />
            <button
              type="submit"
              disabled={screen.kind !== "lobby" || !sessionInput.trim()}
            >
              Join room
            </button>
            {message && <p role="alert" className="notice">{message}</p>}
          </form>
        </main>
      )}
      <footer>
        <div className="footer-brand">
          <img className="footer-logo" src="/logo.png" alt="" />
          Jev call demo
        </div>
        <span>0.3.0</span>
      </footer>
      
    </div>
  );
}
