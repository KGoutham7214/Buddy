import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import NotesView from "./NotesView";
import { BuddyMark, IconMinus } from "./icons";

type Mode = "icon" | "panel";

export default function App() {
  const [mode, setMode] = useState<Mode>("icon");
  const dragRef = useRef<{
    startX: number;
    startY: number;
    moved: boolean;
  } | null>(null);

  useEffect(() => {
    if (!window.buddy) return;
    void window.buddy.getState().then((s) => {
      setMode(s.mode === "panel" ? "panel" : "icon");
    });
    return window.buddy.onModeChange((value) => {
      setMode(value === "panel" ? "panel" : "icon");
    });
  }, []);

  async function openPanel() {
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
      // Only move the window after the drag threshold so a click never stretches it
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
        (e.currentTarget as HTMLElement).releasePointerCapture(ev.pointerId);
      } catch {
        /* already released */
      }
      if (drag && !drag.moved) {
        void openPanel();
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
      <div className="collapsed-root">
        <button
          className="icon-orb"
          aria-label="Open notes"
          onPointerDown={onIconPointerDown}
        >
          <BuddyMark className="icon-mark" />
        </button>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <div className="panel">
        <div className="titlebar" onPointerDown={onPanelDragDown}>
          <div className="titlebar-brand">
            <div className="brand-dot">
              <BuddyMark />
            </div>
          </div>
          <div className="titlebar-actions">
            <button
              className="icon-btn"
              title="Minimize to icon"
              onClick={() => void collapse()}
            >
              <IconMinus />
            </button>
          </div>
        </div>

        <NotesView />
      </div>
    </div>
  );
}
