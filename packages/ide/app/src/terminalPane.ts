import type { Shell } from '@titanforge/shell';

/**
 * A small hand-built scrollback+input terminal UI, wired to a real @titanforge/shell instance.
 * Scope choice: the task allowed either xterm.js or a hand-built div — this app uses the
 * hand-built version to avoid adding a second heavy runtime dependency (xterm.js pulls in its
 * own canvas/webgl renderer and addon ecosystem) on top of monaco-editor, since our shell has no
 * need for xterm's terminal-emulation features (ANSI escape codes, PTY resize, etc.) — it's a
 * plain command line reading/writing a virtual filesystem, not a real TTY. This is DOM-assembly
 * glue and is not unit-tested, consistent with this project's stated convention.
 */
export function mountTerminal(root: HTMLElement, shell: Shell): void {
  const output = root.querySelector<HTMLDivElement>('#terminal-output');
  const input = root.querySelector<HTMLInputElement>('#terminal-input');
  if (!output || !input) throw new Error('terminal DOM structure missing expected elements');

  const history: string[] = [];
  let historyIndex = -1;

  function appendLine(text: string, className?: string): void {
    const line = document.createElement('div');
    if (className) line.className = className;
    line.textContent = text;
    output!.appendChild(line);
    output!.scrollTop = output!.scrollHeight;
  }

  async function runCommand(commandLine: string): Promise<void> {
    appendLine(`${shell.cwd} $ ${commandLine}`);
    const result = await shell.run(commandLine);
    if (result.stdout) appendLine(result.stdout);
    if (result.stderr) appendLine(result.stderr, 'term-stderr');
  }

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      const commandLine = input.value;
      input.value = '';
      if (commandLine.trim().length > 0) {
        history.push(commandLine);
        historyIndex = history.length;
        void runCommand(commandLine);
      }
    } else if (event.key === 'ArrowUp') {
      if (historyIndex > 0) {
        historyIndex -= 1;
        input.value = history[historyIndex] ?? '';
      }
      event.preventDefault();
    } else if (event.key === 'ArrowDown') {
      if (historyIndex < history.length) {
        historyIndex += 1;
        input.value = history[historyIndex] ?? '';
      }
      event.preventDefault();
    }
  });

  appendLine('titanforge shell — a real command interpreter over an in-memory VFS.');
  appendLine("try: ls, cd, cat, echo, mkdir, run <file.ts>");
}
