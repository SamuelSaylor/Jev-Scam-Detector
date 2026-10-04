import {
  iceConfig,
  decodeEvent,
  updatedSnapshot,
  type Event,
  type Membership,
  type Signal,
  type Snapshot,
} from "./protocol";
import { request } from "./api";

type RoomCallbacks = {
  onSnapshot: (snapshot: Snapshot) => void;
  onAudio: (stream: MediaStream | null) => void;
  onConnection: (state: RTCPeerConnectionState | "waiting") => void;
  onMessage: (message: string) => void;
  onEnd: () => void;
};

export class Room {
  private socket: WebSocket | null = null;
  private connection: RTCPeerConnection | null = null;
  private sender: RTCRtpSender | null = null;
  private microphone: MediaStream | null = null;
  private state: Snapshot | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private generation = 0;
  private sequence = 0;
  private pendingRequest: Promise<void> = Promise.resolve();
  private uploadAbort: AbortController | null = null;
  private ice: RTCConfiguration = {
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  };
  private pendingCandidates: Extract<Signal, { kind: "candidate" }>[] = [];

  constructor(
    readonly member: Membership,
    private callbacks: RoomCallbacks,
  ) {}

  async open() {
    try {
      const response = await fetch("/config.json", { cache: "no-store" });
      if (response.ok) {
        const parsed = iceConfig.safeParse(await response.json());
        if (parsed.success) this.ice = parsed.data;
      }
    } catch {
      this.callbacks.onMessage(
        "Network config unavailable. Peer audio may fail on restrictive networks.",
      );
    }
    if (!this.stopped) this.connect();
  }

  reconnect() {
    this.socket?.close(4000, "Reconnect requested");
  }
  nextSequence() {
    return ++this.sequence;
  }
  get stream() {
    return this.microphone;
  }

  async startMicrophone() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (this.stopped) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    this.microphone?.getTracks().forEach((track) => track.stop());
    this.microphone = stream;
    await this.sender?.replaceTrack(stream.getAudioTracks()[0] ?? null);
  }

  setMuted(muted: boolean) {
    this.microphone?.getAudioTracks().forEach((track) => {
      track.enabled = !muted;
    });
  }

  private send(data: Signal) {
    if (this.socket?.readyState === WebSocket.OPEN)
      this.socket.send(JSON.stringify({ type: "signal", data }));
  }

  private connect() {
    const socket = new WebSocket(
      `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/sessions/${encodeURIComponent(this.member.sessionId)}/events`,
    );
    this.socket = socket;
    socket.onopen = () =>
      socket.send(
        JSON.stringify({
          type: "auth",
          participantToken: this.member.participantToken,
        }),
      );
    socket.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      let message: Event;
      try {
        message = decodeEvent(event.data);
      } catch {
        this.callbacks.onMessage(
          "The server sent an invalid event. Reconnecting.",
        );
        socket.close();
        return;
      }
      void this.receive(message).catch(() => {
        this.callbacks.onMessage("Audio connection failed. Reconnecting.");
        socket.close();
      });
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.resetPeer();
      if (this.stopped) return;
      if (event.code === 4404 || event.code === 4401 || event.code === 4403) {
        this.callbacks.onMessage(
          event.code === 4404
            ? "The call ended or expired."
            : "Call access was rejected.",
        );
        this.callbacks.onEnd();
      } else {
        this.callbacks.onMessage("Connection lost. Reconnecting to the room.");
        this.retry = setTimeout(() => this.connect(), 1000);
      }
    };
  }

  private async receive(message: Event) {
    if (this.stopped) return;
    if (message.type === "snapshot") {
      this.resetPeer();
      this.sequence = Math.max(
        this.sequence,
        0,
        ...message.snapshot.segments
          .filter((segment) => segment.speaker === this.member.role)
          .map((segment) => segment.clientSeq),
      );
    }
    if (
      message.type === "peer" &&
      message.role !== this.member.role &&
      !message.connected
    ) this.resetPeer();
    if (this.state) this.state = updatedSnapshot(this.state, message);
    else if (message.type === "snapshot") this.state = message.snapshot;
    if (this.state) this.callbacks.onSnapshot(this.state);
    if (message.type === "signal_error") {
      this.callbacks.onMessage(
        "The other participant is offline. Waiting for them to reconnect.",
      );
      return;
    }
    if (message.type === "signal") {
      if (message.from === this.member.role) return;
      await this.handleSignal(message.data);
    }
    if (
      (message.type === "snapshot" ||
        (message.type === "peer" && message.role !== this.member.role)) &&
      this.state?.peer.connected &&
      this.member.role === "host" &&
      !this.connection
    ) {
      await this.makeOffer();
    }
  }

  private createPeer(): RTCPeerConnection {
    const pc = new RTCPeerConnection(this.ice);
    this.connection = pc;
    this.callbacks.onConnection(pc.connectionState);
    pc.onconnectionstatechange = () => {
      if (this.connection === pc)
        this.callbacks.onConnection(pc.connectionState);
    };
    pc.ontrack = (event) => {
      if (this.connection === pc)
        this.callbacks.onAudio(new MediaStream([event.track]));
    };
    pc.onicecandidate = (event) => {
      if (this.connection === pc)
        this.send({
          kind: "candidate",
          candidate: event.candidate?.candidate ?? null,
          sdpMid: event.candidate?.sdpMid ?? null,
          sdpMLineIndex: event.candidate?.sdpMLineIndex ?? null,
        });
    };
    return pc;
  }

  private async makeOffer() {
    const pc = this.createPeer();
    const generation = this.generation;
    const transceiver = pc.addTransceiver("audio", { direction: "sendrecv" });
    this.sender = transceiver.sender;
    await this.sender.replaceTrack(
      this.microphone?.getAudioTracks()[0] ?? null,
    );
    if (generation !== this.generation) return;
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    if (generation === this.generation && offer.sdp)
      this.send({ kind: "offer", sdp: offer.sdp });
  }

  private async handleSignal(data: Signal) {
    if (data.kind === "offer") {
      if (this.member.role !== "guest") return;
      if (this.connection) this.resetPeer();
      const pc = this.createPeer();
      const generation = this.generation;
      await pc.setRemoteDescription({ type: "offer", sdp: data.sdp });
      if (generation !== this.generation) return;
      const audio = pc
        .getTransceivers()
        .find((item) => item.receiver.track.kind === "audio");
      if (audio) audio.direction = "sendrecv";
      this.sender = audio?.sender ?? null;
      await this.sender?.replaceTrack(
        this.microphone?.getAudioTracks()[0] ?? null,
      );
      if (generation !== this.generation) return;
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await this.flushCandidates(pc);
      if (generation === this.generation && answer.sdp)
        this.send({ kind: "answer", sdp: answer.sdp });
      return;
    }
    if (data.kind === "answer") {
      if (this.member.role !== "host" || !this.connection) return;
      await this.connection.setRemoteDescription({
        type: "answer",
        sdp: data.sdp,
      });
      await this.flushCandidates(this.connection);
      return;
    }
    if (!this.connection?.remoteDescription) this.pendingCandidates.push(data);
    else
      await this.connection.addIceCandidate(
        data.candidate === null
          ? null
          : {
              candidate: data.candidate,
              sdpMid: data.sdpMid,
              sdpMLineIndex: data.sdpMLineIndex,
            },
      );
  }

  private async flushCandidates(pc: RTCPeerConnection) {
    for (const candidate of this.pendingCandidates)
      await pc.addIceCandidate(
        candidate.candidate === null
          ? null
          : {
              candidate: candidate.candidate,
              sdpMid: candidate.sdpMid,
              sdpMLineIndex: candidate.sdpMLineIndex,
            },
      );
    this.pendingCandidates = [];
  }

  private resetPeer() {
    this.generation++;
    this.connection?.close();
    this.connection = null;
    this.sender = null;
    this.pendingCandidates = [];
    this.callbacks.onAudio(null);
    this.callbacks.onConnection("waiting");
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.pendingRequest.catch(() => {}).then(operation);
    this.pendingRequest = next;
    return next;
  }

  submitText(text: string): Promise<void> {
    return this.enqueue(async () => {
      await request(
        `/sessions/${encodeURIComponent(this.member.sessionId)}/transcripts`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clientSeq: this.nextSequence(), text }),
        },
        this.member.participantToken,
      );
    });
  }

  upload(
    blob: Blob,
    timing?: { captureStartedAt: string; captureEndedAt: string },
  ): Promise<void> {
    return this.enqueue(async () => {
      if (this.stopped) return;
      const body = new FormData();
      body.append("clientSeq", String(this.nextSequence()));
      body.append("audio", blob, "clip.webm");
      if (timing) {
        body.append("captureStartedAt", timing.captureStartedAt);
        body.append("captureEndedAt", timing.captureEndedAt);
      }
      const controller = new AbortController();
      this.uploadAbort = controller;
      try {
        await request(
          `/sessions/${encodeURIComponent(this.member.sessionId)}/audio`,
          { method: "POST", body, signal: controller.signal },
          this.member.participantToken,
        );
      } finally {
        if (this.uploadAbort === controller) this.uploadAbort = null;
      }
    });
  }

  async leave() {
    this.stop();
    await request(
      `/sessions/${encodeURIComponent(this.member.sessionId)}/leave`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      },
      this.member.participantToken,
    );
  }

  stop() {
    this.stopped = true;
    this.uploadAbort?.abort();
    if (this.retry) clearTimeout(this.retry);
    this.socket?.close();
    this.socket = null;
    this.resetPeer();
    this.microphone?.getTracks().forEach((track) => track.stop());
    this.microphone = null;
  }
}
