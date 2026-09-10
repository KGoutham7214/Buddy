import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { BuddyMark, IconMinus, IconSettings } from "../icons";
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
      </div>
    </div>
  );
}
