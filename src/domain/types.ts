/** Shared product entities — keep free of Electron / window assumptions. */

export type Note = {
  id: string;
  title: string;
  body: string;
  kind?: "note" | "meeting";
  transcript?: string;
  summary?: string;
  summaryError?: string;
  keyPoints?: string[];
  decisions?: string[];
  audioPath?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Task = {
  id: string;
  title: string;
  done: boolean;
  parentId: string | null;
  noteId: string | null;
  remindAt?: string | null;
  order: number;
  createdAt: string;
  updatedAt: string;
};

export type ReminderAction =
  | { type: "dismiss" }
  | { type: "snooze" }
  | { type: "open-notes" }
  | { type: "open-meet" };

export type ReminderActionButton = {
  label: string;
  action: ReminderAction;
  style?: "primary" | "ghost";
};

export type ReminderDef = {
  id: string;
  frequency: "daily" | "once" | "always";
  speaker: string;
  lines: string[];
  stamp?: string;
  actions?: ReminderActionButton[];
};

export type PendingReminderRef = {
  id: string;
  kind?: "catalog" | "task";
  frequency: string;
  dayKey: string;
  taskId?: string;
  title?: string;
};

export type VoiceProfile = {
  id: string;
  name: string;
  backend?: string;
  createdAt: string;
  updatedAt: string;
};

export type AppMode = "icon" | "panel";

/** Surface features — desktop sets all true; future clients can disable. */
export type BuddyCapabilities = {
  meet: boolean;
  voiceId: boolean;
  floatingShell: boolean;
};
