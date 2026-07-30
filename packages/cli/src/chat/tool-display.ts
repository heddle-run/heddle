const ARROW_RIGHT = '→';
const ARROW_LEFT = '←';
const ASTERISK = '✱';
const GEAR = '⚙';
const SHELL_PROMPT = '$';

const TOOL_ICONS: Record<string, string> = {
  execute_command: SHELL_PROMPT,
  bash: SHELL_PROMPT,
  read_file: ARROW_RIGHT,
  list_directory: ARROW_RIGHT,
  write_file: ARROW_LEFT,
  edit_file: ARROW_LEFT,
  present_file: ARROW_LEFT,
  search_files: ASTERISK,
  glob: ASTERISK,
  grep: ASTERISK,
};

const DEFAULT_ICON = GEAR;

const MAX_SUMMARY_LENGTH = 40;
const TRUNCATED_SUMMARY_LENGTH = 37;

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;

export function getToolIcon(toolName: string): string {
  return TOOL_ICONS[toolName] ?? DEFAULT_ICON;
}

export function getToolTitle(
  toolName: string,
  toolArgs: Record<string, unknown>,
): string {
  switch (toolName) {
    case 'execute_command':
    case 'bash':
      return String(toolArgs.command ?? '');
    case 'read_file':
      return `Read ${toolArgs.path ?? ''}`;
    case 'write_file':
      return `Write ${toolArgs.path ?? ''}`;
    case 'edit_file':
      return `Edit ${toolArgs.path ?? ''}`;
    case 'present_file':
      return `Present ${toolArgs.name ?? toolArgs.path ?? ''}`;
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
    case 'delegate_task':
      return `Delegate to ${toolArgs.agent_name ?? toolArgs.agent ?? 'agent'}`;
    default:
      return genericTitle(toolName, toolArgs);
  }
}

export function formatDuration(ms: number): string {
  if (ms < MS_PER_SECOND) return `${ms}ms`;

  const seconds = ms / MS_PER_SECOND;
  if (seconds < SECONDS_PER_MINUTE) return `${seconds.toFixed(1)}s`;

  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
  const remainder = seconds % SECONDS_PER_MINUTE;
  return `${minutes}m${remainder.toFixed(0)}s`;
}

function genericTitle(
  toolName: string,
  toolArgs: Record<string, unknown>,
): string {
  const name = titleCase(toolName);

  const argKeys = Object.keys(toolArgs);
  if (argKeys.length === 0) return name;

  return `${name} ${summarize(String(toolArgs[argKeys[0]] ?? ''))}`;
}

function titleCase(toolName: string): string {
  return toolName
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function summarize(value: string): string {
  return value.length > MAX_SUMMARY_LENGTH
    ? `${value.slice(0, TRUNCATED_SUMMARY_LENGTH)}...`
    : value;
}
