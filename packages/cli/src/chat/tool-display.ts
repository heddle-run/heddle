const TOOL_ICONS: Record<string, string> = {
  execute_command: '$',
  read_file: '\u2192',      // →
  list_directory: '\u2192',  // →
  write_file: '\u2190',     // ←
  edit_file: '\u2190',      // ←
  search_files: '\u2731',   // ✱
  glob: '\u2731',           // ✱
  grep: '\u2731',           // ✱
};

const DEFAULT_ICON = '\u2699'; // ⚙

export function getToolIcon(toolName: string): string {
  return TOOL_ICONS[toolName] ?? DEFAULT_ICON;
}

export function getToolTitle(
  toolName: string,
  toolArgs: Record<string, unknown>,
): string {
  switch (toolName) {
    case 'execute_command':
      return String(toolArgs.command ?? '');
    case 'read_file':
      return `Read ${toolArgs.path ?? ''}`;
    case 'write_file':
      return `Write ${toolArgs.path ?? ''}`;
    case 'edit_file':
      return `Edit ${toolArgs.path ?? ''}`;
    case 'list_directory':
      return `List ${toolArgs.path ?? '.'}`;
    case 'search_files':
      return `Search ${toolArgs.pattern ?? toolArgs.content_pattern ?? ''}`;
    case 'glob':
      return `Glob ${toolArgs.pattern ?? ''}`;
    case 'grep':
      return `Grep ${toolArgs.pattern ?? ''}`;
    case 'write_plan':
      return 'Write plan';
    case 'delegate_task': {
      const agent = toolArgs.agent_name ?? toolArgs.agent ?? 'agent';
      return `Delegate to ${agent}`;
    }
    default: {
      const name = toolName
        .split('_')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
      const argKeys = Object.keys(toolArgs);
      if (argKeys.length === 0) return name;
      const firstVal = String(toolArgs[argKeys[0]] ?? '');
      const summary = firstVal.length > 40 ? firstVal.slice(0, 37) + '...' : firstVal;
      return `${name} ${summary}`;
    }
  }
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainSec = seconds % 60;
  return `${minutes}m${remainSec.toFixed(0)}s`;
}
