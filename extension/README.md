# Jev Email Scanner (Chrome extension)

Adds a **Scan with Jev** button to an open Gmail email. It checks the email the same
way the call room checks a live conversation: each line goes to Jev as the question
"does this ask for a code, a money transfer, or a way around independent
verification?", and the extension shows an overall risk and highlights the lines
that look like the request.

Jev gives an estimate from wording. It is not a verdict, and a low score does not
prove an email is safe. The evidence threshold is unvalidated (see
`docs/architecture.md`).

## Install (unpacked, for the demo)

1. Start the backend from the repo root: `just dev`
   - With `TYPESAFE_API_KEY` set in the process environment, scans use Jev.
   - Without it, the server falls back to the demo keyword rule (`code`, `money`,
     `transfer`) and the banner says so.
2. Open `chrome://extensions`, switch on **Developer mode**, click **Load unpacked**,
   and choose this `extension/` folder.
3. Open Gmail, open an email, and click **Scan with Jev**. A prompt asks you to
   confirm before anything is sent.

The default server is `http://127.0.0.1:8000`. To use another server, click the
extension icon to open settings, enter its URL, and press **Save** (Chrome asks for
permission to reach that host). Remote servers must use `https://`.

## What gets sent

Only after you click **Scan with Jev** and confirm, the extension sends up to 30 short
lines (500 characters each at most) from the open thread to your server, along with
each sender's address. The newest messages are used first. Quoted replies and
signatures are left out. The server does not store the text. The Typesafe key stays on
the server and is never in the extension.

To stop strangers using a public server, set `EMAIL_SCAN_TOKEN` in the server's
environment and enter the same value as the access token in settings.

## Server endpoint

`POST /api/emails/scan`, optionally with `Authorization: Bearer <EMAIL_SCAN_TOKEN>`:

```json
{ "lines": [{ "id": "l1", "sender": "boss@example.com", "text": "Send the code" }] }
```

Returns `{ "risk": 0.8, "evidenceIds": ["l1"], "provider": "jev" }`, where `provider` is
`jev` or `demo-rule`. `risk` is a probability from 0 to 1. Between 1 and 30 lines, each
up to 1000 characters, unknown fields are rejected with 422, and a provider failure
returns 503 (never a safe score).

## Files

| File | Job |
| --- | --- |
| `manifest.json` | Manifest V3; Gmail content script, service worker, settings page |
| `content.js` | Injects the button, confirmation prompt and result banner into Gmail |
| `lines.js` | Splits an email into lines and highlights flagged ones |
| `background.js` | Calls the server so the Gmail page never sees the URL or token |
| `options.*` | Server URL and token settings with a connection test |

## Limits

- **Gmail only.** Gmail's page markup is undocumented, so a Gmail redesign can stop
  the button appearing. The three selectors live at the top of `content.js`.
- Collapsed messages in a long thread are not scanned until you expand them.
- Highlights mark whole text pieces, not exact words.
- Text only: attachments, images and links are not checked.
