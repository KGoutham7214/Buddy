import type { Task } from "./vite-env";

export type TaskNode = {
  task: Task;
  children: TaskNode[];
};

export function buildTaskTree(tasks: Task[]): TaskNode[] {
  const byParent = new Map<string | null, Task[]>();
  for (const task of tasks) {
    const key = task.parentId ?? null;
    const list = byParent.get(key) || [];
    list.push(task);
    byParent.set(key, list);
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => a.order - b.order);
  }

  function walk(parentId: string | null): TaskNode[] {
    return (byParent.get(parentId) || []).map((task) => ({
      task,
      children: walk(task.id),
    }));
  }

  return walk(null);
}
