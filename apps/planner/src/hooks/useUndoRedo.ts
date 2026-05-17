/**
 * useUndoRedo — extracted from CalendarContext for testability.
 *
 * Holds an undo and a redo stack of {undo, redo} closures. New operations
 * push onto undo and clear redo (standard semantics). undo()/redo() pop
 * one op, replay it, and move it to the opposite stack.
 *
 * Two correctness guarantees beyond the obvious:
 *   - **Replay re-entry guard**: an op's undo/redo body often calls back
 *     into the same mutators that originally produced it (e.g. an event
 *     delete's "undo" is an event create — which itself wants to push
 *     an undo entry). `suppressUndoPushRef` is flipped during replay so
 *     those nested calls don't double-register.
 *   - **Synchronous ref mirror**: state lives in `useState` (so the UI
 *     re-renders) AND a `useRef` (so undo()/redo() can pop without
 *     racing React's render cycle). React's setState updater runs
 *     asynchronously; reading the popped op directly off the ref avoids
 *     a bug where the op was sometimes undefined at replay time.
 *
 * The hook returns a stable API (callbacks have empty deps) so consumers
 * can put it into other useCallback deps without churn.
 *
 * @module useUndoRedo
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { logger } from "../lib/logger";

const log = logger("undo");

/** One reversible operation — deletion, move, tag mutation, etc. */
export interface UndoableOperation {
  description: string;
  /** Undo: apply the inverse of the operation. */
  undo: () => Promise<void>;
  /** Redo: re-apply the original operation. */
  redo: () => Promise<void>;
}

/** Default cap on the undo stack — old entries fall off the bottom. */
const DEFAULT_CAP = 20;

export interface UseUndoRedoReturn {
  /** Stable pusher — call from any mutator to register its reverse. */
  pushUndo: (op: UndoableOperation) => void;
  /** Pop the top of the undo stack, replay its `undo`, push onto redo. */
  undo: () => Promise<void>;
  /** Pop the top of the redo stack, replay its `redo`, push onto undo. */
  redo: () => Promise<void>;
  /** Wipe both stacks — call on logout / identity change. */
  clear: () => void;
  /** UI signals. */
  undoDepth: number;
  redoDepth: number;
  undoPreview: string | null;
  redoPreview: string | null;
}

/** @param cap — max entries kept on the undo stack. Defaults to 20. */
export function useUndoRedo(cap: number = DEFAULT_CAP): UseUndoRedoReturn {
  const [undoStack, setUndoStack] = useState<UndoableOperation[]>([]);
  const [redoStack, setRedoStack] = useState<UndoableOperation[]>([]);
  const undoStackRef = useRef<UndoableOperation[]>([]);
  const redoStackRef = useRef<UndoableOperation[]>([]);
  useEffect(() => { undoStackRef.current = undoStack; }, [undoStack]);
  useEffect(() => { redoStackRef.current = redoStack; }, [redoStack]);

  const suppressUndoPushRef = useRef(false);
  const replayingRef = useRef(false);

  const pushUndo = useCallback((op: UndoableOperation) => {
    if (suppressUndoPushRef.current) return;
    const next = [...undoStackRef.current, op];
    const capped = next.length > cap ? next.slice(next.length - cap) : next;
    undoStackRef.current = capped;
    redoStackRef.current = [];
    setUndoStack(capped);
    setRedoStack([]);
  }, [cap]);

  const undo = useCallback(async () => {
    if (replayingRef.current) return;
    const stack = undoStackRef.current;
    if (stack.length === 0) return;
    const op = stack[stack.length - 1];
    const nextStack = stack.slice(0, -1);
    undoStackRef.current = nextStack;
    setUndoStack(nextStack);

    replayingRef.current = true;
    suppressUndoPushRef.current = true;
    try {
      await op.undo();
      const nextRedo = [...redoStackRef.current, op];
      redoStackRef.current = nextRedo;
      setRedoStack(nextRedo);
    } catch (err) {
      log.warn("undo failed:", err);
      // Restore the popped op so the user can retry.
      undoStackRef.current = stack;
      setUndoStack(stack);
    } finally {
      suppressUndoPushRef.current = false;
      replayingRef.current = false;
    }
  }, []);

  const redo = useCallback(async () => {
    if (replayingRef.current) return;
    const stack = redoStackRef.current;
    if (stack.length === 0) return;
    const op = stack[stack.length - 1];
    const nextStack = stack.slice(0, -1);
    redoStackRef.current = nextStack;
    setRedoStack(nextStack);

    replayingRef.current = true;
    suppressUndoPushRef.current = true;
    try {
      await op.redo();
      const nextUndo = [...undoStackRef.current, op];
      const capped = nextUndo.length > cap ? nextUndo.slice(nextUndo.length - cap) : nextUndo;
      undoStackRef.current = capped;
      setUndoStack(capped);
    } catch (err) {
      log.warn("redo failed:", err);
      redoStackRef.current = stack;
      setRedoStack(stack);
    } finally {
      suppressUndoPushRef.current = false;
      replayingRef.current = false;
    }
  }, [cap]);

  const clear = useCallback(() => {
    undoStackRef.current = [];
    redoStackRef.current = [];
    setUndoStack([]);
    setRedoStack([]);
  }, []);

  return {
    pushUndo,
    undo,
    redo,
    clear,
    undoDepth: undoStack.length,
    redoDepth: redoStack.length,
    undoPreview: undoStack.length > 0 ? undoStack[undoStack.length - 1].description : null,
    redoPreview: redoStack.length > 0 ? redoStack[redoStack.length - 1].description : null,
  };
}
