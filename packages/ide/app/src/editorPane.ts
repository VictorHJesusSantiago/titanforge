import * as monaco from 'monaco-editor';
import type { VirtualFileSystem } from '@titanforge/vfs';
import type { LanguageServiceSession } from '@titanforge/language-service';
import { syncModelToVfs, primeModelFromVfs, registerLanguageProviders } from '@titanforge/monaco-bridge';

/**
 * DOM-assembly glue: creates the Monaco editor instance, opens files as Monaco models synced
 * to the VFS via @titanforge/monaco-bridge, and registers the real language-service-backed
 * providers on each model. Not unit-tested (needs a real browser/Monaco runtime) — the pure sync
 * logic it delegates to is tested in packages/ide/monaco-bridge instead.
 */
export class EditorPane {
  private editor: monaco.editor.IStandaloneCodeEditor;
  private openModels = new Map<string, monaco.editor.ITextModel>();

  constructor(
    container: HTMLElement,
    private readonly vfs: VirtualFileSystem,
    private readonly session: LanguageServiceSession,
  ) {
    this.editor = monaco.editor.create(container, {
      theme: 'vs-dark',
      automaticLayout: true,
      fontSize: 13,
      minimap: { enabled: false },
    });
  }

  /** Open a file path in the editor, creating a synced Monaco model for it on first open. */
  openFile(path: string): void {
    let model = this.openModels.get(path);
    if (!model) {
      const content = primeModelFromVfs(this.vfs, path);
      const language = path.endsWith('.ts') || path.endsWith('.tsx') ? 'typescript' : 'plaintext';
      model = monaco.editor.createModel(content, language, monaco.Uri.parse(path));
      syncModelToVfs(this.vfs, path, model);
      if (language === 'typescript') {
        registerLanguageProviders(monaco, this.session, model, path);
      }
      this.openModels.set(path, model);
    }
    this.editor.setModel(model);
  }

  dispose(): void {
    this.editor.dispose();
    for (const model of this.openModels.values()) model.dispose();
  }
}
