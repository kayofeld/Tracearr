import { useEffect, useState, type KeyboardEvent, type RefObject } from 'react';
import { nodeDomId } from './builderReducer';

interface RowKeyboardOptions {
  /** The rows in the order they are rendered, by node id. */
  ids: readonly string[];
  /** Where the keyboard goes when the last row is removed. */
  sectionRef?: RefObject<HTMLElement | null>;
  onToggle: (id: string) => void;
  onRemove: (id: string, index: number) => void;
  onMove?: (id: string, delta: number) => void;
  onExpand?: (id: string) => void;
  /** Which rows have something to open; without it, none of them do. */
  canExpand?: (id: string) => boolean;
}

export interface RowProps {
  tabIndex: number;
  'aria-keyshortcuts': string;
  onFocus: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}

export interface RowKeyboard {
  rowProps: (index: number) => RowProps;
  /** Call after a removal so the neighbouring row takes the keyboard. */
  reclaim: (index: number) => void;
}

/**
 * One roving tabindex over a list of node rows: arrows move, `D` skips, `E` opens,
 * `Delete` removes and `Alt` with an arrow reorders.
 */
export function useRowKeyboard({
  ids,
  sectionRef,
  onToggle,
  onRemove,
  onMove,
  onExpand,
  canExpand,
}: RowKeyboardOptions): RowKeyboard {
  const [activeIndex, setActiveIndex] = useState(0);
  const [reclaimIndex, setReclaimIndex] = useState<number | null>(null);

  // A removed row takes the keyboard with it, so its neighbour or the picker takes over.
  useEffect(() => {
    if (reclaimIndex === null) return;
    setReclaimIndex(null);
    const next = Math.min(reclaimIndex, ids.length - 1);
    const target = ids[next];
    if (target !== undefined) {
      setActiveIndex(next);
      document.getElementById(nodeDomId(target))?.focus();
      return;
    }
    sectionRef?.current?.querySelector<HTMLElement>('[data-node-picker]')?.focus();
  }, [reclaimIndex, ids, sectionRef]);

  const focusRow = (index: number) => {
    const target = ids[index];
    if (target === undefined) return;
    setActiveIndex(index);
    document.getElementById(nodeDomId(target))?.focus();
  };

  const expands = (id: string) => onExpand !== undefined && (canExpand?.(id) ?? false);

  /** Only what this row actually answers to; a leaf action has nothing to open. */
  const shortcutsFor = (id: string) =>
    ['D', expands(id) && 'E', 'Delete', onMove && 'Alt+ArrowUp Alt+ArrowDown']
      .filter((key): key is string => typeof key === 'string')
      .join(' ');

  const handleKeyDown = (index: number) => (event: KeyboardEvent<HTMLElement>) => {
    // Arrows and Delete belong to whatever control the row holds once focus is inside it.
    if (event.target !== event.currentTarget) return;
    const id = ids[index];
    if (id === undefined) return;

    const isArrow = event.key === 'ArrowDown' || event.key === 'ArrowUp';
    const delta = event.key === 'ArrowDown' ? 1 : -1;

    if (onMove && event.altKey && isArrow && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
      event.preventDefault();
      onMove(id, delta);
      return;
    }
    // Any other modifier means the browser's shortcut, not the row's.
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;

    if (isArrow) {
      event.preventDefault();
      focusRow(index + delta);
      return;
    }
    if (event.key === 'd' || event.key === 'D') {
      event.preventDefault();
      onToggle(id);
      return;
    }
    if (onExpand && expands(id) && (event.key === 'e' || event.key === 'E')) {
      event.preventDefault();
      onExpand(id);
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      onRemove(id, index);
    }
  };

  return {
    reclaim: setReclaimIndex,
    rowProps: (index) => ({
      tabIndex: index === Math.min(activeIndex, ids.length - 1) ? 0 : -1,
      'aria-keyshortcuts': shortcutsFor(ids[index] ?? ''),
      onFocus: () => setActiveIndex(index),
      onKeyDown: handleKeyDown(index),
    }),
  };
}
