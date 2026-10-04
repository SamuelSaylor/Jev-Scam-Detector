import { useEffect, useRef, useState, type FormEvent } from "react";
import { enter } from "./api";
import { ClipRecorder } from "./recorder";
import { Room } from "./room";
import type { Membership, Snapshot } from "./protocol";

type Screen =
  | { kind: "lobby" }
  | { kind: "joining" }
  | { kind: "call"; member: Membership; snapshot: Snapshot | null }
  | { kind: "ending" };
type Microphone = "off" | "requesting" | "on" | "muted" | "denied";

function elapsed(milliseconds: number) {
  const seconds = Math.floor(milliseconds / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function interval(milliseconds: number) {
  const start = Math.floor(milliseconds / 5000) * 5000;
  return `${elapsed(start)}–${elapsed(start + 5000)}`;
}

export default function App() {
  const [screen, setScreen] = useState<Screen>({ kind: "lobby" });
  const [sessionInput, setSessionInput] = useState("");
  const [mode, setMode] = useState<"demo" | "live">("demo");
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

  useEffect(
    () => () => {
      recorder.current?.stop();
      room.current?.stop();
    },
    [],
  );

  async function join(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    setScreen({ kind: "joining" });
    try {
      const member = await enter(mode, sessionInput.trim() || undefined);
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
  const latest = snapshot?.assessments.at(-1);
  const evidence = new Set(latest?.evidenceSegmentIds ?? []);

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
        <span className="top-note">SECOND OPINION</span>
        <span className="top-slash" aria-hidden="true" />
      </header>
      {active ? (
        <main className="call-layout">
          <section className="call-header" aria-label="Call details">
            <div className="title-stack">
              <p className="context stamp">
                {active.member.mode === "demo" ? "DEMO" : "LIVE"} · 2 SEATS
              </p>
              <h1>
                <span className="title-line">STAY ON</span>
                <span className="title-line accent">THE LINE</span>
              </h1>
              <p className="subhead">
                Talk with someone you know. Type what you hear to review it
                together.
              </p>
            </div>
            <div className="room-ticket">
              <span className="ticket-stamp" aria-hidden="true">
                ID
              </span>
              <span>Room ID to share</span>
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
              <small>
                Share this ID only. Never share a participant token.
              </small>
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
                    <span>
                      {active.member.role === "host" ? "Host" : "Guest"} ·{" "}
                      {microphone === "on"
                        ? "Microphone on"
                        : microphone === "muted"
                          ? "Muted"
                          : microphone === "denied"
                            ? "Microphone unavailable"
                            : "Microphone off"}
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
                ·{" "}
                {snapshot?.peer.connected
                  ? "Both browsers in room"
                  : "Waiting for the other browser"}{" "}
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
              <p className="privacy">
                {active.member.mode === "demo"
                  ? "Demo mode. Microphone audio goes only to the other browser if you connect it. No microphone audio is uploaded or transcribed."
                  : "Live mode. Audio is uploaded in complete five-second clips only when you start live transcription."}
              </p>
              <section className="transcript" aria-labelledby="timeline-title">
                <div className="section-heading">
                  <div>
                    <p className="context">Shared record</p>
                    <h2 id="timeline-title">Five-second timeline</h2>
                  </div>
                  <span>{snapshot?.segments.length ?? 0} lines</span>
                </div>
                {snapshot?.segments.length ? (
                  <ol className="timeline">
                    {snapshot.segments.map((segment) => (
                      <li
                        key={segment.id}
                        id={`segment-${segment.id}`}
                        className={
                          evidence.has(segment.id) ? "evidence-line" : ""
                        }
                      >
                        <time>{interval(segment.startMs)}</time>
                        <div>
                          <span className="speaker">
                            {segment.speaker === active.member.role
                              ? "You"
                              : segment.speaker === "host"
                                ? "Host"
                                : "Guest"}{" "}
                            ·{" "}
                            {segment.source === "manual"
                              ? "typed"
                              : "transcribed"}
                          </span>
                          <p>{segment.text}</p>
                          {evidence.has(segment.id) && (
                            <span className="evidence-tag">
                              Referenced evidence
                            </span>
                          )}
                        </div>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="empty">
                    No lines yet. Add a typed line below. Both people will see
                    it.
                  </p>
                )}
              </section>
              <form
                className="text-form"
                onSubmit={(event) => void submit(event)}
              >
                <label htmlFor="typed-line">
                  Add a line to the shared timeline
                </label>
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
                <small>
                  Manual text is labeled as typed, never as a recording.
                </small>
              </form>
            </div>
            <aside className="risk" aria-labelledby="risk-title">
              <p className="context stamp">CALL REVIEW</p>
              <h2 id="risk-title">Text pressure</h2>
              <div className="risk-reading">
                <span className="risk-slash" aria-hidden="true" />
                {snapshot?.providerStatus.assessment === "unavailable"
                  ? "Unavailable"
                  : snapshot?.currentRisk === null ||
                      snapshot?.currentRisk === undefined
                    ? "Unassessed"
                    : `${Math.round(snapshot.currentRisk * 100)}%`}
              </div>
              <p>
                {active.member.mode === "demo"
                  ? "Demo heuristic. It checks typed text for a few example words. This is not a scam verdict."
                  : "Jev example. This estimate uses transcript text, not verified caller identity."}
              </p>
              {snapshot?.providerStatus.assessment === "unavailable" && (
                <p className="warning">
                  Assessment provider unavailable. An old score cannot establish
                  safety.
                </p>
              )}
              {snapshot?.currentRisk === null &&
                snapshot.providerStatus.assessment === "available" && (
                  <p className="warning">
                    New lines await the next five-second review. No result does
                    not mean safe.
                  </p>
                )}
              {latest && (
                <div className="evidence">
                  <h3>Evidence in this review</h3>
                  {latest.evidenceSegmentIds.length ? (
                    <ul>
                      {latest.evidenceSegmentIds.map((id) => {
                        const segment = snapshot?.segments.find(
                          (item) => item.id === id,
                        );
                        return segment ? (
                          <li key={id}>
                            <a href={`#segment-${id}`}>
                              {segment.speaker === active.member.role
                                ? "Your"
                                : "Other participant’s"}{" "}
                              line at {elapsed(segment.startMs)}: “
                              {segment.text}”
                            </a>
                          </li>
                        ) : null;
                      })}
                    </ul>
                  ) : (
                    <p>
                      No lines cited in the latest review. This does not
                      establish safety.
                    </p>
                  )}
                </div>
              )}
              <div className="guidance">
                <strong>If anything feels wrong</strong>
                <p>
                  Pause the call. Find the organization’s number yourself from a
                  trusted source and call it independently. Do not share codes
                  or send money based on this call.
                </p>
              </div>
            </aside>
          </div>
        </main>
      ) : (
        <main className="welcome">
          <div className="burst" aria-hidden="true" />
          <div className="intro">
            <img className="hero-logo" src="/logo.png" alt="Jev Scam Detector" />
            <p className="context stamp">CALL CHECK</p>
            <div className="title-stack">
              <span className="ghost-copy" aria-hidden="true">
                CHECK
              </span>
              <h1>
                <span className="title-line">CATCHING SCAMMERS</span>
                <span className="title-line accent live">LIVE!</span>
              </h1>
            </div>
            <p className="lede">
              Make a private room for two people. Talk through your browsers,
              then add lines to a shared five-second timeline.
            </p>
            <div className="demo-note">
              <strong>No keys? Demo mode.</strong>
              <span>
                Typed text works without microphone permission. A sample rule
                reviews it every five seconds.
              </span>
            </div>
          </div>
          <form className="entry" onSubmit={(event) => void join(event)}>
            <h2>Start or join</h2>
            <fieldset>
              <legend>Review mode</legend>
              <label>
                <input
                  type="radio"
                  name="mode"
                  value="demo"
                  checked={mode === "demo"}
                  onChange={() => setMode("demo")}
                />{" "}
                Demo, no keys needed
              </label>
              <label>
                <input
                  type="radio"
                  name="mode"
                  value="live"
                  checked={mode === "live"}
                  onChange={() => setMode("live")}
                />{" "}
                Live, requires server providers
              </label>
            </fieldset>
            <label htmlFor="room-input">Room ID, if joining</label>
            <input
              id="room-input"
              value={sessionInput}
              onChange={(event) => setSessionInput(event.target.value)}
              placeholder="Leave blank to make a room"
              autoComplete="off"
            />
            <button
              className="primary"
              disabled={screen.kind === "joining" || screen.kind === "ending"}
              type="submit"
            >
              {screen.kind === "joining"
                ? "Connecting…"
                : sessionInput.trim()
                  ? "Join room"
                  : "Create room"}
            </button>
            <small>
              One host and one guest. The room ID is not a login token.
            </small>
            {message && (
              <p role="alert" className="notice">
                {message}
              </p>
            )}
          </form>
        </main>
      )}
      <footer>
        <div className="footer-brand">
          <img className="footer-logo" src="/logo.png" alt="" />
          Jev call demo
        </div>
        <span>0.2.0</span>
      </footer>
    </div>
  );
}
