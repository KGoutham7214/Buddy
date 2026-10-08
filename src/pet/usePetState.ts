import { useEffect, useState } from "react";
import type { PetMotion } from "../domain/types";
import type { RecordPhase } from "../useMeetingRecorder";

export type PetPose =
  | "idle"
  | "listening"
  | "worried"
  | "waving"
  | "working"
  | "ready";

/** Highest priority first: recording, error, reminder, processing, note ready, idle. */
export function petPose(input: {
  phase: RecordPhase;
  error: string;
  reminder: boolean;
  noteReady: boolean;
}): PetPose {
  if (input.phase === "recording") return "listening";
  if (input.error) return "worried";
  if (input.reminder) return "waving";
  if (input.phase === "processing") return "working";
  if (input.noteReady) return "ready";
  return "idle";
}

export function usePrefersReducedMotion(petMotion: PetMotion): boolean {
  const [systemReduced, setSystemReduced] = useState(() => {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });

  useEffect(() => {
    if (!window.matchMedia) return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setSystemReduced(query.matches);
    onChange();
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  return petMotion === "reduced" || systemReduced;
}
