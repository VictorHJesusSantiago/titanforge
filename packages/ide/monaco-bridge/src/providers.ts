import type * as Monaco from 'monaco-editor';
import type { LanguageServiceSession, DiagnosticCategory } from '@titanforge/language-service';
import type { Disposable } from './sync.js';

/**
 * DOM/worker-coupled glue: registers @titanforge/language-service as the real provider behind
 * Monaco's completion / hover / definition APIs, and pushes diagnostics as model markers. This
 * file cannot be meaningfully unit-tested outside a real Monaco + DOM environment (Monaco's own
 * `Position`/`Range`/`monaco.languages.*` types and runtime only exist there), so per this
 * project's convention it is kept thin and deliberately under-tested — the logic worth testing
 * (VFS<->model sync) was extracted into sync.ts instead. Every function here is a direct pass
 * through to session methods plus an offset<->position conversion.
 */

const LANGUAGE_ID = 'typescript';

function severityFor(monaco: typeof Monaco, category: DiagnosticCategory): Monaco.MarkerSeverity {
  switch (category) {
    case 'error':
      return monaco.MarkerSeverity.Error;
    case 'warning':
      return monaco.MarkerSeverity.Warning;
    case 'suggestion':
      return monaco.MarkerSeverity.Hint;
    default:
      return monaco.MarkerSeverity.Info;
  }
}

/** Push the language service's diagnostics for `model` onto it as Monaco markers. */
export function refreshDiagnostics(monaco: typeof Monaco, session: LanguageServiceSession, model: Monaco.editor.ITextModel, path: string): void {
  const diagnostics = session.getDiagnostics(path);
  const markers: Monaco.editor.IMarkerData[] = diagnostics.map((d) => {
    const start = model.getPositionAt(d.start);
    const end = model.getPositionAt(d.start + d.length);
    return {
      severity: severityFor(monaco, d.category),
      message: d.message,
      startLineNumber: start.lineNumber,
      startColumn: start.column,
      endLineNumber: end.lineNumber,
      endColumn: end.column,
      code: String(d.code),
    };
  });
  monaco.editor.setModelMarkers(model, '@titanforge/language-service', markers);
}

/**
 * Register completion/hover/definition providers backed by `session`, and keep diagnostics live
 * on every content change. Returns a single disposable that tears everything down.
 */
export function registerLanguageProviders(
  monaco: typeof Monaco,
  session: LanguageServiceSession,
  model: Monaco.editor.ITextModel,
  path: string,
): Disposable {
  const disposables: Disposable[] = [];

  disposables.push(
    monaco.languages.registerCompletionItemProvider(LANGUAGE_ID, {
      provideCompletionItems(m, position) {
        const offset = m.getOffsetAt(position);
        const entries = session.getCompletionsAt(path, offset);
        const word = m.getWordUntilPosition(position);
        const range: Monaco.IRange = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        };
        return {
          suggestions: entries.map((entry) => ({
            label: entry.name,
            kind: monaco.languages.CompletionItemKind.Field,
            insertText: entry.name,
            range,
            ...(entry.isRecommended ? { sortText: '0' } : {}),
          })),
        };
      },
    }),
  );

  disposables.push(
    monaco.languages.registerHoverProvider(LANGUAGE_ID, {
      provideHover(m, position) {
        const offset = m.getOffsetAt(position);
        const hover = session.getHoverInfo(path, offset);
        if (!hover) return null;
        return {
          contents: [{ value: '```typescript\n' + hover.text + '\n```' }, { value: hover.documentation }],
        };
      },
    }),
  );

  disposables.push(
    monaco.languages.registerDefinitionProvider(LANGUAGE_ID, {
      provideDefinition(m, position) {
        const offset = m.getOffsetAt(position);
        const defs = session.getDefinition(path, offset);
        return defs.map((def) => {
          const targetModel = monaco.editor.getModel(monaco.Uri.parse(def.path));
          const start = targetModel ? targetModel.getPositionAt(def.start) : { lineNumber: 1, column: 1 };
          const end = targetModel ? targetModel.getPositionAt(def.start + def.length) : { lineNumber: 1, column: 1 };
          return {
            uri: monaco.Uri.parse(def.path),
            range: {
              startLineNumber: start.lineNumber,
              startColumn: start.column,
              endLineNumber: end.lineNumber,
              endColumn: end.column,
            },
          };
        });
      },
    }),
  );

  const refresh = (): void => refreshDiagnostics(monaco, session, model, path);
  refresh();
  const contentSub = model.onDidChangeContent(refresh);
  disposables.push(contentSub);

  return {
    dispose() {
      for (const d of disposables) d.dispose();
      monaco.editor.setModelMarkers(model, '@titanforge/language-service', []);
    },
  };
}
