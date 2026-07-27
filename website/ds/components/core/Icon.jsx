import React from 'react';
import {
  Activity, AlignLeft, ArrowRight, ArrowUpRight, BookOpen, Bot, Boxes, Braces, Blocks,
  Calendar, Check, CheckCheck, ChevronDown, ChevronRight, CircleCheckBig, CircleDot,
  CirclePlay, CloudUpload, Code, CodeXml, Columns2, Columns3, Copy, Cpu, CreditCard,
  Ellipsis, ExternalLink, FileCode, FileJson, GitBranch, GitMerge, Github, Hammer,
  Layers, LayoutTemplate, ListChecks, Mail, Menu, MessageSquare, Minus, Network,
  Package, Palette, PenTool, Play, Plug, Plus, Quote, Repeat, RotateCcw, Rocket,
  ScrollText, Settings, Settings2, Share2, Shield, Shuffle, SlidersHorizontal,
  Sparkles, Spline, Square, SquareCheck, Sun, Moon, Table, Terminal, ToggleLeft,
  Type, Waypoints, Webhook, Workflow, Wrench, X, Zap,
} from 'lucide-react';

/** Lucide glyph, resolved from an explicit registry.
 *
 *  DEVIATION from upstream (see ds/DEVIATIONS.md): upstream renders an Iconify
 *  <span> and needs code.iconify.design at runtime. This site is a static
 *  export, so the same Lucide set is delivered through lucide-react instead.
 *  The API is unchanged — kebab-case `name`, `size`, `color`.
 *
 *  Registry keys are upstream's kebab names, including the ones lucide-react
 *  0.474 has since renamed (play-circle, check-square, check-circle-2,
 *  upload-cloud, more-horizontal, code-2), so upstream markup keeps working.
 *
 *  strokeWidth defaults to Lucide's own 2 — which is what Iconify renders
 *  upstream, and reads as the ~1.5px stroke the design system describes once
 *  scaled down from the 24px grid.
 */
const REGISTRY = {
  activity: Activity, 'align-left': AlignLeft, 'arrow-right': ArrowRight,
  'arrow-up-right': ArrowUpRight, 'book-open': BookOpen, boxes: Boxes, braces: Braces,
  blocks: Blocks, calendar: Calendar, check: Check, 'check-check': CheckCheck,
  'chevron-down': ChevronDown, 'chevron-right': ChevronRight,
  'check-circle-2': CircleCheckBig, 'circle-check-big': CircleCheckBig,
  'circle-dot': CircleDot, 'play-circle': CirclePlay, 'circle-play': CirclePlay, bot: Bot,
  'message-square': MessageSquare, shuffle: Shuffle,
  'upload-cloud': CloudUpload, 'cloud-upload': CloudUpload, code: Code,
  'code-2': CodeXml, 'code-xml': CodeXml, columns: Columns2, columns2: Columns2,
  columns3: Columns3, copy: Copy, cpu: Cpu, 'credit-card': CreditCard,
  'more-horizontal': Ellipsis, ellipsis: Ellipsis, 'external-link': ExternalLink,
  'file-code': FileCode, 'file-json': FileJson, 'git-branch': GitBranch,
  'git-merge': GitMerge, github: Github, hammer: Hammer, layers: Layers,
  'layout-template': LayoutTemplate, 'list-checks': ListChecks, mail: Mail,
  menu: Menu, minus: Minus, moon: Moon, network: Network, package: Package,
  palette: Palette, 'pen-tool': PenTool, play: Play, plug: Plug, plus: Plus,
  quote: Quote, repeat: Repeat, 'rotate-ccw': RotateCcw, rocket: Rocket,
  'scroll-text': ScrollText, settings: Settings, 'settings-2': Settings2,
  'share-2': Share2, shield: Shield, 'sliders-horizontal': SlidersHorizontal,
  sparkles: Sparkles, spline: Spline, square: Square, 'check-square': SquareCheck,
  'square-check': SquareCheck, sun: Sun, table: Table, terminal: Terminal,
  'toggle-left': ToggleLeft, type: Type, waypoints: Waypoints, webhook: Webhook,
  workflow: Workflow, wrench: Wrench, x: X, zap: Zap,
};

export function Icon({ name, size = 16, color, strokeWidth = 2, className = '', style, ...rest }) {
  const key = name.includes(':') ? name.slice(name.indexOf(':') + 1) : name;
  const Glyph = REGISTRY[key];
  if (!Glyph) {
    if (process.env.NODE_ENV !== 'production') {
      throw new Error(
        `Icon: "${key}" is not in the registry. Import it in ds/components/core/Icon.jsx ` +
        `and add it to REGISTRY. Available: ${Object.keys(REGISTRY).sort().join(', ')}`
      );
    }
    return null;
  }
  return (
    <Glyph
      size={size}
      strokeWidth={strokeWidth}
      className={className}
      style={{ color, display: 'inline-block', flex: '0 0 auto', ...style }}
      {...rest}
    />
  );
}
