// Adds a "Scan with Jev" button to an open Gmail thread. Nothing is read or sent
// until the user clicks it and confirms. Email text is untrusted: everything we
// render uses textContent, never innerHTML.

// Gmail's markup is undocumented; if Gmail changes, fix these selectors only.
const SELECTORS = {
  message: ".adn", // one message in an open thread
  body: ".a3s", // the message text (absent while a message is collapsed)
  sender: ".gD", // sender name; has an `email` attribute
};
const MAX_LINES = 30; // matches the server limit
const HIGH = 0.7;
const MEDIUM = 0.4;
const DEFAULT_SERVER = "http://127.0.0.1:8000";

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

let bar = null;
let output = null; // holds the result banner under the bar

// ---------- reading the thread ----------

function openMessages() {
  return [...document.querySelectorAll(SELECTORS.message)]
    .map((message) => ({ message, body: message.querySelector(SELECTORS.body) }))
    .filter((entry) => entry.body)
    .map(({ message, body }) => {
      const sender = message.querySelector(SELECTORS.sender);
      return {
        body,
        sender: sender?.getAttribute("email") || sender?.textContent?.trim() || "unknown",
      };
    });
}

// Newest messages first until the line budget is spent, then back to reading order.
function collect() {
  const lines = [];
  for (const { body, sender } of openMessages().reverse()) {
    const room = MAX_LINES - lines.length;
    if (room <= 0) break;
    const taken = JevLines.extract(body)
      .slice(0, room)
      .map((line) => ({ ...line, sender }));
    lines.unshift(...taken);
  }
  return lines.map((line, index) => ({ ...line, id: `l${index + 1}` }));
}

// ---------- confirmation prompt ----------

function confirmScan(serverUrl, lineCount) {
  return new Promise((resolve) => {
    const overlay = el("div", "jev-ui jev-overlay");
    const dialog = el("div", "jev-dialog");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    const scan = el("button", "jev-btn jev-primary", "Scan email");
    const cancel = el("button", "jev-btn", "Cancel");
    const actions = el("div", "jev-actions");
    actions.append(cancel, scan);
    const plural = lineCount === 1 ? "" : "s";
    dialog.append(
      el("h2", "", "Scan this email with Jev?"),
      el(
        "p",
        "",
        `${lineCount} line${plural} of text from the open email will be sent to ${serverUrl} to be checked. Quoted replies and signatures are left out.`,
      ),
      el("p", "jev-small", "Jev gives an estimate from the wording. It cannot confirm whether an email is real."),
      actions,
    );
    overlay.append(dialog);

    const done = (answer) => {
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      resolve(answer);
    };
    const onKey = (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        done(false);
      }
    };
    scan.onclick = () => done(true);
    cancel.onclick = () => done(false);
    overlay.onclick = (event) => event.target === overlay && done(false);
    document.addEventListener("keydown", onKey, true);
    document.body.append(overlay);
    scan.focus();
  });
}

// ---------- results ----------

function valid(data) {
  return (
    data &&
    typeof data.risk === "number" &&
    data.risk >= 0 &&
    data.risk <= 1 &&
    Array.isArray(data.evidenceIds) &&
    data.evidenceIds.every((id) => typeof id === "string") &&
    typeof data.provider === "string"
  );
}

function showMessage(text, kind) {
  output.replaceChildren(el("div", `jev-banner jev-${kind}`, text));
}

function clearResult() {
  JevLines.clear(document.body);
  output?.replaceChildren();
}

function showResult(data, lines) {
  const level = data.risk >= HIGH ? "high" : data.risk >= MEDIUM ? "medium" : "low";
  const label = { high: "High risk", medium: "Be careful", low: "Low risk" }[level];
  const percent = Math.round(data.risk * 100);

  const flagged = data.evidenceIds
    .map((id) => lines.find((line) => line.id === id))
    .filter(Boolean);
  for (const line of flagged) JevLines.highlight(line, line.id);

  const banner = el("div", `jev-banner jev-${level}`);
  const head = el("div", "jev-head");
  const close = el("button", "jev-close", "×");
  close.setAttribute("aria-label", "Dismiss Jev result");
  close.onclick = clearResult;
  head.append(el("strong", "jev-label", `${label} · ${percent}%`), close);
  banner.append(head);

  const caveat =
    data.provider === "jev"
      ? "Jev's estimate of whether this email asks for a code, a money transfer or skipped verification. It is not a verdict."
      : "Demo mode: a simple keyword rule, not Jev. Set TYPESAFE_API_KEY on the server for real checks.";
  banner.append(el("p", "jev-small", caveat));

  if (flagged.length) {
    const list = el("ul", "jev-evidence");
    for (const line of flagged) {
      const shown = line.text.length > 160 ? `${line.text.slice(0, 157)}…` : line.text;
      const jump = el("button", "jev-link", `“${shown}”`);
      jump.onclick = () =>
        document
          .querySelector(`mark.jev-flag[data-jev-line="${line.id}"]`)
          ?.scrollIntoView({ block: "center", behavior: "smooth" });
      const item = el("li");
      item.append(jump);
      list.append(item);
    }
    banner.append(el("p", "jev-small", "Lines that look like the request:"), list);
  } else {
    banner.append(el("p", "jev-small", "No specific lines were flagged. A low score does not prove an email is safe."));
  }
  output.replaceChildren(banner);
}

// ---------- the scan flow ----------

async function run(button) {
  JevLines.clear(document.body);
  const lines = collect();
  if (!lines.length) {
    showMessage("Jev could not find any readable text in the open email.", "info");
    return;
  }
  const { serverUrl } = await chrome.storage.local.get({ serverUrl: DEFAULT_SERVER });
  if (!(await confirmScan(serverUrl, lines.length))) {
    JevLines.clear(document.body); // extracting may have split text nodes
    return;
  }

  button.disabled = true;
  button.textContent = "Scanning…";
  showMessage("Asking Jev…", "info");
  try {
    const reply = await chrome.runtime.sendMessage({
      type: "jev-scan",
      lines: lines.map(({ id, sender, text }) => ({ id, sender, text })),
    });
    if (!reply?.ok) showMessage(reply?.error ?? "The scan failed.", "error");
    else if (!valid(reply.data)) showMessage("The server sent a reply Jev could not understand.", "error");
    else showResult(reply.data, lines);
  } catch {
    showMessage("The extension was reloaded. Refresh this Gmail tab and try again.", "error");
  } finally {
    button.disabled = false;
    button.textContent = "Scan with Jev";
  }
}

// ---------- injecting into Gmail ----------

function inject(anchor) {
  bar = el("div", "jev-ui jev-bar");
  bar.dataset.thread = location.hash;
  const button = el("button", "jev-btn jev-primary", "Scan with Jev");
  button.onclick = () => void run(button);
  output = el("div", "jev-output");
  output.setAttribute("aria-live", "polite");
  bar.append(button, el("span", "jev-small", "Checks this email for requests for codes or money"), output);
  anchor.parentElement.insertBefore(bar, anchor);
}

function sync() {
  const body = document.querySelector(`${SELECTORS.message} ${SELECTORS.body}`);
  const first = body?.closest(SELECTORS.message);
  if (!first) {
    bar?.remove();
    bar = null;
    return;
  }
  if (bar?.isConnected && bar.dataset.thread === location.hash && first.parentElement.contains(bar)) return;
  bar?.remove();
  JevLines.clear(document.body);
  inject(first);
}

let pending = 0;
new MutationObserver(() => {
  clearTimeout(pending);
  pending = setTimeout(sync, 300); // Gmail mutates constantly; wait for it to settle
}).observe(document.body, { childList: true, subtree: true });
sync();
