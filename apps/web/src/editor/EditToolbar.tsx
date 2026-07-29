export function EditToolbar({
  canUndo,
  canRedo,
  hasSelection,
  canTrimAtPlayhead,
  onUndo,
  onRedo,
  onSplit,
  onDelete,
  onDuplicate,
  onDeleteLeft,
  onDeleteRight,
  onCloseGaps,
  onSnapStart,
  onShowShortcuts,
}: {
  canUndo: boolean;
  canRedo: boolean;
  hasSelection: boolean;
  canTrimAtPlayhead: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onSplit: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onDeleteLeft: () => void;
  onDeleteRight: () => void;
  onCloseGaps: () => void;
  onSnapStart: () => void;
  onShowShortcuts: () => void;
}) {
  return (
    <div className="edit-toolbar" role="toolbar" aria-label="Ferramentas de edição">
      <button type="button" className="ghost" disabled={!canUndo} onClick={onUndo} title="Desfazer (⌘Z)">
        Desfazer
      </button>
      <button type="button" className="ghost" disabled={!canRedo} onClick={onRedo} title="Refazer (⇧⌘Z)">
        Refazer
      </button>
      <span className="toolbar-sep" />
      <button type="button" className="ghost" onClick={onSplit} title="Dividir no playhead (S)">
        Dividir
      </button>
      <button
        type="button"
        className="ghost"
        disabled={!canTrimAtPlayhead}
        onClick={onDeleteLeft}
        title="Apagar à esquerda do playhead (Q)"
      >
        Apagar ←
      </button>
      <button
        type="button"
        className="ghost"
        disabled={!canTrimAtPlayhead}
        onClick={onDeleteRight}
        title="Apagar à direita do playhead (W)"
      >
        Apagar →
      </button>
      <button
        type="button"
        className="ghost"
        disabled={!hasSelection}
        onClick={onDelete}
        title="Apagar clipe (Delete)"
      >
        Apagar
      </button>
      <button
        type="button"
        className="ghost"
        disabled={!hasSelection}
        onClick={onDuplicate}
        title="Duplicar (D)"
      >
        Duplicar
      </button>
      <span className="toolbar-sep" />
      <button type="button" className="ghost" onClick={onCloseGaps} title="Remover espaços entre clipes">
        Fechar buracos
      </button>
      <button type="button" className="ghost" onClick={onSnapStart} title="Mover tudo para o início">
        Alinhar ao início
      </button>
      <span className="toolbar-sep" />
      <button type="button" className="ghost" onClick={onShowShortcuts} title="Atalhos (?)">
        Atalhos
      </button>
    </div>
  );
}
