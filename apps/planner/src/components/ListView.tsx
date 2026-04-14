import { useState, useRef, type DragEvent } from "react";
import { useTasks } from "../contexts/TasksContext";
import { Plus, X, ChevronLeft, ChevronRight, Check, GripVertical } from "lucide-react";

export function ListsView() {
  const {
    lists,
    addList,
    removeList,
    renameList,
    addListItem,
    removeListItem,
    toggleListItem,
    reorderListItems,
    loading: tasksLoading,
  } = useTasks();

  const [listIndex, setListIndex] = useState(0);
  const [newItem, setNewItem] = useState("");
  const [adding, setAdding] = useState(false);
  const [newListName, setNewListName] = useState("");
  const [creatingList, setCreatingList] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const dragNodeRef = useRef<HTMLDivElement | null>(null);

  // Keep index in bounds when lists change
  const safeIndex = lists.length === 0 ? 0 : Math.min(listIndex, lists.length - 1);
  const currentList = lists[safeIndex] ?? null;

  const goLeft = () => {
    if (lists.length === 0) return;
    setListIndex((i) => (i <= 0 ? lists.length - 1 : i - 1));
  };
  const goRight = () => {
    if (lists.length === 0) return;
    setListIndex((i) => (i >= lists.length - 1 ? 0 : i + 1));
  };

  const handleAddItem = async () => {
    if (!newItem.trim() || !currentList) return;
    setAdding(true);
    try {
      await addListItem(currentList.id, newItem.trim());
      setNewItem("");
    } finally {
      setAdding(false);
    }
  };

  const handleCreateList = async () => {
    if (!newListName.trim()) return;
    await addList(newListName.trim());
    setNewListName("");
    setCreatingList(false);
    // Navigate to the newly created list
    setListIndex(lists.length); // will be the new last item
  };

  const handleStartRename = () => {
    if (!currentList) return;
    setRenamingId(currentList.id);
    setRenameValue(currentList.name);
  };

  const handleRename = async () => {
    if (!renamingId || !renameValue.trim()) {
      setRenamingId(null);
      return;
    }
    await renameList(renamingId, renameValue.trim());
    setRenamingId(null);
  };

  const [confirmDelete, setConfirmDelete] = useState(false);

  const [deleteError, setDeleteError] = useState<string | null>(null);

  const handleDeleteList = async () => {
    if (!currentList) return;
    setDeleteError(null);
    try {
      await removeList(currentList.id);
      setConfirmDelete(false);
      setListIndex((i) => Math.max(0, i - 1));
    } catch (err) {
      setDeleteError(`Failed to delete: ${err instanceof Error ? err.message : String(err)}`);
      setConfirmDelete(false);
    }
  };

  // Drag-and-drop
  const handleDragStart = (e: DragEvent<HTMLDivElement>, index: number) => {
    setDragIndex(index);
    dragNodeRef.current = e.currentTarget;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(index));
    requestAnimationFrame(() => {
      if (dragNodeRef.current) dragNodeRef.current.style.opacity = "0.4";
    });
  };

  const handleDragEnd = () => {
    if (dragNodeRef.current) dragNodeRef.current.style.opacity = "1";
    setDragIndex(null);
    setDragOverIndex(null);
    dragNodeRef.current = null;
  };

  const handleDragOver = (e: DragEvent<HTMLDivElement>, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dragIndex !== null && index !== dragIndex) setDragOverIndex(index);
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>, toIndex: number) => {
    e.preventDefault();
    if (currentList && dragIndex !== null && dragIndex !== toIndex) {
      reorderListItems(currentList.id, dragIndex, toIndex);
    }
    setDragIndex(null);
    setDragOverIndex(null);
  };

  return (
    <div className="max-w-lg mx-auto">
      {/* Section header + New list */}
      <div className="flex items-center justify-between mb-2 px-1">
        <h2 className="text-sm font-semibold text-violet-700 uppercase tracking-wider">
          To Do Lists
        </h2>
        {creatingList ? (
          <div className="flex items-center gap-1">
            <input
              autoFocus
              type="text"
              placeholder="List name..."
              value={newListName}
              onChange={(e) => setNewListName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreateList();
                if (e.key === "Escape") { setCreatingList(false); setNewListName(""); }
              }}
              onBlur={() => { if (!newListName.trim()) setCreatingList(false); }}
              className="px-2 py-1 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 w-36"
            />
            <button
              onClick={handleCreateList}
              disabled={!newListName.trim()}
              className="p-1 bg-violet-600 hover:bg-violet-700 text-white rounded-lg transition-colors disabled:opacity-50"
            >
              <Plus className="w-4 h-4" />
            </button>
            <button
              onClick={() => { setCreatingList(false); setNewListName(""); }}
              className="p-1 text-gray-400 hover:text-gray-600 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        ) : (
          <button
            onClick={() => setCreatingList(true)}
            className="flex items-center gap-1 text-xs text-gray-500 hover:text-violet-600 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            New list
          </button>
        )}
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
        {/* List navigation */}
        <div className="flex items-center justify-between p-4 border-b border-gray-100">
          <button
            onClick={goLeft}
            disabled={lists.length === 0}
            className="p-1.5 hover:bg-gray-100 rounded-lg transition-colors disabled:opacity-30"
          >
            <ChevronLeft className="w-5 h-5" />
          </button>

          <div className="flex-1 text-center min-w-0 px-2">
            {lists.length === 0 && tasksLoading ? (
              <div className="flex items-center justify-center gap-2 py-0.5 bg-primary-50 text-primary-700 text-sm rounded-lg px-3">
                <div className="animate-spin rounded-full h-3.5 w-3.5 border-b-2 border-primary-600" />
                Loading lists…
              </div>
            ) : lists.length === 0 ? (
              <div className="text-sm text-gray-400">No lists yet</div>
            ) : renamingId === currentList?.id ? (
              <input
                autoFocus
                type="text"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onBlur={handleRename}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleRename();
                  if (e.key === "Escape") setRenamingId(null);
                }}
                className="w-full text-center font-semibold text-gray-900 bg-transparent border-b border-primary-400 focus:outline-none"
              />
            ) : (
              <button
                onClick={handleStartRename}
                className="font-semibold text-gray-900 hover:text-primary-600 truncate max-w-full block mx-auto transition-colors"
                title="Click to rename"
              >
                {currentList?.name}
              </button>
            )}
            {lists.length > 0 && (
              <div className="text-xs text-gray-400 mt-0.5">
                {safeIndex + 1} / {lists.length}
                {currentList && currentList.items.length > 0 && (
                  <> · {currentList.items.filter((i) => i.done).length}/{currentList.items.length} done</>
                )}
              </div>
            )}
          </div>

          <button
            onClick={goRight}
            disabled={lists.length === 0}
            className="p-1.5 hover:bg-gray-100 rounded-lg transition-colors disabled:opacity-30"
          >
            <ChevronRight className="w-5 h-5" />
          </button>
        </div>

        {/* Items */}
        {currentList ? (
          <>
            <div className="divide-y divide-gray-100">
              {currentList.items.length === 0 && (
                <div className="p-8 text-center text-gray-400 text-sm">
                  Empty list. Add items below.
                </div>
              )}
              {currentList.items.map((item, index) => {
                const isOver = dragOverIndex === index && dragIndex !== index;
                return (
                  <div
                    key={item.id}
                    draggable
                    onDragStart={(e) => handleDragStart(e, index)}
                    onDragEnd={handleDragEnd}
                    onDragOver={(e) => handleDragOver(e, index)}
                    onDrop={(e) => handleDrop(e, index)}
                    className={`flex items-center gap-2 px-4 py-3 hover:bg-gray-50 transition-colors group ${
                      isOver ? "border-t-2 border-primary-400" : ""
                    }`}
                  >
                    <div className="cursor-grab active:cursor-grabbing text-gray-300 hover:text-gray-500 flex-shrink-0">
                      <GripVertical className="w-4 h-4" />
                    </div>
                    <button
                      onClick={() => toggleListItem(currentList.id, item.id)}
                      className={`w-6 h-6 rounded-full border-2 flex items-center justify-center transition-colors flex-shrink-0 ${
                        item.done
                          ? "bg-violet-500 border-violet-500 text-white"
                          : "border-gray-300 hover:border-violet-400"
                      }`}
                    >
                      {item.done && <Check className="w-3.5 h-3.5" />}
                    </button>
                    <span
                      className={`flex-1 text-sm ${
                        item.done ? "text-gray-400 line-through" : "text-gray-800"
                      }`}
                    >
                      {item.title}
                    </span>
                    <button
                      onClick={() => removeListItem(currentList.id, item.id)}
                      className="p-1 opacity-0 group-hover:opacity-100 hover:text-red-500 text-gray-400 transition-all"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                );
              })}
            </div>

            {/* Add item */}
            <div className="p-3 border-t border-gray-100">
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="Add item..."
                  value={newItem}
                  onChange={(e) => setNewItem(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleAddItem();
                  }}
                  className="flex-1 px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
                <button
                  onClick={handleAddItem}
                  disabled={!newItem.trim() || adding}
                  className="flex items-center gap-1 px-3 py-2 bg-primary-600 hover:bg-primary-700 text-white text-sm rounded-lg transition-colors disabled:opacity-50"
                >
                  <Plus className="w-4 h-4" />
                </button>
              </div>
            </div>

            {deleteError && (
              <div className="mx-3 mt-2 px-3 py-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg">
                {deleteError}
              </div>
            )}

            {/* Delete list */}
            <div className="px-3 pb-3 flex justify-end">
              {confirmDelete ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-red-600">Delete "{currentList.name}"?</span>
                  <button
                    onClick={handleDeleteList}
                    className="text-xs font-medium text-red-600 hover:text-red-800 transition-colors"
                  >
                    Yes
                  </button>
                  <button
                    onClick={() => setConfirmDelete(false)}
                    className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmDelete(true)}
                  className="text-xs text-gray-400 hover:text-red-500 transition-colors"
                >
                  Delete list
                </button>
              )}
            </div>
          </>
        ) : null}

      </div>
    </div>
  );
}
