/**
 * Project Documentation — manifest and markdown rendering
 *
 * Serves the repo's markdown docs (README, GETTING_STARTED, docs/*) inside the
 * app at /docs. Files are read from the repo root at request time, so the pages
 * always reflect the working tree. Only files listed in DOC_ENTRIES are
 * reachable — the slug is the sole lookup key, so there is no path traversal.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { Marked, type RendererObject, type Tokens } from 'marked';

export interface DocEntry {
  slug: string;
  title: string;
  description: string;
  /** Path relative to the repo root */
  file: string;
  category: 'Start Here' | 'Guides' | 'Reference';
}

export const DOC_ENTRIES: DocEntry[] = [
  {
    slug: 'readme',
    title: 'README',
    description:
      'Project overview — what the demo is, the architecture at a glance, and where everything lives.',
    file: 'README.md',
    category: 'Start Here',
  },
  {
    slug: 'getting-started',
    title: 'Getting Started',
    description: 'Get the demo running from a fresh clone — prerequisites, infra, seed data.',
    file: 'GETTING_STARTED.md',
    category: 'Start Here',
  },
  {
    slug: 'demo-instructions',
    title: 'Demo Instructions',
    description:
      'Step-by-step instructions for a 4–5 minute live demonstration — setup, screen layout, walkthrough.',
    file: 'docs/demo-instructions.md',
    category: 'Start Here',
  },
  {
    slug: 'project-description',
    title: 'Project Description',
    description:
      'Why every state transition is a Temporal workflow — no queues, no cron, no saga orchestrators.',
    file: 'docs/project-description.md',
    category: 'Guides',
  },
  {
    slug: 'developer-guide',
    title: 'Developer Guide',
    description:
      'Comprehensive guide to the six domain workflows, the authoring layer, and the projection pipeline.',
    file: 'docs/developer-guide.md',
    category: 'Guides',
  },
  {
    slug: 'presentation-script',
    title: 'Presentation Script',
    description:
      'Modular walkthrough script for presenting the demo — sections can be combined or delivered independently.',
    file: 'docs/presentation-script.md',
    category: 'Guides',
  },
  {
    slug: 'temporal-lessons-learned',
    title: 'Temporal Lessons Learned',
    description:
      'Hard-won patterns from real workflow failures, performance bottlenecks, and architectural dead ends.',
    file: 'docs/temporal-lessons-learned.md',
    category: 'Guides',
  },
  {
    slug: 'cloud-deployment',
    title: 'Cloud Deployment',
    description: 'Deploying the demo to Temporal Cloud + Google Cloud for live presentation.',
    file: 'docs/cloud-deployment.md',
    category: 'Guides',
  },
  {
    slug: 'state-machine-diagrams',
    title: 'State Machine Reference',
    description:
      'Auto-generated mermaid diagrams and event tables for every domain state machine, plus cross-domain orchestration.',
    file: 'docs/reference/state-machine-diagrams.md',
    category: 'Reference',
  },
];

export function getDocBySlug(slug: string): DocEntry | undefined {
  return DOC_ENTRIES.find((entry) => entry.slug === slug);
}

/** Maps a doc filename (basename, lowercased) to its slug, for cross-doc links. */
const FILE_TO_SLUG = new Map(
  DOC_ENTRIES.map((entry) => [path.basename(entry.file).toLowerCase(), entry.slug])
);

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** GitHub-style heading slugs so in-document TOC links keep working. */
function createHeadingSlugger() {
  const seen = new Map<string, number>();
  return (rawText: string): string => {
    const base = rawText
      .toLowerCase()
      .trim()
      .replace(/<[^>]+>/g, '')
      // parseInline HTML-escapes the text; decode entities so e.g. "&" ("&amp;")
      // is dropped like GitHub does instead of leaving a literal "amp"
      .replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) =>
        entity === '&amp;' ? '&' : entity === '&lt;' ? '<' : entity === '&gt;' ? '>' : entity === '&quot;' ? '"' : "'"
      )
      .replace(/[^\p{L}\p{N} _-]/gu, '')
      .replace(/ /g, '-');
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}-${count}`;
  };
}

/**
 * Rewrites a markdown link target for in-app rendering:
 * - external / mailto / same-page anchors pass through
 * - links to another doc's .md file become /docs/<slug> (fragment preserved)
 * - other relative links (e.g. source files) resolve to null → rendered unlinked
 */
function resolveHref(href: string): string | null {
  if (/^(https?:|mailto:|#)/i.test(href)) return href;
  const [target, fragment] = href.split('#', 2);
  const slug = FILE_TO_SLUG.get(path.basename(target).toLowerCase());
  if (target.toLowerCase().endsWith('.md') && slug) {
    return `/docs/${slug}${fragment ? `#${fragment}` : ''}`;
  }
  return null;
}

/**
 * Renders a doc's markdown to HTML.
 * Mermaid fences become <pre class="mermaid"> for client-side rendering
 * (see MermaidDiagrams component).
 */
export function renderDocHtml(markdown: string): string {
  const headingSlug = createHeadingSlugger();

  const renderer: RendererObject = {
    code({ text, lang }: Tokens.Code) {
      const language = (lang ?? '').trim().split(/\s+/)[0];
      if (language === 'mermaid') {
        return `<pre class="mermaid">${escapeHtml(text)}</pre>\n`;
      }
      return false;
    },
    heading({ tokens, depth }: Tokens.Heading) {
      const text = this.parser.parseInline(tokens);
      const id = headingSlug(text.replace(/<[^>]+>/g, ''));
      return `<h${depth} id="${id}">${text}</h${depth}>\n`;
    },
    link({ href, title, tokens }: Tokens.Link) {
      const text = this.parser.parseInline(tokens);
      const resolved = resolveHref(href);
      if (resolved === null) {
        // Relative link with no in-app target (e.g. a source file) — show unlinked.
        return `<span class="doc-deadlink">${text}</span>`;
      }
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
      const externalAttrs = /^https?:/i.test(resolved)
        ? ' target="_blank" rel="noopener noreferrer"'
        : '';
      return `<a href="${resolved}"${titleAttr}${externalAttrs}>${text}</a>`;
    },
  };

  const marked = new Marked({ gfm: true });
  marked.use({ renderer });
  return marked.parse(markdown, { async: false });
}

export async function readDocMarkdown(entry: DocEntry): Promise<string> {
  return fs.readFile(path.join(process.cwd(), entry.file), 'utf8');
}
