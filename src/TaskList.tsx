import { useEffect, useRef, useState } from "react";
import type { Task } from "./vite-env";
import { buildTaskTree, type TaskNode } from "./taskTree";
import { IconClock, IconPlus, IconTrash } from "./icons";

type Unit = "minutes" | "hours" | "days";

type Props = {
  tasks: Task[];
  emptyText?: string;
  onToggle: (task: Task) => void;
  onRename: (task: Task, title: string) => void;
  onAddChild: (parentId: string) => void;
  onDelete: (id: string) => void;
  onSchedule?: (task: Task, remindAt: string | null) => void;
};

export default function TaskList({
  tasks,
  emptyText = "No tasks yet",
  onToggle,
  onRename,
  onAddChild,
  onDelete,
  onSchedule,
}: Props) {
  const tree = buildTaskTree(tasks);

  if (tree.length === 0) {
    return <div className="empty-hint tight">{emptyText}</div>;
  }

  return (
    <div className="task-list embedded">
      {tree.map((node) => (
        <TaskNodeView
          key={node.task.id}
          node={node}
          depth={0}
          onToggle={onToggle}
          onRename={onRename}
          onAddChild={onAddChild}
          onDelete={onDelete}
          onSchedule={onSchedule}
        />
      ))}
    </div>
  );
}

function TaskNodeView({
  node,
  depth,
  onToggle,
  onRename,
  onAddChild,
  onDelete,
  onSchedule,
}: {
  node: TaskNode;
  depth: number;
  onToggle: (task: Task) => void;
  onRename: (task: Task, title: string) => void;
  onAddChild: (parentId: string) => void;
  onDelete: (id: string) => void;
  onSchedule?: (task: Task, remindAt: string | null) => void;
}) {
  const { task, children } = node;
  const [title, setTitle] = useState(task.title);
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("30");
  const [unit, setUnit] = useState<Unit>("minutes");
  const popRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setTitle(task.title);
  }, [task.title]);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!popRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const scheduled =
    task.remindAt && Date.parse(task.remindAt) > Date.now()
      ? new Date(task.remindAt)
      : null;

  function applySchedule() {
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) return;
    const ms =
      unit === "days"
        ? n * 24 * 60 * 60 * 1000
        : unit === "hours"
          ? n * 60 * 60 * 1000
          : n * 60 * 1000;
    const when = new Date(Date.now() + ms).toISOString();
    onSchedule?.(task, when);
    setOpen(false);
  }

  return (
    <div className="task-branch">
      <div
        className={`task-row ${task.done ? "done" : ""}`}
        style={{ paddingLeft: 8 + depth * 18 }}
      >
        <input
          type="checkbox"
          className="task-checkbox"
          checked={task.done}
          onChange={() => onToggle(task)}
          aria-label={task.done ? "Mark incomplete" : "Mark complete"}
        />
        <input
          className="task-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => onRename(task, title)}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />
        <div className="task-actions" ref={popRef}>
          <button
            className="tiny-btn"
            title="Add subtask"
            onClick={() => onAddChild(task.id)}
          >
            <IconPlus />
          </button>
          {onSchedule ? (
            <>
              <button
                className={`tiny-btn ${scheduled ? "armed" : ""}`}
                title={
                  scheduled
                    ? `Remind ${scheduled.toLocaleString()}`
                    : "Remind me later"
                }
                onClick={() => setOpen((v) => !v)}
              >
                <IconClock />
              </button>
              {open ? (
                <div className="remind-pop">
                  <input
                    className="remind-amount"
                    type="number"
                    min={1}
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    aria-label="Reminder amount"
                  />
                  <select
                    className="remind-unit"
                    value={unit}
                    onChange={(e) => setUnit(e.target.value as Unit)}
                    aria-label="Reminder unit"
                  >
                    <option value="minutes">min</option>
                    <option value="hours">hr</option>
                    <option value="days">day</option>
                  </select>
                  <button
                    className="remind-set"
                    type="button"
                    onClick={applySchedule}
                  >
                    Set
                  </button>
                  {task.remindAt ? (
                    <button
                      className="remind-clear"
                      type="button"
                      onClick={() => {
                        onSchedule(task, null);
                        setOpen(false);
                      }}
                    >
                      Clear
                    </button>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : null}
          <button
            className="tiny-btn danger"
            title="Delete"
            onClick={() => onDelete(task.id)}
          >
            <IconTrash />
          </button>
        </div>
      </div>
      {children.map((child) => (
        <TaskNodeView
          key={child.task.id}
          node={child}
          depth={depth + 1}
          onToggle={onToggle}
          onRename={onRename}
          onAddChild={onAddChild}
          onDelete={onDelete}
          onSchedule={onSchedule}
        />
      ))}
    </div>
  );
}
