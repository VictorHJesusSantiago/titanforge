import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

/**
 * Monaco needs to hand off tokenization/validation work to web workers. Vite's `?worker` import
 * suffix bundles each worker entry point as a separate chunk and gives us a constructible Worker
 * class — this is the standard "Monaco + Vite" wiring documented by both projects; there is no
 * from-scratch alternative here, this is just required plumbing, not a simplification.
 */
export function installMonacoEnvironment(): void {
  // monaco-editor's own ambient typings declare this as `let MonacoEnvironment`, not `var` — a
  // block-scoped global never becomes a property of `globalThis` at runtime (only `var` does),
  // so it must be assigned as a bare identifier here, not via `globalThis.MonacoEnvironment`.
  MonacoEnvironment = {
    getWorker(_moduleId: string, label: string) {
      if (label === 'typescript' || label === 'javascript') {
        return new TsWorker();
      }
      return new EditorWorker();
    },
  };
}
