/// <reference types="vite/client" />

export type {
  Note,
  Task,
  ReminderAction,
  ReminderActionButton,
  ReminderDef,
  PendingReminderRef,
  VoiceProfile,
  AppMode,
  BuddyCapabilities,
} from "./domain/types";

import type {
  Note,
  Task,
  PendingReminderRef,
  VoiceProfile,
  AppMode,
  BuddyCapabilities,
} from "./domain/types";

export type BuddyApi = {
  getState: () => Promise<{
    mode: AppMode;
    userDataPath: string;
    iconColor?: string;
    userName?: string;
    capabilities: BuddyCapabilities;
  }>;
  setMode: (mode: AppMode) => Promise<AppMode>;
  setIconColor: (id: string) => Promise<string>;
  setUserName: (value: string) => Promise<string>;
  dragStart: (payload: { screenX: number; screenY: number }) => void;
  dragMove: (payload: { screenX: number; screenY: number }) => void;
  dragEnd: () => void;
  showIconMenu: (payload: {
    phase: "idle" | "recording" | "processing";
    x?: number;
    y?: number;
  }) => void;
  listNotes: () => Promise<Note[]>;
  createNote: (payload?: {
    title?: string;
    body?: string;
    kind?: "note" | "meeting";
    transcript?: string;
    summary?: string;
    keyPoints?: string[];
    decisions?: string[];
    audioPath?: string | null;
  }) => Promise<Note>;
  updateNote: (
    id: string,
    payload: {
      title?: string;
      body?: string;
      transcript?: string;
      summary?: string;
      summaryError?: string;
      keyPoints?: string[];
      decisions?: string[];
      audioPath?: string | null;
      kind?: "note" | "meeting";
    }
  ) => Promise<Note | null>;
  deleteNote: (id: string) => Promise<boolean>;
  listTasks: () => Promise<Task[]>;
  createTask: (payload?: {
    title?: string;
    parentId?: string | null;
    noteId?: string | null;
    done?: boolean;
  }) => Promise<Task>;
  updateTask: (
    id: string,
    payload: Partial<
      Pick<Task, "title" | "done" | "parentId" | "noteId" | "order" | "remindAt">
    >
  ) => Promise<Task | null>;
  deleteTask: (id: string) => Promise<boolean>;
  getDesktopSource: () => Promise<string | null>;
  checkMeetingDeps: () => Promise<{
    whisper: { ok: boolean; error?: string };
    ollama: { ok: boolean; error?: string; models?: string[] };
    speakers?: { ok: boolean; error?: string; backend?: string };
    qdrant?: { ok: boolean; error?: string };
  }>;
  getMeetSettings: () => Promise<{
    ok: boolean;
    whisperModel: string;
    ollamaModel: string;
    whisperModels: string[];
  }>;
  setMeetSettings: (payload: {
    whisperModel?: string;
    ollamaModel?: string;
  }) => Promise<{
    ok: boolean;
    whisperModel: string;
    ollamaModel: string;
  }>;
  listVoices: () => Promise<VoiceProfile[]>;
  enrollVoice: (payload: {
    name: string;
    pcm?: Uint8Array;
    passes?: Uint8Array[];
    sampleRate?: number;
  }) => Promise<{ ok: boolean; voice?: VoiceProfile; error?: string }>;
  deleteVoice: (id: string) => Promise<boolean>;
  resetSpeakerSession: () => Promise<{ ok: boolean }>;
  identifySpeaker: (payload: {
    pcm: Uint8Array;
    sampleRate?: number;
  }) => Promise<{
    ok: boolean;
    speech?: boolean;
    label?: string | null;
    kind?: "enrolled" | "unknown" | "silence";
    confidence?: number;
    diagnostics?: {
      topLabel?: string | null;
      topScore?: number;
      secondScore?: number;
      floor?: number;
      margin?: number;
      relaxedSingle?: boolean;
      windows?: number;
    };
    error?: string;
  }>;
  processMeeting: (payload: {
    buffer: Uint8Array;
    mimeType?: string;
    speakerTurns?: {
      label: string;
      kind: "enrolled" | "unknown";
      confidence: number;
      start: number;
      end: number;
    }[];
  }) => Promise<{
    ok: boolean;
    noteId?: string;
    note?: Note;
    error?: string;
    aiError?: string | null;
  }>;
  summarizeMeeting: (noteId: string) => Promise<{
    ok: boolean;
    note?: Note;
    error?: string;
  }>;
  setRecording: (active: boolean) => Promise<boolean>;
  listPendingReminders: () => Promise<PendingReminderRef[]>;
  markReminderShown: (id: string) => Promise<unknown>;
  dismissReminder: (id: string) => Promise<unknown>;
  snoozeReminder: (id: string, hours?: number) => Promise<unknown>;
  setReminderBubble: (active: boolean) => Promise<boolean>;
  onModeChange: (callback: (mode: AppMode) => void) => () => void;
  onMeetingProgress: (callback: (message: string) => void) => () => void;
  onReminderDue: (callback: () => void) => () => void;
  onIconMenuAction: (
    callback: (action: "record" | "stop" | "cancel" | "open") => void
  ) => () => void;
  onIconColor: (callback: (color: string) => void) => () => void;
};

declare global {
  interface Window {
    buddy: BuddyApi;
  }
}

export {};
