export type ReminderFrequency = "daily" | "once" | "always";

export type ReminderAction =
  | { type: "dismiss" }
  | { type: "snooze" }
  | { type: "open-notes" }
  | { type: "open-meet" };

export type ReminderActionButton = {
  label: string;
  action: ReminderAction;
  /** primary = filled manga button */
  style?: "primary" | "ghost";
};

/**
 * Extensible reminder definition. Add new entries to REMINDER_CATALOG
 * and they will use the same manga convo panel UI.
 */
export type ReminderDef = {
  id: string;
  /** How often this reminder may appear */
  frequency: ReminderFrequency;
  /** Character name in the manga panel */
  speaker: string;
  /** Dialogue lines shown in the bubble */
  lines: string[];
  /** Optional small corner stamp, e.g. "TODO" */
  stamp?: string;
  actions?: ReminderActionButton[];
};

export type PendingReminder = ReminderDef & {
  /** Local calendar day key YYYY-MM-DD when evaluated */
  dayKey: string;
};

/** Built-in reminders — append here for future prompts */
export const REMINDER_CATALOG: ReminderDef[] = [
  {
    id: "daily-todo",
    frequency: "daily",
    speaker: "Buddy",
    stamp: "TODO",
    lines: [
      "Hey — first boot of the day.",
      "Want to jot today's todo list before things pile up?",
    ],
    actions: [
      { label: "Add todos", action: { type: "open-notes" }, style: "primary" },
      { label: "Snooze 1h", action: { type: "snooze" }, style: "ghost" },
      { label: "Later", action: { type: "dismiss" }, style: "ghost" },
    ],
  },
];

export function localDayKey(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function greetingForHour(hour = new Date().getHours()): string {
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

/** Inject time-of-day greeting into the daily todo copy */
export function materializeReminder(def: ReminderDef): ReminderDef {
  if (def.id !== "daily-todo") return def;
  const greet = greetingForHour();
  return {
    ...def,
    lines: [
      `${greet} — first look-in today.`,
      "Want to jot today's todo list before things pile up?",
    ],
  };
}

export function reminderFromTask(taskId: string, title: string): ReminderDef {
  const clean = (title || "this task").trim() || "this task";
  return {
    id: `task:${taskId}`,
    frequency: "once",
    speaker: "Buddy",
    stamp: "TASK",
    lines: ["Time's up.", `Don't forget: ${clean}`],
    actions: [
      { label: "Open", action: { type: "open-notes" }, style: "primary" },
      { label: "Snooze 1h", action: { type: "snooze" }, style: "ghost" },
      { label: "Later", action: { type: "dismiss" }, style: "ghost" },
    ],
  };
}
