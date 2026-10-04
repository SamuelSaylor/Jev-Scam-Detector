import { useLayoutEffect, useRef, useState } from "react";

// Presentation only: intervention thresholds always use the exact server value.
export function useAnimatedRisk(
  risk: number | null,
  assessmentId: string | undefined,
) {
  const shown = useRef(0);
  const lastId = useRef<string | undefined>(undefined);
  const [value, setValue] = useState(0);
  useLayoutEffect(() => {
    if (risk === null) return;
    const target = risk * 100;
    const reduce = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    if (reduce || lastId.current === assessmentId) {
      shown.current = target;
      setValue(target);
      lastId.current = assessmentId;
      return;
    }
    lastId.current = assessmentId;
    const from = shown.current;
    const started = performance.now();
    const duration = Math.min(700, 400 + Math.abs(target - from) * 4);
    let frame = 0;
    function update(now: number) {
      const progress = Math.min(1, (now - started) / duration);
      const eased = progress * progress * (3 - 2 * progress);
      shown.current = from + (target - from) * eased;
      setValue(shown.current);
      if (progress < 1) frame = requestAnimationFrame(update);
    }
    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, [risk, assessmentId]);
  return value;
}
