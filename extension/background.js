// Sends scan requests to the Jev server. This runs here, not in the Gmail page,
// so the page never sees the server URL or token and CORS does not apply.
const DEFAULTS = { serverUrl: "http://127.0.0.1:8000", token: "" };
const TIMEOUT_MS = 25000;

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only our own Gmail content script may ask for a scan.
  if (sender.id !== chrome.runtime.id || message?.type !== "jev-scan") return false;
  scan(message.lines).then(sendResponse);
  return true; // keep the channel open for the async reply
});

function describe(status, body) {
  const code = body?.error?.code;
  if (status === 401) return "The server rejected the access token. Check it in the extension settings.";
  if (status === 422) return "The server could not read this email. It may be too large.";
  if (code === "provider_unavailable") return "Jev could not be reached by the server. Try again in a moment.";
  return `The server returned an error (${status}).`;
}

async function scan(lines) {
  const stored = await chrome.storage.local.get(DEFAULTS);
  const serverUrl = stored.serverUrl.replace(/\/+$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${serverUrl}/api/emails/scan`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(stored.token ? { Authorization: `Bearer ${stored.token}` } : {}),
      },
      body: JSON.stringify({ lines }),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) return { ok: false, error: describe(response.status, body) };
    return { ok: true, data: body };
  } catch {
    return { ok: false, error: `Could not reach the Jev server at ${serverUrl}. Is it running?` };
  } finally {
    clearTimeout(timer);
  }
}
