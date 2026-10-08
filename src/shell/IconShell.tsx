import {
  useRef,
  type PointerEvent as ReactPointerEvent,
} from "react";
import MangaBubble from "../MangaBubble";
import { BuddyMark } from "../icons";
import { buddy } from "../api/buddyClient";
import type { PetId, PetMotion, ReminderAction, ReminderDef } from "../domain/types";
import Pip from "../pet/Pip";
import { petPose, usePrefersReducedMotion } from "../pet/usePetState";
import type { LiveSpeakerState, RecordPhase } from "../useMeetingRecorder";

type Props = {
  iconColor: string;
  recording: boolean;
  phase: RecordPhase;
  elapsed: number;
  liveSpeaker: string;
  liveSpeakerState: LiveSpeakerState;
  liveSpeakerTrail: string[];
  activeReminder: ReminderDef | null;
  formatElapsed: (seconds: number) => string;
  nowSpeakingLabel: (state: LiveSpeakerState, name: string) => string;
  speakerColor: (name: string) => string;
  onOpen: () => void;
  onReminderAction: (action: ReminderAction) => void;
  onReminderClose: () => void;
  petId: PetId;
  petMotion: PetMotion;
  error: string;
  status: string;
  noteReady: boolean;
};

export default function IconShell({
  iconColor,
  recording,
  phase,
  elapsed,
  liveSpeaker,
  liveSpeakerState,
  liveSpeakerTrail,
  activeReminder,
  formatElapsed,
  nowSpeakingLabel,
  speakerColor,
  onOpen,
  onReminderAction,
  onReminderClose,
  petId,
  petMotion,
  error,
  status,
  noteReady,
}: Props) {
  const pose = petPose({
    phase,
    error,
    reminder: Boolean(activeReminder),
    noteReady,
  });
  const reducedMotion = usePrefersReducedMotion(petMotion);
  const petMode = petId === "pip";
  const processingLabel =
    phase === "processing" && status ? status : "Processing meeting…";
  const dragRef = useRef<{
    startX: number;
    startY: number;
    moved: boolean;
  } | null>(null);

  function onIconPointerDown(e: ReactPointerEvent<HTMLButtonElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);

    dragRef.current = {
      startX: e.screenX,
      startY: e.screenY,
      moved: false,
    };
    buddy.dragStart({ screenX: e.screenX, screenY: e.screenY });

    const onMove = (ev: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const dx = Math.abs(ev.screenX - drag.startX);
      const dy = Math.abs(ev.screenY - drag.startY);
      if (dx > 6 || dy > 6) {
        drag.moved = true;
      }
      if (drag.moved) {
        buddy.dragMove({ screenX: ev.screenX, screenY: ev.screenY });
      }
    };

    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      const drag = dragRef.current;
      dragRef.current = null;
      buddy.dragEnd();
      try {
        e.currentTarget.releasePointerCapture(ev.pointerId);
      } catch {
        /* already released */
      }
      if (drag && !drag.moved) {
        onOpen();
      }
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  return (
    <div
      className={`collapsed-root color-${iconColor} ${recording ? "recording" : ""} ${
        activeReminder ? "with-bubble" : ""
      } ${petMode ? "pet-mode" : ""}`}
    >
      {activeReminder ? (
        <MangaBubble
          reminder={activeReminder}
          onAction={(action) => onReminderAction(action)}
          onClose={onReminderClose}
        />
      ) : null}
      <button
        className={`icon-orb color-${iconColor} ${recording ? "recording" : ""} ${
          petMode ? "pet-mode" : ""
        }`}
        aria-label={
          phase === "recording"
            ? `Recording ${formatElapsed(elapsed)} — click to open`
            : "Open Buddy"
        }
        /* No tooltip in pet mode — it pops over the bare desktop and reads as
           stray floating text. The aria-label keeps it accessible. */
        title={
          petMode
            ? undefined
            : phase === "recording"
              ? `Recording ${formatElapsed(elapsed)} — ${nowSpeakingLabel(
                  liveSpeakerState,
                  liveSpeaker
                )}`
              : phase === "processing"
                ? processingLabel
                : error
                  ? error
                  : "Open Buddy"
        }
        onPointerDown={onIconPointerDown}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          buddy.showIconMenu({
            phase,
            x: Math.round(e.clientX),
            y: Math.round(e.clientY),
          });
        }}
      >
        {petId === "pip" ? (
          <Pip pose={pose} reducedMotion={reducedMotion} />
        ) : (
          <BuddyMark className="icon-mark" />
        )}
        {phase === "recording" && !petMode && liveSpeakerTrail.length > 0 ? (
          <span className="icon-speaker-strip" aria-hidden>
            {liveSpeakerTrail.map((name) => (
              <span
                key={name}
                className={`icon-speaker-box ${
                  liveSpeakerState === "name" && liveSpeaker === name
                    ? "active"
                    : ""
                }`}
                style={{ background: speakerColor(name) }}
              />
            ))}
          </span>
        ) : null}
        {phase === "recording" ? (
          petMode ? (
            <span className="pet-pill" aria-hidden>
              <span className="pet-pill-dot" />
              {formatElapsed(elapsed)}
            </span>
          ) : (
            <span className="icon-rec-time">{formatElapsed(elapsed)}</span>
          )
        ) : null}
        {phase === "processing" && status ? (
          <span className={petMode ? "pet-pill" : "icon-status"}>
            {petMode ? "…" : status}
          </span>
        ) : null}
      </button>
    </div>
  );
}

export function usePanelDragHandlers() {
  function onPanelDragDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest("button, input, textarea, a")) return;

    e.preventDefault();
    buddy.dragStart({ screenX: e.screenX, screenY: e.screenY });

    const onMove = (ev: PointerEvent) => {
      buddy.dragMove({ screenX: ev.screenX, screenY: ev.screenY });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      buddy.dragEnd();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  return { onPanelDragDown };
}
