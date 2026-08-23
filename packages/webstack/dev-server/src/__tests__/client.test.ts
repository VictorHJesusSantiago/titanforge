import { describe, it, expect } from 'vitest';
import { generateHmrClientScript } from '../client.js';

describe('generateHmrClientScript', () => {
  it('embeds the given WebSocket URL', () => {
    const script = generateHmrClientScript('ws://localhost:4321');
    expect(script).toContain(JSON.stringify('ws://localhost:4321'));
    expect(script).toContain('new WebSocket(');
  });

  it('handles both update and full-reload message types', () => {
    const script = generateHmrClientScript('ws://localhost:1');
    expect(script).toContain("msg.type === 'update'");
    expect(script).toContain("msg.type === 'full-reload'");
  });

  it('falls back to a full reload when no app-provided update hook exists', () => {
    const script = generateHmrClientScript('ws://localhost:1');
    expect(script).toContain('window.location.reload()');
    expect(script).toContain('__titanforge_applyUpdate');
  });

  it('produces syntactically valid JavaScript', () => {
    expect(() => new Function(generateHmrClientScript('ws://localhost:1'))).not.toThrow();
  });
});
