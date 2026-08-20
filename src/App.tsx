import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import NotesView from "./NotesView";
import MeetView from "./MeetView";
import MangaBubble from "./MangaBubble";
import { useMeetingRecorder, nowSpeakingLabel } from "./useMeetingRecorder";
import {
  materializeReminder,
  reminderFromTask,
  REMINDER_CATALOG,
  type ReminderAction,
  type ReminderDef,
} from "./reminderCatalog";
import type { PendingReminderRef } from "./vite-env";
import { BuddyMark, IconMinus } from "./icons";

type Mode = "icon" | "panel";
type Tab = "notes" | "meet";

function formatElapsed(seconds: number) {
  const m = Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0");
  const s = (seconds % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

const SPEAKER_COLORS = ["#6e9bb8", "#8fad8a", "#d08a6a", "#d08a98", "#8a919c"];

function speakerColor(name: string) {
  const text = String(name || "");
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0;
  }
  const idx = Math.abs(hash) % SPEAKER_COLORS.length;
  return SPEAKER_COLORS[idx];
}

function resolveReminder(pending: PendingReminderRef): ReminderDef | null {
  if (pending.kind === "task" && pending.taskId) {
    return reminderFromTask(pending.taskId, pending.title || "this task");
  }
  const def = REMINDER_CATALOG.find((r) => r.id === pending.id);
  return def ? materializeReminder(def) : null;
}

export default function App() {
  const [mode, setMode] = useState<Mode>("icon");
  const [iconColor, setIconColor] = useState("sand");
  const [tab, setTab] = useState<Tab>("notes");
  const [activeReminder, setActiveReminder] = useState<ReminderDef | null>(
    null
  );
  const recorder = useMeetingRecorder();
  const recording =
    recorder.phase === "recording" || recorder.phase === "processing";
  const dragRef = useRef<{
    startX: number;
    startY: number;
    moved: boolean;
  } | null>(null);

  useEffect(() => {
    if (!window.buddy) return;
    void window.buddy.getState().then((s) => {
      setMode(s.mode === "panel" ? "panel" : "icon");
      if (s.iconColor) setIconColor(s.iconColor);
    });
    const offMode = window.buddy.onModeChange((value) => {
      setMode(value === "panel" ? "panel" : "icon");
    });
    const offColor = window.buddy.onIconColor((color) => {
      setIconColor(color);
    });
    return () => {
      offMode();
      offColor();
    };
  }, []);

  useEffect(() => {
    if (!window.buddy) return;
    return window.buddy.onIconMenuAction((action) => {
      if (action === "record") {
        void recorder.startRecording();
        return;
      }
      if (action === "stop") {
        void recorder.stopRecording().then((noteId) => {
          if (noteId) void openPanel("meet");
        });
        return;
      }
      if (action === "cancel") {
        recorder.cancelRecording();
        return;
      }
      if (action === "open") {
        void openPanel(recording ? "meet" : undefined);
      }
    });
  }, [recorder, recording]);

  useEffect(() => {
    if (!window.buddy || recording) return;
    let cancelled = false;

    async function loadReminder() {
      const pending = await window.buddy.listPendingReminders();
      if (cancelled) return;
      if (pending.length === 0) {
        setActiveReminder(null);
        if (mode === "icon") await window.buddy.setReminderBubble(false);
        return;
      }
      const next = resolveReminder(pending[0]);
      if (!next || cancelled) return;
      if (mode === "panel" && pending[0].kind === "task") {
        await window.buddy.setMode("icon");
        return;
      }
      if (mode !== "icon") return;
      setActiveReminder(next);
      await window.buddy.setReminderBubble(true);
      await window.buddy.markReminderShown(next.id);
    }

    void loadReminder();
    const timer = window.setInterval(() => void loadReminder(), 20000);
    const offDue = window.buddy.onReminderDue(() => void loadReminder());
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      offDue();
    };
  }, [mode, recording]);

  async function dismissActiveReminder() {
    if (!activeReminder) return;
    const id = activeReminder.id;
    setActiveReminder(null);
    await window.buddy.dismissReminder(id);
  }

  async function handleReminderAction(action: ReminderAction) {
    if (action.type === "dismiss") {
      await dismissActiveReminder();
      return;
    }
    if (action.type === "open-notes") {
      await dismissActiveReminder();
      await openPanel("notes");
      return;
    }
    if (action.type === "open-meet") {
      await dismissActiveReminder();
      await openPanel("meet");
      return;
    }
    if (action.type === "snooze") {
      if (!activeReminder) return;
      const id = activeReminder.id;
      setActiveReminder(null);
      await window.buddy.snoozeReminder(id, 1);
    }
  }

  async function openPanel(nextTab?: Tab) {
    if (activeReminder) {
      setActiveReminder(null);
      await window.buddy.setReminderBubble(false);
    }
    if (nextTab) setTab(nextTab);
    else if (recording) setTab("meet");
    await window.buddy.setMode("panel");
  }

  async function collapse() {
    await window.buddy.setMode("icon");
  }

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
    window.buddy.dragStart({ screenX: e.screenX, screenY: e.screenY });

    const onMove = (ev: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const dx = Math.abs(ev.screenX - drag.startX);
      const dy = Math.abs(ev.screenY - drag.startY);
      if (dx > 6 || dy > 6) {
        drag.moved = true;
      }
      if (drag.moved) {
        window.buddy.dragMove({ screenX: ev.screenX, screenY: ev.screenY });
      }
    };

    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      const drag = dragRef.current;
      dragRef.current = null;
      window.buddy.dragEnd();
      try {
        e.currentTarget.releasePointerCapture(ev.pointerId);
      } catch {
        /* already released */
      }
      if (drag && !drag.moved) {
        void openPanel(recording ? "meet" : undefined);
      }
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  function onPanelDragDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest("button, input, textarea, a")) return;

    e.preventDefault();
    window.buddy.dragStart({ screenX: e.screenX, screenY: e.screenY });

    const onMove = (ev: PointerEvent) => {
      window.buddy.dragMove({ screenX: ev.screenX, screenY: ev.screenY });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.buddy.dragEnd();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  if (mode !== "panel") {
    return (
      <div
        className={`collapsed-root color-${iconColor} ${recording ? "recording" : ""} ${
          activeReminder ? "with-bubble" : ""
        }`}
      >
        {activeReminder ? (
          <MangaBubble
            reminder={activeReminder}
            onAction={(action) => void handleReminderAction(action)}
            onClose={() => void dismissActiveReminder()}
          />
        ) : null}
        <button
          className={`icon-orb color-${iconColor} ${recording ? "recording" : ""}`}
          aria-label={
            recorder.phase === "recording"
              ? `Recording ${formatElapsed(recorder.elapsed)} — click to open`
              : "Open Buddy"
          }
          title={
            recorder.phase === "recording"
              ? `Recording ${formatElapsed(recorder.elapsed)} — ${nowSpeakingLabel(
                  recorder.liveSpeakerState,
                  recorder.liveSpeaker
                )}`
              : recorder.phase === "processing"
                ? "Processing meeting…"
                : "Open Buddy"
          }
          onPointerDown={onIconPointerDown}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            window.buddy.showIconMenu({
              phase: recorder.phase,
              x: Math.round(e.clientX),
              y: Math.round(e.clientY),
            });
          }}
        >
          <BuddyMark className="icon-mark" />
          {recorder.phase === "recording" && recorder.liveSpeakerTrail.length > 0 ? (
            <span className="icon-speaker-strip" aria-hidden>
              {recorder.liveSpeakerTrail.map((name) => (
                <span
                  key={name}
                  className={`icon-speaker-box ${
                    recorder.liveSpeakerState === "name" &&
                    recorder.liveSpeaker === name
                      ? "active"
                      : ""
                  }`}
                  style={{ background: speakerColor(name) }}
                />
              ))}
            </span>
          ) : null}
          {recorder.phase === "recording" ? (
            <span className="icon-rec-time">{formatElapsed(recorder.elapsed)}</span>
          ) : null}
        </button>
      </div>
    );
  }

  return (
    <div className={`app-shell theme-${iconColor}`}>
      <div className="panel">
        <div className="titlebar" onPointerDown={onPanelDragDown}>
          <div className="titlebar-brand">
            <div className={`brand-dot ${recording ? "recording" : ""}`}>
              <BuddyMark />
            </div>
            <span className="brand-name">Buddy</span>
            {recorder.phase === "recording" ? (
              <span className="title-rec">
                REC {formatElapsed(recorder.elapsed)}
                {` · ${
                  recorder.liveSpeakerState === "name" && recorder.liveSpeaker
                    ? `Now: ${recorder.liveSpeaker}`
                    : nowSpeakingLabel(
                        recorder.liveSpeakerState,
                        recorder.liveSpeaker
                      )
                }`}
              </span>
            ) : null}
          </div>
          <div className="titlebar-actions">
            <button
              className="icon-btn"
              title="Minimize to icon (recording continues)"
              onClick={() => void collapse()}
            >
              <IconMinus />
            </button>
          </div>
        </div>

        <div className="tabs">
          <button
            className={`tab ${tab === "notes" ? "active" : ""}`}
            onClick={() => setTab("notes")}
          >
            Notes
          </button>
          <button
            className={`tab ${tab === "meet" ? "active" : ""}`}
            onClick={() => setTab("meet")}
          >
            Meet
            {recorder.phase === "recording" ? (
              <span className="tab-rec-dot" aria-hidden />
            ) : null}
          </button>
        </div>

        {tab === "notes" ? <NotesView /> : <MeetView recorder={recorder} />}
      </div>
    </div>
  );
}
