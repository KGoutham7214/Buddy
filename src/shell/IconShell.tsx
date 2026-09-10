import {
  useRef,
  type PointerEvent as ReactPointerEvent,
} from "react";
import MangaBubble from "../MangaBubble";
import { BuddyMark } from "../icons";
import { buddy } from "../api/buddyClient";
import type { ReminderAction, ReminderDef } from "../domain/types";
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
}: Props) {
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
      }`}
    >
      {activeReminder ? (
        <MangaBubble
          reminder={activeReminder}
          onAction={(action) => onReminderAction(action)}
          onClose={onReminderClose}
        />
      ) : null}
      <button
        className={`icon-orb color-${iconColor} ${recording ? "recording" : ""}`}
        aria-label={
          phase === "recording"
            ? `Recording ${formatElapsed(elapsed)} — click to open`
            : "Open Buddy"
        }
        title={
          phase === "recording"
            ? `Recording ${formatElapsed(elapsed)} — ${nowSpeakingLabel(
                liveSpeakerState,
                liveSpeaker
              )}`
            : phase === "processing"
              ? "Processing meeting…"
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
        <BuddyMark className="icon-mark" />
        {phase === "recording" && liveSpeakerTrail.length > 0 ? (
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
          <span className="icon-rec-time">{formatElapsed(elapsed)}</span>
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
