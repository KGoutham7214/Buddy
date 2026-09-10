import { useEffect, useState } from "react";
import NotesView from "./NotesView";
import MeetView from "./MeetView";
import { useMeetingRecorder, nowSpeakingLabel } from "./useMeetingRecorder";
import {
  materializeReminder,
  reminderFromTask,
  REMINDER_CATALOG,
  type ReminderAction,
  type ReminderDef,
} from "./reminderCatalog";
import type { BuddyCapabilities, PendingReminderRef } from "./domain/types";
import { buddy, hasBuddyApi } from "./api/buddyClient";
import SettingsDialog from "./SettingsDialog";
import IconShell, { usePanelDragHandlers } from "./shell/IconShell";
import PanelShell from "./shell/PanelShell";

type Mode = "icon" | "panel";
type Tab = "notes" | "meet";

const DESKTOP_CAPABILITIES: BuddyCapabilities = {
  meet: true,
  voiceId: true,
  floatingShell: true,
};

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
  const [userName, setUserName] = useState("");
  const [capabilities, setCapabilities] =
    useState<BuddyCapabilities>(DESKTOP_CAPABILITIES);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("notes");
  const [activeReminder, setActiveReminder] = useState<ReminderDef | null>(
    null
  );
  const recorder = useMeetingRecorder();
  const recording =
    recorder.phase === "recording" || recorder.phase === "processing";
  const { onPanelDragDown } = usePanelDragHandlers();

  useEffect(() => {
    if (!hasBuddyApi()) return;
    void buddy.getState().then((s) => {
      setMode(s.mode === "panel" ? "panel" : "icon");
      if (s.iconColor) setIconColor(s.iconColor);
      if (typeof s.userName === "string") setUserName(s.userName);
      if (s.capabilities) setCapabilities(s.capabilities);
    });
    const offMode = buddy.onModeChange((value) => {
      setMode(value === "panel" ? "panel" : "icon");
    });
    const offColor = buddy.onIconColor((color) => {
      setIconColor(color);
    });
    return () => {
      offMode();
      offColor();
    };
  }, []);

  useEffect(() => {
    if (!hasBuddyApi()) return;
    return buddy.onIconMenuAction((action) => {
      if (action === "record") {
        if (!capabilities.meet) return;
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
        void openPanel(recording && capabilities.meet ? "meet" : undefined);
      }
    });
  }, [recorder, recording, capabilities.meet]);

  useEffect(() => {
    if (!hasBuddyApi() || recording) return;
    let cancelled = false;

    async function loadReminder() {
      const pending = await buddy.listPendingReminders();
      if (cancelled) return;
      if (pending.length === 0) {
        setActiveReminder(null);
        if (mode === "icon") await buddy.setReminderBubble(false);
        return;
      }
      const next = resolveReminder(pending[0]);
      if (!next || cancelled) return;
      if (mode === "panel" && pending[0].kind === "task") {
        await buddy.setMode("icon");
        return;
      }
      if (mode !== "icon") return;
      setActiveReminder(next);
      await buddy.setReminderBubble(true);
      await buddy.markReminderShown(next.id);
    }

    void loadReminder();
    const timer = window.setInterval(() => void loadReminder(), 20000);
    const offDue = buddy.onReminderDue(() => void loadReminder());
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      offDue();
    };
  }, [mode, recording]);

  useEffect(() => {
    if (!capabilities.meet && tab === "meet") setTab("notes");
  }, [capabilities.meet, tab]);

  useEffect(() => {
    if (mode === "icon" && !capabilities.floatingShell) {
      void openPanel();
    }
  }, [mode, capabilities.floatingShell]);

  async function dismissActiveReminder() {
    if (!activeReminder) return;
    const id = activeReminder.id;
    setActiveReminder(null);
    await buddy.dismissReminder(id);
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
      await openPanel(capabilities.meet ? "meet" : "notes");
      return;
    }
    if (action.type === "snooze") {
      if (!activeReminder) return;
      const id = activeReminder.id;
      setActiveReminder(null);
      await buddy.snoozeReminder(id, 1);
    }
  }

  async function openPanel(nextTab?: Tab) {
    if (activeReminder) {
      setActiveReminder(null);
      await buddy.setReminderBubble(false);
    }
    if (nextTab === "meet" && !capabilities.meet) setTab("notes");
    else if (nextTab) setTab(nextTab);
    else if (recording && capabilities.meet) setTab("meet");
    await buddy.setMode("panel");
  }

  async function collapse() {
    setSettingsOpen(false);
    await buddy.setMode("icon");
  }

  if (mode !== "panel") {
    if (!capabilities.floatingShell) {
      return null;
    }
    return (
      <IconShell
        iconColor={iconColor}
        recording={recording}
        phase={recorder.phase}
        elapsed={recorder.elapsed}
        liveSpeaker={recorder.liveSpeaker}
        liveSpeakerState={recorder.liveSpeakerState}
        liveSpeakerTrail={recorder.liveSpeakerTrail}
        activeReminder={activeReminder}
        formatElapsed={formatElapsed}
        nowSpeakingLabel={nowSpeakingLabel}
        speakerColor={speakerColor}
        onOpen={() =>
          void openPanel(recording && capabilities.meet ? "meet" : undefined)
        }
        onReminderAction={(action) => void handleReminderAction(action)}
        onReminderClose={() => void dismissActiveReminder()}
      />
    );
  }

  return (
    <PanelShell
      theme={iconColor}
      userName={userName}
      recording={recording}
      showMeetTab={capabilities.meet}
      tab={tab}
      onTabChange={setTab}
      phase={recorder.phase}
      elapsed={recorder.elapsed}
      liveSpeaker={recorder.liveSpeaker}
      liveSpeakerState={recorder.liveSpeakerState}
      formatElapsed={formatElapsed}
      nowSpeakingLabel={nowSpeakingLabel}
      onPanelDragDown={onPanelDragDown}
      onOpenSettings={() => setSettingsOpen(true)}
      onCollapse={() => void collapse()}
      settings={
        <SettingsDialog
          open={settingsOpen}
          theme={iconColor}
          userName={userName}
          micBusy={recording}
          showVoiceId={capabilities.voiceId}
          showMeetModels={capabilities.meet}
          onClose={() => setSettingsOpen(false)}
          onThemeChange={(id) => {
            setIconColor(id);
            void buddy.setIconColor(id);
          }}
          onUserNameSave={async (value) => {
            const saved = await buddy.setUserName(value);
            setUserName(saved);
          }}
        />
      }
    >
      {tab === "notes" || !capabilities.meet ? (
        <NotesView />
      ) : (
        <MeetView recorder={recorder} />
      )}
    </PanelShell>
  );
}
