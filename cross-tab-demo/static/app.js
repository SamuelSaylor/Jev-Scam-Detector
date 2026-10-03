const $ = (id) => document.getElementById(id);

const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];
const CHUNK_MS = 250; // how often recorded audio is shipped to the server

let ws = null;
let pc = null;
let localStream = null;
let recorder = null;
let audioCtx = null;
let mp3Element = null;
let me = null;
let roomCode = null;
const interimBubbles = new Map(); // speaker slot -> element

function setStatus(text, kind = "") {
  const el = $("status");
  el.textContent = text;
  el.className = `pill ${kind}`;
}

function showError(id, text) {
  const el = $(id);
  el.textContent = text || "";
  el.hidden = !text;
}

// ---------- lobby ----------

$("create").onclick = async () => {
  const res = await fetch("/api/rooms", { method: "POST" });
  const { code } = await res.json();
  await enterRoom(code);
};

$("join").onclick = () => {
  const code = $("code").value.trim().toUpperCase();
  if (code) enterRoom(code);
};

const params = new URLSearchParams(location.search);
if (params.get("room")) $("code").value = params.get("room").toUpperCase();

// ---------- local audio ----------

async function getLocalStream() {
  const file = $("mp3").files[0];
  if (!file) {
    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: false,
    });
  }
  // MP3 test mode: play the file through WebAudio and use the result as our "microphone".
  audioCtx = new AudioContext();
  mp3Element = new Audio(URL.createObjectURL(file));
  const source = audioCtx.createMediaElementSource(mp3Element);
  const destination = audioCtx.createMediaStreamDestination();
  source.connect(destination);
  source.connect(audioCtx.destination); // so you can hear the test file too
  mp3Element.onended = () => setStatus("MP3 finished", "live");
  await audioCtx.resume();
  await mp3Element.play();
  return destination.stream;
}

function startRecording() {
  // Each person ships only their own audio, so the server knows exactly who is speaking.
  const audioOnly = new MediaStream(localStream.getAudioTracks());
  recorder = new MediaRecorder(audioOnly, { mimeType: "audio/webm;codecs=opus" });
  recorder.ondataavailable = (e) => {
    if (e.data.size && ws?.readyState === WebSocket.OPEN) ws.send(e.data);
  };
  ws.send(JSON.stringify({ type: "start-stt" }));
  recorder.start(CHUNK_MS);
}

// ---------- room + signaling ----------

async function enterRoom(code) {
  showError("lobby-error", "");
  try {
    localStream = await getLocalStream();
  } catch (err) {
    showError("lobby-error", `Could not get audio: ${err.message}`);
    return;
  }

  roomCode = code;
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${scheme}://${location.host}/ws/${code}`);
  ws.onmessage = (e) => onServerMessage(JSON.parse(e.data));
  ws.onclose = () => {
    if (roomCode) setStatus("Disconnected", "bad");
  };
  setStatus("Connecting…");
}

async function onServerMessage(msg) {
  switch (msg.type) {
    case "error":
      leave();
      showError("lobby-error", msg.detail);
      break;
    case "joined":
      me = msg.you;
      $("lobby").hidden = true;
      $("call").hidden = false;
      $("feed-card").hidden = false;
      $("room-code").textContent = roomCode;
      $("download").href = `/api/rooms/${roomCode}/transcript`;
      history.replaceState(null, "", `?room=${roomCode}`);
      msg.history.forEach(addMessage);
      setStatus(`You are Person ${me}`, "live");
      if (!msg.stt) showError("stt-error", "Transcription is off: set DEEPGRAM_API_KEY on the server.");
      if (msg.peers.length) $("peer-state").textContent = "Connecting to the other person…";
      startRecording();
      break;
    case "peer-joined":
      // The person already in the room makes the offer.
      $("peer-state").textContent = "Connecting to the other person…";
      await makeOffer();
      break;
    case "peer-left":
      closePeer();
      $("peer-state").textContent = "The other person left. Waiting for someone to join…";
      break;
    case "signal":
      await onSignal(msg.data);
      break;
    case "transcript":
      addMessage(msg.message);
      break;
    case "interim":
      showInterim(msg);
      break;
    case "stt-error":
      showError("stt-error", msg.detail);
      break;
  }
}

function sendSignal(data) {
  ws.send(JSON.stringify({ type: "signal", data }));
}

function ensurePeer() {
  if (pc) return pc;
  pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
  pc.onicecandidate = (e) => e.candidate && sendSignal({ candidate: e.candidate });
  pc.ontrack = (e) => {
    $("remote").srcObject = e.streams[0];
  };
  pc.onconnectionstatechange = () => {
    if (pc?.connectionState === "connected") $("peer-state").textContent = "Call connected — talk away.";
    if (pc?.connectionState === "failed") $("peer-state").textContent = "Call connection failed.";
  };
  return pc;
}

function closePeer() {
  pc?.close();
  pc = null;
  $("remote").srcObject = null;
}

async function makeOffer() {
  closePeer();
  const peer = ensurePeer();
  await peer.setLocalDescription(await peer.createOffer());
  sendSignal({ description: peer.localDescription });
}

async function onSignal(data) {
  if (data.description) {
    const peer = ensurePeer();
    await peer.setRemoteDescription(data.description);
    if (data.description.type === "offer") {
      await peer.setLocalDescription(await peer.createAnswer());
      sendSignal({ description: peer.localDescription });
    }
  } else if (data.candidate && pc) {
    try {
      await pc.addIceCandidate(data.candidate);
    } catch (err) {
      console.warn("ICE candidate rejected", err);
    }
  }
}

// ---------- transcript feed ----------

function fmtTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function bubble(speaker, label, text, extra = "") {
  const el = document.createElement("div");
  el.className = `msg ${speaker}${speaker === me ? " me" : ""} ${extra}`;
  const who = document.createElement("div");
  who.className = "who";
  const name = document.createElement("strong");
  name.textContent = speaker === me ? `${label} (you)` : label;
  who.append(name);
  const body = document.createElement("div");
  body.textContent = text;
  el.append(who, body);
  return { el, who };
}

function scrollFeed() {
  const feed = $("feed");
  feed.scrollTop = feed.scrollHeight;
}

function addMessage(m) {
  interimBubbles.get(m.speaker)?.remove();
  interimBubbles.delete(m.speaker);
  const { el, who } = bubble(m.speaker, m.label, m.text);
  const time = document.createElement("span");
  time.textContent = fmtTime(m.t);
  who.append(time);
  $("feed").append(el);
  scrollFeed();
}

function showInterim({ speaker, label, text }) {
  let el = interimBubbles.get(speaker);
  if (!text) {
    el?.remove();
    interimBubbles.delete(speaker);
    return;
  }
  if (!el) {
    el = bubble(speaker, label, text, "interim").el;
    interimBubbles.set(speaker, el);
    $("feed").append(el);
  }
  el.lastChild.textContent = text;
  scrollFeed();
}

// ---------- controls ----------

$("mute").onclick = () => {
  const track = localStream.getAudioTracks()[0];
  track.enabled = !track.enabled;
  $("mute").textContent = track.enabled ? "Mute" : "Unmute";
};

$("copy").onclick = async () => {
  const link = `${location.origin}/?room=${roomCode}`;
  await navigator.clipboard.writeText(link);
  $("copy").textContent = "Copied!";
  setTimeout(() => ($("copy").textContent = "Copy invite link"), 1500);
};

function leave() {
  const code = roomCode;
  roomCode = null; // stops onclose from reporting an error
  if (recorder && recorder.state !== "inactive") recorder.stop();
  recorder = null;
  closePeer();
  ws?.close();
  ws = null;
  localStream?.getTracks().forEach((t) => t.stop());
  localStream = null;
  mp3Element?.pause();
  mp3Element = null;
  audioCtx?.close();
  audioCtx = null;
  interimBubbles.clear();
  return code;
}

$("leave").onclick = () => {
  leave();
  $("call").hidden = true;
  $("feed-card").hidden = true;
  $("lobby").hidden = false;
  $("feed").replaceChildren();
  history.replaceState(null, "", location.pathname);
  setStatus("Not in a room");
};
