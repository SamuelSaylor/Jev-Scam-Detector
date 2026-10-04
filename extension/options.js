const DEFAULTS = { serverUrl: "http://127.0.0.1:8000", token: "" };
const $ = (id) => document.getElementById(id);

function say(text, kind = "") {
  $("status").textContent = text;
  $("status").className = kind;
}

const isLocal = (url) => ["127.0.0.1", "localhost"].includes(url.hostname);

// Returns the parsed server URL, or null after showing why it was rejected.
function readServerUrl() {
  let url;
  try {
    url = new URL($("server").value.trim() || DEFAULTS.serverUrl);
  } catch {
    say("That is not a valid URL.", "bad");
    return null;
  }
  const secure = url.protocol === "https:" || (url.protocol === "http:" && isLocal(url));
  if (!secure) {
    say("Use https:// so your email text is encrypted in transit (http:// is only allowed for localhost).", "bad");
    return null;
  }
  return url;
}

async function load() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  $("server").value = stored.serverUrl;
  $("token").value = stored.token;
}

$("save").onclick = async () => {
  const url = readServerUrl();
  if (!url) return;
  const origins = [`${url.origin}/*`];
  // Ask once for permission to talk to this server (localhost is built in).
  if (!(await chrome.permissions.contains({ origins }))) {
    if (!(await chrome.permissions.request({ origins }))) {
      say("Permission to reach that server was not granted.", "bad");
      return;
    }
  }
  await chrome.storage.local.set({ serverUrl: url.origin, token: $("token").value.trim() });
  $("server").value = url.origin;
  say("Saved.", "ok");
};

$("test").onclick = async () => {
  const url = readServerUrl();
  if (!url) return;
  say("Testing…");
  try {
    const response = await fetch(`${url.origin}/api/health`);
    const body = await response.json();
    if (body.status === "ok") say(`Connected to Jev server v${body.version}.`, "ok");
    else say("The server answered, but it does not look like a Jev server.", "bad");
  } catch {
    say("Could not reach the server. Is it running, and has its URL been saved?", "bad");
  }
};

void load();
