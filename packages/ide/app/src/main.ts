import 'monaco-editor/min/vs/editor/editor.main.css';
import { VirtualFileSystem } from '@titanforge/vfs';
import { LanguageServiceSession } from '@titanforge/language-service';
import { Shell } from '@titanforge/shell';
import { installMonacoEnvironment } from './monacoEnvironment.js';
import { EditorPane } from './editorPane.js';
import { mountTerminal } from './terminalPane.js';
import { mountDebugPanel } from './debugPanel.js';
import { buildFileTree, flattenFileTree } from './fileTree.js';
import { TOY_DEBUG_PROGRAM, TOY_DEBUG_BREAKPOINT_LINES } from './toyProgram.js';

installMonacoEnvironment();

const vfs = new VirtualFileSystem();

// Seed a small starter project so the IDE has something real to show on load.
vfs.writeFile(
  '/src/index.ts',
  [
    'export interface Point {',
    '  x: number;',
    '  y: number;',
    '}',
    '',
    'export function distance(a: Point, b: Point): number {',
    '  const dx = a.x - b.x;',
    '  const dy = a.y - b.y;',
    '  return Math.sqrt(dx * dx + dy * dy);',
    '}',
    '',
    'const origin: Point = { x: 0, y: 0 };',
    'console.log(distance(origin, { x: 3, y: 4 }));',
    '',
  ].join('\n'),
);
vfs.writeFile('/package.json', JSON.stringify({ name: 'scratch', version: '0.0.0' }, null, 2) + '\n');
vfs.writeFile('/toy.tf', TOY_DEBUG_PROGRAM);

const session = new LanguageServiceSession(vfs);
const shell = new Shell(vfs, '/');

const app = document.getElementById('app');
if (!app) throw new Error('#app root missing from index.html');

// --- editor -------------------------------------------------------------
const editorContainer = document.getElementById('editor-pane');
if (!editorContainer) throw new Error('#editor-pane missing');
const editorPane = new EditorPane(editorContainer, vfs, session);
editorPane.openFile('/src/index.ts');

// --- file tree ------------------------------------------------------------
function renderFileTree(): void {
  const treeEl = document.getElementById('file-tree');
  if (!treeEl) return;
  treeEl.innerHTML = '';
  const tree = buildFileTree(vfs);
  for (const { node, depth } of flattenFileTree(tree)) {
    if (node.path === '/') continue;
    const row = document.createElement('div');
    row.className = `tree-row ${node.type}`;
    row.style.paddingLeft = `${8 + depth * 12}px`;
    row.textContent = node.type === 'dir' ? `\u{1F4C1} ${node.name}` : node.name;
    if (node.type === 'file') {
      row.addEventListener('click', () => {
        editorPane.openFile(node.path);
        treeEl.querySelectorAll('.tree-row').forEach((r) => r.classList.remove('active'));
        row.classList.add('active');
      });
    }
    treeEl.appendChild(row);
  }
}
renderFileTree();
vfs.watch('/', () => renderFileTree());

// --- terminal -------------------------------------------------------------
mountTerminal(app, shell);

// --- debug panel ------------------------------------------------------------
mountDebugPanel(app, TOY_DEBUG_PROGRAM, TOY_DEBUG_BREAKPOINT_LINES);
