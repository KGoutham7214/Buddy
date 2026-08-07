/// <reference types="vite/client" />

export type Note = {
  id: string;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
};

export type Task = {
  id: string;
  title: string;
  done: boolean;
  parentId: string | null;
  noteId: string | null;
  order: number;
  createdAt: string;
  updatedAt: string;
};

export type AppMode = "icon" | "panel";

export type BuddyApi = {
  getState: () => Promise<{
    mode: AppMode;
    userDataPath: string;
  }>;
  setMode: (mode: AppMode) => Promise<AppMode>;
  dragStart: (payload: { screenX: number; screenY: number }) => void;
  dragMove: (payload: { screenX: number; screenY: number }) => void;
  dragEnd: () => void;
  listNotes: () => Promise<Note[]>;
  createNote: (payload?: { title?: string; body?: string }) => Promise<Note>;
  updateNote: (
    id: string,
    payload: { title?: string; body?: string }
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
      Pick<Task, "title" | "done" | "parentId" | "noteId" | "order">
    >
  ) => Promise<Task | null>;
  deleteTask: (id: string) => Promise<boolean>;
  onModeChange: (callback: (mode: AppMode) => void) => () => void;
};

declare global {
  interface Window {
    buddy: BuddyApi;
  }
}

export {};
