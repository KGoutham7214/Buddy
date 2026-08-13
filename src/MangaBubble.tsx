import type { ReminderAction, ReminderDef } from "./reminderCatalog";

type Props = {
  reminder: ReminderDef;
  onAction: (action: ReminderAction) => void;
  onClose: () => void;
};

export default function MangaBubble({ reminder, onAction, onClose }: Props) {
  const actions = reminder.actions?.length
    ? reminder.actions
    : [{ label: "Close", action: { type: "dismiss" as const }, style: "ghost" as const }];

  return (
    <aside className="manga-bubble" role="dialog" aria-label={reminder.speaker}>
      <div className="manga-bubble-frame">
        {reminder.stamp ? (
          <span className="manga-stamp" aria-hidden>
            {reminder.stamp}
          </span>
        ) : null}

        <button
          type="button"
          className="manga-close"
          title="Dismiss"
          aria-label="Dismiss reminder"
          onClick={onClose}
          onPointerDown={(e) => e.stopPropagation()}
        >
          ×
        </button>

        <div className="manga-speaker">{reminder.speaker}</div>

        <div className="manga-lines">
          {reminder.lines.map((line) => (
            <p key={line} className="manga-line">
              {line}
            </p>
          ))}
        </div>

        <div className="manga-actions">
          {actions.map((btn) => (
            <button
              key={btn.label}
              type="button"
              className={`manga-btn ${btn.style === "primary" ? "primary" : "ghost"}`}
              onClick={() => onAction(btn.action)}
              onPointerDown={(e) => e.stopPropagation()}
            >
              {btn.label}
            </button>
          ))}
        </div>
      </div>
      <span className="manga-tail" aria-hidden />
    </aside>
  );
}
