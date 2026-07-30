import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export interface ChatSession {
  id: string;
  flowPath: string;
  createdAt: string;
  messages: ChatMessage[];
}

const SESSIONS_DIR = join(
  process.env.HOME ?? process.cwd(),
  '.heddle',
  'conversations',
);

const UNSAFE_ID_CHARS = /[:.]/g;

export function createSession(flowPath: string): ChatSession {
  mkdirSync(SESSIONS_DIR, { recursive: true });

  const now = new Date();
  const session: ChatSession = {
    id: `chat-${now.toISOString().replace(UNSAFE_ID_CHARS, '-')}`,
    flowPath,
    createdAt: now.toISOString(),
    messages: [],
  };

  persist(session);
  return session;
}

export function addMessage(
  session: ChatSession,
  role: 'user' | 'assistant',
  content: string,
): void {
  session.messages.push({
    role,
    content,
    timestamp: new Date().toISOString(),
  });
  persist(session);
}

export function loadSession(id: string): ChatSession {
  const path = sessionPath(id);
  if (!existsSync(path)) {
    throw new Error(`session "${id}" not found at ${path}`);
  }
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function persist(session: ChatSession): void {
  writeFileSync(sessionPath(session.id), JSON.stringify(session, null, 2));
}

function sessionPath(id: string): string {
  return join(SESSIONS_DIR, `${id}.json`);
}
