import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { BuddyMark, IconMinus, IconSettings } from "../icons";
import { buddy } from "../api/buddyClient";
import type { LiveSpeakerState, RecordPhase } from "../useMeetingRecorder";

type Tab = "notes" | "meet";

type Props = {
  theme: string;
  userName: string;
  recording: boolean;
  showMeetTab: boolean;
  tab: Tab;
  onTabChange: (tab: Tab) => void;
  phase: RecordPhase;
  elapsed: number;
  liveSpeaker: string;
  liveSpeakerState: LiveSpeakerState;
  formatElapsed: (seconds: number) => string;
  nowSpeakingLabel: (state: LiveSpeakerState, name: string) => string;
  onPanelDragDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onOpenSettings: () => void;
  onCollapse: () => void;
  children: ReactNode;
  settings: ReactNode;
};

export default function PanelShell({
  theme,
  userName,
  recording,
  showMeetTab,
  tab,
  onTabChange,
  phase,
  elapsed,
  liveSpeaker,
  liveSpeakerState,
  formatElapsed,
  nowSpeakingLabel,
  onPanelDragDown,
  onOpenSettings,
  onCollapse,
  children,
  settings,
}: Props) {
  return (
    <div className={`app-shell theme-${theme}`}>
      <div className="panel">
        <div className="titlebar" onPointerDown={onPanelDragDown}>
          <div className="titlebar-brand">
            <div className={`brand-dot ${recording ? "recording" : ""}`}>
              <BuddyMark />
            </div>
            <span className="brand-name">
              Buddy
              {userName ? (
                <span className="brand-user"> · {userName}</span>
              ) : null}
            </span>
            {phase === "recording" ? (
              <span className="title-rec">
                REC {formatElapsed(elapsed)}
                {` · ${
                  liveSpeakerState === "name" && liveSpeaker
                    ? `Now: ${liveSpeaker}`
                    : nowSpeakingLabel(liveSpeakerState, liveSpeaker)
                }`}
              </span>
            ) : null}
          </div>
          <div className="titlebar-actions">
            <button
              className="icon-btn"
              title="Settings"
              aria-label="Settings"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onOpenSettings();
              }}
            >
              <IconSettings />
            </button>
            <button
              className="icon-btn"
              title="Minimize to icon (recording continues)"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={onCollapse}
            >
              <IconMinus />
            </button>
          </div>
        </div>

        <div className="tabs">
          <button
            className={`tab ${tab === "notes" ? "active" : ""}`}
            onClick={() => onTabChange("notes")}
          >
            Notes
          </button>
          {showMeetTab ? (
            <button
              className={`tab ${tab === "meet" ? "active" : ""}`}
              onClick={() => onTabChange("meet")}
            >
              Meet
              {phase === "recording" ? (
                <span className="tab-rec-dot" aria-hidden />
              ) : null}
            </button>
          ) : null}
        </div>

        {children}
        {settings}
        <PanelResizeGrip />
      </div>
    </div>
  );
}

/** Transparent windows get no native resize frame; this grip resizes via IPC. */
function PanelResizeGrip() {
  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.screenX;
    const startY = e.screenY;
    const startW = window.innerWidth;
    const startH = window.innerHeight;

    const onMove = (ev: PointerEvent) => {
      buddy.resizePanel({
        width: startW + (ev.screenX - startX),
        height: startH + (ev.screenY - startY),
      });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  return (
    <div
      className="panel-resize-grip"
      title="Resize"
      onPointerDown={onPointerDown}
    >
      <svg viewBox="0 0 10 10" aria-hidden>
        <path d="M9 1 1 9 M9 5 5 9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" fill="none" />
      </svg>
    </div>
  );
}
