// @vitest-environment jsdom
/**
 * Unit tests for useUndoRedo — the extracted undo/redo stack hook.
 */
import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useUndoRedo } from "./useUndoRedo";

describe("useUndoRedo", () => {
  it("starts empty", () => {
    const { result } = renderHook(() => useUndoRedo());
    expect(result.current.undoDepth).toBe(0);
    expect(result.current.redoDepth).toBe(0);
    expect(result.current.undoPreview).toBeNull();
  });

  it("pushUndo records an op", () => {
    const { result } = renderHook(() => useUndoRedo());
    act(() => {
      result.current.pushUndo({
        description: "test",
        undo: async () => {},
        redo: async () => {},
      });
    });
    expect(result.current.undoDepth).toBe(1);
    expect(result.current.undoPreview).toBe("test");
  });

  it("undo runs reverse and moves op to redo stack", async () => {
    const { result } = renderHook(() => useUndoRedo());
    let undoRan = false;
    act(() => {
      result.current.pushUndo({
        description: "delete",
        undo: async () => { undoRan = true; },
        redo: async () => {},
      });
    });
    await act(async () => { await result.current.undo(); });
    expect(undoRan).toBe(true);
    expect(result.current.undoDepth).toBe(0);
    expect(result.current.redoDepth).toBe(1);
    expect(result.current.redoPreview).toBe("delete");
  });

  it("redo runs forward and moves op back to undo stack", async () => {
    const { result } = renderHook(() => useUndoRedo());
    let redoRan = false;
    act(() => {
      result.current.pushUndo({
        description: "create",
        undo: async () => {},
        redo: async () => { redoRan = true; },
      });
    });
    await act(async () => { await result.current.undo(); });
    await act(async () => { await result.current.redo(); });
    expect(redoRan).toBe(true);
    expect(result.current.undoDepth).toBe(1);
    expect(result.current.redoDepth).toBe(0);
  });

  it("new push clears the redo stack (branching semantics)", async () => {
    const { result } = renderHook(() => useUndoRedo());
    act(() => {
      result.current.pushUndo({ description: "a", undo: async () => {}, redo: async () => {} });
    });
    await act(async () => { await result.current.undo(); });
    expect(result.current.redoDepth).toBe(1);
    act(() => {
      result.current.pushUndo({ description: "b", undo: async () => {}, redo: async () => {} });
    });
    expect(result.current.redoDepth).toBe(0);
  });

  it("respects the cap (oldest entries fall off)", () => {
    const { result } = renderHook(() => useUndoRedo(3));
    act(() => {
      for (let i = 0; i < 5; i++) {
        result.current.pushUndo({
          description: `op-${i}`,
          undo: async () => {},
          redo: async () => {},
        });
      }
    });
    expect(result.current.undoDepth).toBe(3);
    expect(result.current.undoPreview).toBe("op-4");
  });

  it("nested pushUndo during replay is suppressed", async () => {
    const { result } = renderHook(() => useUndoRedo());
    act(() => {
      result.current.pushUndo({
        description: "outer",
        undo: async () => {
          // Simulate the replay calling back into pushUndo. This must
          // not double-register on the undo stack, otherwise undo+undo
          // would replay the same op twice and stamp on the redo stack.
          result.current.pushUndo({
            description: "nested",
            undo: async () => {},
            redo: async () => {},
          });
        },
        redo: async () => {},
      });
    });
    await act(async () => { await result.current.undo(); });
    expect(result.current.undoDepth).toBe(0);
  });

  it("clear empties both stacks", async () => {
    const { result } = renderHook(() => useUndoRedo());
    act(() => {
      result.current.pushUndo({ description: "x", undo: async () => {}, redo: async () => {} });
    });
    await act(async () => { await result.current.undo(); });
    act(() => { result.current.clear(); });
    expect(result.current.undoDepth).toBe(0);
    expect(result.current.redoDepth).toBe(0);
  });

  it("failed undo restores the op so the user can retry", async () => {
    const { result } = renderHook(() => useUndoRedo());
    act(() => {
      result.current.pushUndo({
        description: "fragile",
        undo: async () => { throw new Error("boom"); },
        redo: async () => {},
      });
    });
    await act(async () => { await result.current.undo(); });
    expect(result.current.undoDepth).toBe(1);
    expect(result.current.redoDepth).toBe(0);
  });
});
