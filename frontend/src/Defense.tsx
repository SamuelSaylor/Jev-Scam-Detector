import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Defense, Lockout, Segment, TrustedContact } from "./protocol";
import { percentage } from "./assessment-view";

export function TrustedContactSettings({
  contact,
  enabled,
  onSave,
}: {
  contact: TrustedContact | null;
  enabled: boolean;
  onSave: (contact: TrustedContact | null) => Promise<void>;
}) {
  const [name, setName] = useState(contact?.name ?? "");
  const [email, setEmail] = useState(contact?.email ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    setName(contact?.name ?? "");
    setEmail(contact?.email ?? "");
  }, [contact]);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSaving(true);
    try {
      await onSave({ name: name.trim(), email: email.trim() });
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Contact could not be saved.",
      );
    } finally {
      setSaving(false);
    }
  }
  return (
    <details className="contact-settings">
      <summary>Trusted contact{contact ? ` · ${contact.name}` : ""}</summary>
      <form onSubmit={(event) => void save(event)}>
        <label htmlFor="contact-name">Name</label>
        <input
          id="contact-name"
          value={name}
          maxLength={80}
          required
          disabled={!enabled || saving}
          onChange={(event) => setName(event.target.value)}
        />
        <label htmlFor="contact-email">Email</label>
        <input
          id="contact-email"
          type="email"
          value={email}
          maxLength={254}
          required
          disabled={!enabled || saving}
          onChange={(event) => setEmail(event.target.value)}
        />
        <p>Used only to prepare an email you choose to send.</p>
        <div className="contact-actions">
          <button type="submit" disabled={!enabled || saving || !name.trim()}>
            {saving ? "Saving…" : "Save contact"}
          </button>
          {contact && (
            <button
              type="button"
              disabled={!enabled || saving}
              onClick={() => {
                setSaving(true);
                setError("");
                void onSave(null)
                  .catch((failure) =>
                    setError(
                      failure instanceof Error
                        ? failure.message
                        : "Contact could not be removed.",
                    ),
                  )
                  .finally(() => setSaving(false));
              }}
            >
              Remove contact
            </button>
          )}
        </div>
        {error && <p role="alert">{error}</p>}
      </form>
    </details>
  );
}

export function DefenseWarning({
  defense,
  current,
  evidence,
  onEvidence,
}: {
  defense: Defense | undefined;
  current: boolean;
  evidence: Segment[];
  onEvidence: (id: string) => void;
}) {
  if (!defense || !current || defense.tier === "monitor" || defense.lockout)
    return null;
  const contactTier = defense.tier === "contact" || defense.tier === "lockout";
  const subject = "Please help me check a suspicious conversation";
  const body = `I would like your help reviewing a possible scam.\n\nIndicators flagged by Jev:\n${defense.reasons.map((reason) => `- ${reason}`).join("\n")}\n\nThis is an estimate, not proof of fraud. Please contact me independently.`;
  const draft = defense.trustedContact
    ? `mailto:${encodeURIComponent(defense.trustedContact.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
    : null;
  return (
    <section
      className={`defense-warning tier-${defense.tier}`}
      aria-labelledby="warning-title"
    >
      <h2 id="warning-title">
        {contactTier ? "ASK SOMEONE YOU TRUST" : "POSSIBLE SCAM"}
      </h2>
      <ul>
        {defense.reasons.map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>
      <p>
        Verify the sender independently. Avoid sharing personal information,
        payments, or unverified links.
      </p>
      {contactTier &&
        (draft ? (
          <>
            <a className="contact-draft" href={draft}>
              Prepare email to {defense.trustedContact?.name}
            </a>
            <small>Opens your email app. Nothing is sent automatically.</small>
          </>
        ) : (
          <p>
            No trusted contact configured. Contact someone you trust or add one
            below.
          </p>
        ))}
      {evidence.length > 0 && (
        <div className="warning-evidence">
          {evidence.slice(-3).map((line) => (
            <button
              type="button"
              key={line.id}
              onClick={() => onEvidence(line.id)}
            >
              {line.text} ↗
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

export function SafetyReview({
  hold,
  segments,
  onContinue,
  onEnd,
}: {
  hold: Lockout;
  segments: Segment[];
  onContinue: (id: string) => Promise<void>;
  onEnd: () => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement | null>(null);
  const title = useRef<HTMLHeadingElement | null>(null);
  const [seconds, setSeconds] = useState(5);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const node = dialog.current;
    const previousFocus = document.activeElement;
    node?.showModal();
    title.current?.focus();
    const started = performance.now();
    function tick() {
      const remaining = Math.max(
        0,
        Math.ceil((5000 - (performance.now() - started)) / 1000),
      );
      setSeconds(remaining);
      if (!remaining) clearInterval(timer);
    }
    const timer = setInterval(tick, 100);
    tick();
    return () => {
      clearInterval(timer);
      node?.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected)
        previousFocus.focus();
    };
  }, [hold.id]);
  async function proceed() {
    if (seconds || busy) return;
    setBusy(true);
    setError("");
    try {
      await onContinue(hold.id);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not acknowledge the warning. Try again or end the call.",
      );
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="safety-review"
      aria-labelledby="review-title"
      aria-describedby="review-context"
      onCancel={(event) => event.preventDefault()}
    >
      <span className="stamp">TEMPORARY PAUSE</span>
      <h2 id="review-title" ref={title} tabIndex={-1}>
        REVIEW BEFORE CONTINUING
      </h2>
      <p id="review-context">
        {percentage(hold.risk)} estimated risk · {percentage(hold.confidence)}{" "}
        model confidence in the evidence rating, not proof of fraud. Accumulated
        risk is not a calibrated fraud probability. Possible scam, not a
        confirmed verdict. In-app audio and submissions are paused.
      </p>
      <h3>Warning signs</h3>
      <ul>
        {hold.reasons.map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>
      <h3>Cited conversation</h3>
      <ul className="hold-evidence">
        {hold.evidenceSegmentIds.map((id) => {
          const line = segments.find((segment) => segment.id === id);
          return (
            <li key={id}>
              {line ? (
                <>
                  <strong>
                    {line.speaker === "host" ? "Host" : "Guest"} ·{" "}
                    {line.source === "manual" ? "Typed" : "Transcribed audio"}
                  </strong>
                  <p>{line.text}</p>
                </>
              ) : (
                "Cited line unavailable"
              )}
            </li>
          );
        })}
      </ul>
      <p>
        Money, account access, or personal information may be at risk. Stop
        sharing codes or payment details. Find the organization's official
        number yourself, or ask a trusted person before acting.
      </p>
      <div className="review-actions">
        <button type="button" onClick={() => void onEnd()}>
          End call for everyone
        </button>
        <button
          className="primary"
          type="button"
          disabled={seconds > 0 || busy}
          onClick={() => void proceed()}
        >
          {seconds > 0
            ? `Review for ${seconds}s`
            : busy
              ? "Saving acknowledgment…"
              : "I understand the risks · Continue conversation"}
        </button>
      </div>
      <p className="review-countdown" role="status">
        {seconds > 0
          ? "Acknowledgment unlocks after five seconds."
          : "You may continue by acknowledging the risks. Transcription stays off."}
      </p>
      {error && <p role="alert">{error}</p>}
    </dialog>
  );
}
