import { describe, expect, it } from 'vitest';
import { describeAsk, parseApproval } from '../ui.js';

describe('parseApproval', () => {
  it('reads the yes words as approval', () => {
    for (const word of ['y', 'yes', 'YES', ' approve ', 'ok', 'allow']) {
      expect(parseApproval(word)).toEqual({ approved: true });
    }
  });

  it('reads the no words as refusal', () => {
    for (const word of ['n', 'no', 'deny', 'reject', 'cancel']) {
      expect(parseApproval(word)).toEqual({ approved: false });
    }
  });

  it('accepts a raw JSON object for a richer reply', () => {
    expect(parseApproval('{"approved":true,"note":"once"}')).toEqual({
      approved: true,
      note: 'once',
    });
  });

  it('refuses anything it does not understand', () => {
    // The safe default for an unreadable approval is not to approve.
    expect(parseApproval('maybe later')).toEqual({ approved: false });
    expect(parseApproval('')).toEqual({ approved: false });
    expect(parseApproval('42')).toEqual({ approved: false });
  });
});

describe('describeAsk', () => {
  it('leads with the question and shows the command when there is one', () => {
    const line = describeAsk({
      question: 'Run this command with escalated permissions?',
      command: 'npm install',
      tool: 'shell_command',
    });
    expect(line).toContain('Run this command with escalated permissions?');
    expect(line).toContain('npm install');
  });

  it('falls back to the tool name, then to a default question', () => {
    expect(describeAsk({ tool: 'apply_patch' })).toContain('apply_patch');
    expect(describeAsk({})).toBe('Approve this action?');
  });
});
