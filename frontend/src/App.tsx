import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError, enter } from "./api";
import { ClipRecorder } from "./recorder";
import { Room, type RoomConnection } from "./room";
import type { Membership, Snapshot } from "./protocol";
import { Transcript, type TranscriptHandle } from "./Transcript";
import { Assessment } from "./Assessment";
import { assessmentView } from "./assessment-view";

type Session =
  | { kind: "open" }
  | { kind: "ending" }
  | { kind: "closed"; reason: string };
type Screen =
  | { kind: "lobby" }
  | { kind: "joining" }
  | {
      kind: "call";
      member: Membership;
      snapshot: Snapshot | null;
      session: Session;
    };
type Microphone = "off" | "requesting" | "on" | "muted" | "denied";

export default function App() {
  const [screen, setScreen] = useState<Screen>({ kind: "lobby" });
  const [sessionInput, setSessionInput] = useState("");
  const [text, setText] = useState("");
  const [message, setMessage] = useState("");
  const [entryError, setEntryError] = useState("");
  const [connection, setConnection] = useState<
    RTCPeerConnectionState | "waiting"
  >("waiting");
  const [roomConnection, setRoomConnection] =
    useState<RoomConnection>("connecting");
  const [microphone, setMicrophone] = useState<Microphone>("off");
  const [recording, setRecording] = useState(false);
  const [sending, setSending] = useState(false);
  const room = useRef<Room | null>(null);
  const recorder = useRef<ClipRecorder | null>(null);
  const remoteAudio = useRef<HTMLAudioElement | null>(null);
  const transcript = useRef<TranscriptHandle>(null);
  const heading = useRef<HTMLHeadingElement | null>(null);
  const endedHeading = useRef<HTMLHeadingElement | null>(null);
  const confirmation = useRef<HTMLDialogElement | null>(null);
  const cancelEnd = useRef<HTMLButtonElement | null>(null);
  const endControl = useRef<HTMLButtonElement | null>(null);
  const entering = useRef(false);
  const activeSessionId = useRef<string | null>(null);
  const active = screen.kind === "call" ? screen : null;
  const snapshot = active?.snapshot ?? null;
  const closed = Boolean(active && active.session.kind !== "open");
  const sessionEnabled = Boolean(
    active && !closed && snapshot && roomConnection === "connected",
  );
  const review = assessmentView(snapshot, {
    connection: roomConnection,
    ended: closed,
  });
  const transcriptionSupported = ClipRecorder.supported();

  useEffect(() => {
    if (screen.kind === "call" || screen.kind === "lobby")
      heading.current?.focus();
  }, [screen.kind]);
  useEffect(() => {
    if (active?.session.kind === "closed") endedHeading.current?.focus();
  }, [active?.session.kind]);
  useEffect(
    () => () => {
      recorder.current?.stop();
      room.current?.stop();
    },
    [],
  );

  function resetLocalControls() {
    recorder.current?.stop();
    recorder.current = null;
    setMicrophone("off");
    setRecording(false);
    setSending(false);
  }

  async function join(sessionId?: string) {
    if (entering.current) return;
    entering.current = true;
    setMessage("");
    setEntryError("");
    setSending(false);
    setRoomConnection("connecting");
    setScreen({ kind: "joining" });
    try {
      const member = await enter("live", sessionId);
      const instance = new Room(member, {
        onSnapshot: (next) => {
          if (room.current !== instance) return;
          setScreen((current) =>
            current.kind === "call" &&
            current.member.sessionId === next.sessionId &&
            current.session.kind === "open"
              ? { ...current, snapshot: next }
              : current,
          );
        },
        onAudio: (stream) => {
          if (room.current === instance && remoteAudio.current)
            remoteAudio.current.srcObject = stream;
        },
        onConnection: (state) => {
          if (room.current === instance) setConnection(state);
        },
        onRoomConnection: (state) => {
          if (room.current === instance) setRoomConnection(state);
        },
        onMessage: (next) => {
          if (room.current === instance) setMessage(next);
        },
        onEnd: (reason) => {
          if (room.current !== instance) return;
          resetLocalControls();
          instance.stop();
          room.current = null;
          setConnection("waiting");
          confirmation.current?.close();
          setMessage("");
          setScreen((current) =>
            current.kind === "call"
              ? {
                  ...current,
                  session: {
                    kind: "closed",
                    reason:
                      reason === "ended"
                        ? "Call ended or expired. Transcript retained."
                        : "Access rejected. Disconnected locally; shared call termination is unconfirmed.",
                  },
                }
              : current,
          );
        },
      });
      room.current = instance;
      activeSessionId.current = member.sessionId;
      setScreen({
        kind: "call",
        member,
        snapshot: null,
        session: { kind: "open" },
      });
      void instance.open();
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : "Cannot enter the room.";
      setEntryError(
        error instanceof ApiError && error.code === "live_not_configured"
          ? `${detail}. Ask the server operator to configure live providers.`
          : detail,
      );
      setScreen({ kind: "lobby" });
    } finally {
      entering.current = false;
    }
  }

  async function connectMicrophone() {
    const instance = room.current;
    if (!instance || !sessionEnabled) return;
    setMicrophone("requesting");
    try {
      await instance.startMicrophone();
      if (room.current !== instance || !instance.stream) return;
      setMicrophone("on");
      setMessage("");
    } catch {
      if (room.current !== instance) return;
      setMicrophone("denied");
      setMessage("Microphone denied or unavailable. Typed input still works.");
    }
  }

  function toggleRecording() {
    if (recording) {
      recorder.current?.stop();
      recorder.current = null;
      setRecording(false);
      return;
    }
    const instance = room.current;
    if (
      !instance ||
      !sessionEnabled ||
      !transcriptionSupported ||
      !instance.stream
    ) {
      setMessage(
        "Connect a microphone to transcribe. Typed input still works.",
      );
      return;
    }
    const next = new ClipRecorder(instance, (error) => {
      if (room.current !== instance || recorder.current !== next) return;
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
      next.stop();
      recorder.current = null;
      setMessage(
        error instanceof Error ? error.message : "Recording is unavailable.",
      );
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const instance = room.current;
    const submitted = text;
    if (!submitted.trim() || !instance || sending || !sessionEnabled) return;
    if (Array.from(submitted.trim()).length > 2000) {
      setMessage("A typed line must contain no more than 2,000 characters.");
      return;
    }
    setSending(true);
    try {
      await instance.submitText(submitted);
      if (room.current !== instance) return;
      setText((current) => (current === submitted ? "" : current));
      setMessage("");
    } catch (error) {
      if (room.current !== instance) return;
      setMessage(
        error instanceof Error ? error.message : "Cannot send typed text.",
      );
    } finally {
      if (room.current === instance) setSending(false);
    }
  }

  async function leave() {
    const instance = room.current;
    if (!instance) return;
    confirmation.current?.close();
    resetLocalControls();
    room.current = null;
    setConnection("waiting");
    setRoomConnection("disconnected");
    if (remoteAudio.current) remoteAudio.current.srcObject = null;
    setScreen((current) =>
      current.kind === "call"
        ? { ...current, session: { kind: "ending" } }
        : current,
    );
    let reason =
      "Server confirmed: call ended for everyone. Transcript retained.";
    try {
      await instance.leave();
    } catch (error) {
      reason = `${error instanceof Error ? error.message : "The end request failed."} This browser disconnected, but the server did not confirm that the call ended for everyone.`;
    }
    setMessage("");
    setScreen((current) =>
      current.kind === "call" &&
      current.member.sessionId === instance.member.sessionId
        ? { ...current, session: { kind: "closed", reason } }
        : current,
    );
  }

  function returnToLobby() {
    resetLocalControls();
    room.current?.stop();
    room.current = null;
    activeSessionId.current = null;
    setText("");
    setSessionInput("");
    setMessage("");
    setEntryError("");
    setScreen({ kind: "lobby" });
  }

  async function copyRoom() {
    if (!active) return;
    const id = active.member.sessionId;
    let feedback = "Select the room ID to copy.";
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(id);
        feedback = "Room ID copied.";
      }
    } catch {
      /* The room ID stays selectable when clipboard permission is unavailable. */
    }
    if (activeSessionId.current === id) setMessage(feedback);
  }

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <img
            className="brand-logo"
            src="/logo.png"
            alt=""
            width="44"
            height="44"
          />
          <span className="brand-word">
            JEV<span>SCAM DETECTOR</span>
          </span>
        </div>
        {active ? (
          <>
            <div className="room-ticket">
              <span className="eyebrow">Room ID</span>
              <strong aria-label="Room ID">{active.member.sessionId}</strong>
              <button type="button" onClick={() => void copyRoom()}>
                Copy room ID
              </button>
            </div>
            <span className="stamp mode-indicator">
              {active.member.mode.toUpperCase()}
            </span>
            <div className="header-presence">
              <strong>
                {closed
                  ? "Session closed"
                  : roomConnection === "connected"
                    ? "Room connected"
                    : roomConnection === "connecting"
                      ? "Connecting to room"
                      : "Room reconnecting"}
              </strong>
              <span>
                {closed
                  ? "Record retained"
                  : snapshot?.peer.connected
                    ? "Peer online"
                    : snapshot?.peer.joined
                      ? "Peer offline · seat claimed"
                      : "Waiting for peer"}
              </span>
            </div>
          </>
        ) : null}
      </header>
      {active ? (
        <main className="call-layout">
          <h1 className="sr-only" ref={heading} tabIndex={-1}>
            CONVERSATION REVIEW
          </h1>
          <div className="feedback-slot" aria-live="polite" aria-atomic="true">
            {message && <p className="notice">{message}</p>}
          </div>
          {!closed && roomConnection !== "connected" && (
            <p className="connection-banner">
              <span className="stamp">
                {roomConnection === "connecting"
                  ? "CONNECTING"
                  : "CONNECTION ISSUE"}
              </span>{" "}
              {roomConnection === "connecting"
                ? "Loading room."
                : "Reconnecting. Previous assessments are historical."}
            </p>
          )}
          {closed && (
            <section className="session-banner" aria-labelledby="ended-title">
              <h2 id="ended-title" ref={endedHeading} tabIndex={-1}>
                {active.session.kind === "ending"
                  ? "ENDING SESSION"
                  : "SESSION ENDED"}
              </h2>
              <p>
                {active.session.kind === "closed"
                  ? active.session.reason
                  : "Awaiting confirmation. Microphones stopped."}
              </p>
              <button
                type="button"
                disabled={active.session.kind === "ending"}
                onClick={returnToLobby}
              >
                Back to rooms
              </button>
            </section>
          )}
          <div className="call-grid">
            <div className="conversation panel">
              <Transcript
                ref={transcript}
                segments={snapshot?.segments ?? []}
                role={active.member.role}
                loading={!snapshot && !closed}
                evidenceIds={
                  review.kind === "ready"
                    ? review.evidence.map((line) => line.id)
                    : []
                }
              />
              <div className="conversation-bottom">
                <form
                  className="text-form"
                  onSubmit={(event) => void submit(event)}
                >
                  <label htmlFor="typed-line">Add a typed line</label>
                  <div className="composer-row">
                    <input
                      id="typed-line"
                      value={text}
                      onChange={(event) => setText(event.target.value)}
                      placeholder="Type what was said…"
                      disabled={closed}
                      aria-describedby="typed-help"
                      autoComplete="off"
                    />
                    <button
                      className="primary"
                      type="submit"
                      disabled={!sessionEnabled || sending || !text.trim()}
                      aria-busy={sending}
                    >
                      {sending ? "Sending line…" : "Add typed line"}
                    </button>
                  </div>
                  <small className="sr-only" id="typed-help">
                    2,000 characters max
                  </small>
                </form>
                <div className="people" aria-label="Call participants">
                  <div className="person">
                    <strong>You · {active.member.role}</strong>
                    <span>
                      {microphone === "on"
                        ? "Microphone on"
                        : microphone === "muted"
                          ? "Muted"
                          : microphone === "denied"
                            ? "Microphone unavailable"
                            : microphone === "requesting"
                              ? "Requesting microphone"
                              : "Microphone off"}
                    </span>
                  </div>
                  <div className="person">
                    <strong>
                      {snapshot?.peer.role === "host" ||
                      (!snapshot && active.member.role === "guest")
                        ? "Host"
                        : "Guest"}
                    </strong>
                    <span>
                      {closed
                        ? "Session closed locally"
                        : snapshot?.peer.connected
                          ? "In room"
                          : snapshot?.peer.joined
                            ? "Offline · seat claimed"
                            : "Waiting to join"}
                    </span>
                  </div>
                </div>
                <div className="connection-line" role="status">
                  <span>
                    {closed
                      ? "Session controls disabled"
                      : `Room ${roomConnection} · ${connection === "connected" ? "Audio peer connected" : `Audio peer ${connection}`}`}
                  </span>
                  <button
                    className="reconnect"
                    type="button"
                    disabled={closed}
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
                      type="button"
                      disabled={!sessionEnabled}
                      onClick={() => void connectMicrophone()}
                    >
                      Connect microphone
                    </button>
                  ) : microphone === "requesting" ? (
                    <button disabled>Requesting microphone</button>
                  ) : (
                    <button
                      type="button"
                      disabled={closed}
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
                        closed ||
                        (!recording &&
                          (!sessionEnabled ||
                            !transcriptionSupported ||
                            (microphone !== "on" && microphone !== "muted")))
                      }
                      onClick={toggleRecording}
                    >
                      {recording
                        ? "Stop live transcription"
                        : "Start live transcription"}
                    </button>
                  )}
                  <button
                    ref={endControl}
                    className="danger"
                    type="button"
                    disabled={closed}
                    onClick={() => {
                      confirmation.current?.showModal();
                      cancelEnd.current?.focus();
                    }}
                  >
                    End call for everyone
                  </button>
                </div>
                {(recording ||
                  (active.member.mode === "live" &&
                    (!transcriptionSupported ||
                      snapshot?.providerStatus.transcription ===
                        "unavailable"))) && (
                  <p className="privacy">
                    {recording
                      ? "Uploading audio · 5-second clips"
                      : !transcriptionSupported
                        ? "Transcription unsupported"
                        : "Transcription unavailable"}
                  </p>
                )}
              </div>
            </div>
            <Assessment
              view={review}
              mode={active.member.mode}
              role={active.member.role}
              jumpTo={(id) => transcript.current?.jumpTo(id)}
            />
          </div>
          <dialog
            ref={confirmation}
            className="end-dialog"
            aria-labelledby="end-title"
            aria-describedby="end-description"
            onClose={() => endControl.current?.focus()}
          >
            <h2 id="end-title">END THIS CALL?</h2>
            <p id="end-description">
              Ends the call for both participants. Transcript stays visible.
            </p>
            <div className="dialog-actions">
              <button
                ref={cancelEnd}
                type="button"
                onClick={() => confirmation.current?.close()}
              >
                Keep call open
              </button>
              <button
                className="primary"
                type="button"
                onClick={() => void leave()}
              >
                Confirm end call
              </button>
            </div>
          </dialog>
        </main>
      ) : (
        <main className="welcome">
          <section className="intro">
            <h1 ref={heading} tabIndex={-1}>
              UNMASK
              <br />
              <span>THE SCAM.</span>
            </h1>
            <p className="lede">
              Shared transcript. Jev scam-risk assessments.
            </p>
          </section>
          <form
            className="entry panel"
            onSubmit={(event) => {
              event.preventDefault();
              if (!sessionInput.trim()) {
                setEntryError("Enter a room ID to join.");
                return;
              }
              void join(sessionInput.trim());
            }}
          >
            <h2>OPEN A ROOM.</h2>
            <button
              className="primary"
              type="button"
              disabled={screen.kind !== "lobby"}
              onClick={() => void join()}
            >
              {screen.kind === "joining" ? "Connecting…" : "Create room"}
            </button>
            <div className="join-divider">OR JOIN</div>
            <label htmlFor="room-input">Room ID, if joining</label>
            <input
              id="room-input"
              value={sessionInput}
              onChange={(event) => {
                setSessionInput(event.target.value);
                setEntryError("");
              }}
              disabled={screen.kind === "joining"}
              placeholder="Paste a room ID"
              autoComplete="off"
            />
            <button type="submit" disabled={screen.kind !== "lobby"}>
              Join room
            </button>
            <div
              className="entry-feedback"
              aria-live="polite"
              aria-atomic="true"
            >
              {screen.kind === "joining" && (
                <p className="notice" aria-busy="true">
                  Connecting to the call server…
                </p>
              )}
              {entryError && (
                <p className="notice" role="alert">
                  {entryError}
                </p>
              )}
            </div>
          </form>
        </main>
      )}
    </div>
  );
}
