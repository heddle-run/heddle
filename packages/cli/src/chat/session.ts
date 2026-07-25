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
  '.specrun',
  'conversations',
);

function ensureDir(): void {
  mkdirSync(SESSIONS_DIR, { recursive: true });
}

function sessionPath(id: string): string {
  return join(SESSIONS_DIR, `${id}.json`);
}

/** Create a new chat session with a unique ID. */
export function createSession(flowPath: string): ChatSession {
  ensureDir();
  const now = new Date();
  const id = `chat-${now.toISOString().replace(/[:.]/g, '-')}`;
  const session: ChatSession = {
    id,
    flowPath,
    createdAt: now.toISOString(),
    messages: [],
  };
  persist(session);
  return session;
}

/** Append a message to the session and persist to disk. */
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

/** Load an existing session by ID. */
export function loadSession(id: string): ChatSession {
  const p = sessionPath(id);
  if (!existsSync(p)) {
    throw new Error(`session "${id}" not found at ${p}`);
  }
  return JSON.parse(readFileSync(p, 'utf-8'));
}

function persist(session: ChatSession): void {
  writeFileSync(sessionPath(session.id), JSON.stringify(session, null, 2));
}
