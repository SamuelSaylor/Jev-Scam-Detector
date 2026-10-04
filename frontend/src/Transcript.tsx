import {
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { Membership, Segment } from "./protocol";

export type TranscriptHandle = { jumpTo: (id: string) => void };
type FollowMode = "following" | "reading";

function elapsed(milliseconds: number) {
  const seconds = Math.floor(milliseconds / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export const Transcript = forwardRef<
  TranscriptHandle,
  { segments: Segment[]; role: Membership["role"]; evidenceIds: string[] }
>(function Transcript({ segments, role, evidenceIds }, ref) {
  const viewport = useRef<HTMLDivElement>(null);
  const follow = useRef<FollowMode>("following");
  const [mode, setMode] = useState<FollowMode>("following");
  const anchor = useRef<{ id: string; offset: number } | null>(null);
  const size = useRef<{ width: number; height: number } | null>(null);
  const evidence = new Set(evidenceIds);

  function setFollow(next: FollowMode) {
    follow.current = next;
    setMode(next);
  }
  function readHistory() {
    const node = viewport.current;
    if (node && node.scrollHeight > node.clientHeight) setFollow("reading");
  }
  function latest() {
    const node = viewport.current;
    if (!node) return;
    anchor.current = null;
    setFollow("following");
    node.focus({ preventScroll: true });
    node.scrollTo({ top: node.scrollHeight, behavior: "instant" });
  }
  useImperativeHandle(
    ref,
    () => ({
      jumpTo(id) {
        const node = viewport.current;
        const target = [
          ...(node?.querySelectorAll<HTMLElement>("[data-segment-id]") ?? []),
        ].find((item) => item.dataset.segmentId === id);
        if (!node || !target) return;
        setFollow("reading");
        node.scrollTo({
          top:
            node.scrollTop +
            target.getBoundingClientRect().top -
            node.getBoundingClientRect().top,
          behavior: "instant",
        });
        target.focus({ preventScroll: true });
      },
    }),
    [],
  );
  function restorePosition() {
    const node = viewport.current;
    if (!node) return;
    size.current = { width: node.clientWidth, height: node.clientHeight };
    if (follow.current === "following")
      node.scrollTo({ top: node.scrollHeight, behavior: "instant" });
    else if (anchor.current) {
      const target = [
        ...node.querySelectorAll<HTMLElement>("[data-segment-id]"),
      ].find((item) => item.dataset.segmentId === anchor.current?.id);
      if (target)
        node.scrollTo({
          top:
            node.scrollTop +
            target.getBoundingClientRect().top -
            node.getBoundingClientRect().top -
            anchor.current.offset,
          behavior: "instant",
        });
    }
  }
  useLayoutEffect(restorePosition, [segments]);
  useLayoutEffect(() => {
    const node = viewport.current;
    if (!node) return;
    const observer = new ResizeObserver(restorePosition);
    observer.observe(node);
    if (node.firstElementChild) observer.observe(node.firstElementChild);
    return () => observer.disconnect();
  }, [segments.length === 0]);
  function onScroll() {
    const node = viewport.current;
    if (!node) return;
    if (
      size.current &&
      (size.current.width !== node.clientWidth ||
        size.current.height !== node.clientHeight)
    ) {
      restorePosition();
      return;
    }
    if (follow.current === "following") {
      restorePosition();
      return;
    }
    const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 8;
    if (atBottom) {
      anchor.current = null;
      setFollow("following");
      return;
    }
    setFollow("reading");
    const first = [
      ...node.querySelectorAll<HTMLElement>("[data-segment-id]"),
    ].find(
      (item) =>
        item.getBoundingClientRect().bottom > node.getBoundingClientRect().top,
    );
    anchor.current = first
      ? {
          id: first.dataset.segmentId ?? "",
          offset:
            first.getBoundingClientRect().top -
            node.getBoundingClientRect().top,
        }
      : null;
  }
  return (
    <section className="transcript" aria-labelledby="timeline-title">
      <div className="section-heading">
        <h2 id="timeline-title">Transcript</h2>
        <span>{segments.length} lines</span>
      </div>
      <div
        className="transcript-viewport"
        ref={viewport}
        tabIndex={0}
        role="region"
        aria-label="Shared transcript"
        onScroll={onScroll}
        onWheel={(event) => {
          if (event.deltaY < 0 || follow.current === "reading") readHistory();
        }}
        onTouchMove={readHistory}
        onPointerDown={(event) => {
          if (
            event.clientX >=
            event.currentTarget.getBoundingClientRect().left +
              event.currentTarget.clientWidth
          )
            readHistory();
        }}
        onKeyDown={(event) => {
          const node = event.currentTarget;
          const positions = new Map([
            ["Home", 0],
            ["End", node.scrollHeight],
            ["ArrowUp", node.scrollTop - 40],
            ["ArrowDown", node.scrollTop + 40],
            ["PageUp", node.scrollTop - node.clientHeight],
            ["PageDown", node.scrollTop + node.clientHeight],
            [
              " ",
              node.scrollTop +
                (event.shiftKey ? -node.clientHeight : node.clientHeight),
            ],
          ]);
          const top = positions.get(event.key);
          if (top === undefined) return;
          event.preventDefault();
          if (top >= node.scrollHeight - node.clientHeight) latest();
          else {
            setFollow("reading");
            node.scrollTo({ top, behavior: "instant" });
          }
        }}
      >
        {segments.length ? (
          <ol className="timeline">
            {segments.map((segment) => (
              <li
                key={segment.id}
                data-segment-id={segment.id}
                tabIndex={-1}
                className={`${segment.speaker === role ? "local" : "remote"} ${evidence.has(segment.id) ? "evidence-line" : ""}`}
              >
                <div className="bubble-meta">
                  <strong className="speaker">
                    {segment.speaker === role
                      ? `You (${role})`
                      : segment.speaker === "host"
                        ? "Host"
                        : "Guest"}
                  </strong>
                  <span>
                    {segment.source === "manual" ? "typed" : "transcribed"} ·{" "}
                    <time>{elapsed(segment.startMs)}</time>
                  </span>
                </div>
                <p>{segment.text}</p>
                {evidence.has(segment.id) && (
                  <span className="evidence-tag">Referenced evidence</span>
                )}
              </li>
            ))}
          </ol>
        ) : (
          <p className="empty">No lines yet. Add a typed line below.</p>
        )}
      </div>
      {mode === "reading" && (
        <button className="latest-messages" type="button" onClick={latest}>
          Latest messages
        </button>
      )}
    </section>
  );
});
