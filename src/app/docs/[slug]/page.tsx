import Link from 'next/link';
import { notFound } from 'next/navigation';
import { MermaidDiagrams } from '@/components/MermaidDiagrams';
import { DOC_ENTRIES, getDocBySlug, readDocMarkdown, renderDocHtml } from '@/lib/docs';

export function generateStaticParams() {
  return DOC_ENTRIES.map((entry) => ({ slug: entry.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const entry = getDocBySlug((await params).slug);
  return {
    title: entry ? `${entry.title} — Temporal Commerce Demo` : 'Documentation',
  };
}

export default async function DocPage({ params }: { params: Promise<{ slug: string }> }) {
  const entry = getDocBySlug((await params).slug);
  if (!entry) notFound();

  const html = renderDocHtml(await readDocMarkdown(entry));

  return (
    <div className="max-w-4xl mx-auto p-8">
      <div className="mb-6 flex items-center justify-between text-sm">
        <Link
          href="/docs"
          className="text-sky-600 dark:text-sky-400 hover:text-sky-800 dark:hover:text-sky-300 transition-colors"
        >
          ← All docs
        </Link>
        <span className="text-zinc-400 dark:text-zinc-500 font-mono text-xs">{entry.file}</span>
      </div>
      <article
        className="doc-prose bg-white dark:bg-zinc-800 rounded-xl border border-zinc-200 dark:border-zinc-700 p-8 md:p-10"
        dangerouslySetInnerHTML={{ __html: html }}
      />
      <MermaidDiagrams />
    </div>
  );
}
