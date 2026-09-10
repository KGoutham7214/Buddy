import { useEffect, useId, useRef, useState } from "react";
import { IconClose } from "./icons";
import VoiceIdSettings from "./VoiceIdSettings";
import MeetModelsSettings from "./MeetModelsSettings";

export const THEME_OPTIONS = [
  { id: "sand", label: "Sand", swatch: "#c4a574" },
  { id: "ocean", label: "Ocean", swatch: "#5d8aa8" },
  { id: "sage", label: "Sage", swatch: "#7d9b78" },
  { id: "rose", label: "Rose", swatch: "#c47a8a" },
] as const;

type Props = {
  open: boolean;
  theme: string;
  userName: string;
  micBusy?: boolean;
  showVoiceId?: boolean;
  showMeetModels?: boolean;
  onThemeChange: (id: string) => void;
  onUserNameSave: (value: string) => void | Promise<void>;
  onClose: () => void;
};

export default function SettingsDialog({
  open,
  theme,
  userName,
  micBusy = false,
  showVoiceId = true,
  showMeetModels = true,
  onThemeChange,
  onUserNameSave,
  onClose,
}: Props) {
  const titleId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [draftName, setDraftName] = useState(userName);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDraftName(userName);
    const t = window.setTimeout(() => inputRef.current?.focus(), 40);
    return () => window.clearTimeout(t);
  }, [open, userName]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  async function saveName() {
    if (saving) return;
    setSaving(true);
    try {
      await onUserNameSave(draftName);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="confirm-overlay settings-overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="confirm-dialog settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="settings-header">
          <h3 id={titleId} className="confirm-title">
            Settings
          </h3>
          <button
            type="button"
            className="icon-btn settings-close"
            title="Close"
            aria-label="Close settings"
            onClick={onClose}
          >
            <IconClose />
          </button>
        </div>

        <div className="settings-body">
          <section className="settings-section">
            <div className="settings-label">Theme</div>
            <div className="theme-swatches" role="radiogroup" aria-label="Theme">
              {THEME_OPTIONS.map((option) => {
                const selected = theme === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    className={`theme-swatch ${selected ? "selected" : ""}`}
                    title={option.label}
                    onClick={() => onThemeChange(option.id)}
                  >
                    <span
                      className="theme-swatch-dot"
                      style={{ background: option.swatch }}
                    />
                    <span className="theme-swatch-label">{option.label}</span>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="settings-section">
            <label className="settings-label" htmlFor="settings-username">
              Username
            </label>
            <div className="settings-username-row">
              <input
                ref={inputRef}
                id="settings-username"
                className="settings-input"
                value={draftName}
                maxLength={40}
                placeholder="Your name"
                onChange={(e) => setDraftName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void saveName();
                  }
                }}
              />
              <button
                type="button"
                className="btn btn-primary"
                disabled={saving}
                onClick={() => void saveName()}
              >
                Save
              </button>
            </div>
            <p className="settings-hint">
              Shown in the title bar. Leave blank to hide it.
            </p>
          </section>

          {showMeetModels ? (
            <section className="settings-section">
              <MeetModelsSettings />
            </section>
          ) : null}

          {showVoiceId ? (
            <section className="settings-section">
              <VoiceIdSettings micBusy={micBusy} />
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}
