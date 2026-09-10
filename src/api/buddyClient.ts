import type { BuddyApi } from "../vite-env";

/**
 * UI talks only to this client. Electron wires it via preload → window.buddy;
 * a future mobile/LAN adapter can swap the same BuddyApi surface.
 */
function getApi(): BuddyApi {
  if (typeof window === "undefined" || !window.buddy) {
    throw new Error("Buddy API is not available in this environment");
  }
  return window.buddy;
}

export const buddy: BuddyApi = {
  getState: (...args) => getApi().getState(...args),
  setMode: (...args) => getApi().setMode(...args),
  setIconColor: (...args) => getApi().setIconColor(...args),
  setUserName: (...args) => getApi().setUserName(...args),
  dragStart: (...args) => getApi().dragStart(...args),
  dragMove: (...args) => getApi().dragMove(...args),
  dragEnd: (...args) => getApi().dragEnd(...args),
  showIconMenu: (...args) => getApi().showIconMenu(...args),
  listNotes: (...args) => getApi().listNotes(...args),
  createNote: (...args) => getApi().createNote(...args),
  updateNote: (...args) => getApi().updateNote(...args),
  deleteNote: (...args) => getApi().deleteNote(...args),
  listTasks: (...args) => getApi().listTasks(...args),
  createTask: (...args) => getApi().createTask(...args),
  updateTask: (...args) => getApi().updateTask(...args),
  deleteTask: (...args) => getApi().deleteTask(...args),
  getDesktopSource: (...args) => getApi().getDesktopSource(...args),
  checkMeetingDeps: (...args) => getApi().checkMeetingDeps(...args),
  getMeetSettings: (...args) => getApi().getMeetSettings(...args),
  setMeetSettings: (...args) => getApi().setMeetSettings(...args),
  listVoices: (...args) => getApi().listVoices(...args),
  enrollVoice: (...args) => getApi().enrollVoice(...args),
  deleteVoice: (...args) => getApi().deleteVoice(...args),
  resetSpeakerSession: (...args) => getApi().resetSpeakerSession(...args),
  identifySpeaker: (...args) => getApi().identifySpeaker(...args),
  processMeeting: (...args) => getApi().processMeeting(...args),
  summarizeMeeting: (...args) => getApi().summarizeMeeting(...args),
  setRecording: (...args) => getApi().setRecording(...args),
  listPendingReminders: (...args) => getApi().listPendingReminders(...args),
  markReminderShown: (...args) => getApi().markReminderShown(...args),
  dismissReminder: (...args) => getApi().dismissReminder(...args),
  snoozeReminder: (...args) => getApi().snoozeReminder(...args),
  setReminderBubble: (...args) => getApi().setReminderBubble(...args),
  onModeChange: (...args) => getApi().onModeChange(...args),
  onMeetingProgress: (...args) => getApi().onMeetingProgress(...args),
  onReminderDue: (...args) => getApi().onReminderDue(...args),
  onIconMenuAction: (...args) => getApi().onIconMenuAction(...args),
  onIconColor: (...args) => getApi().onIconColor(...args),
};

export function hasBuddyApi(): boolean {
  return typeof window !== "undefined" && Boolean(window.buddy);
}
