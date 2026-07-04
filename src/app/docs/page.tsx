import Link from 'next/link';
import { DOC_ENTRIES, type DocEntry } from '@/lib/docs';

export const metadata = {
  title: 'Documentation — Temporal Commerce Demo',
};

const CATEGORIES: DocEntry['category'][] = ['Start Here', 'Guides', 'Reference'];

export default function DocsIndexPage() {
  return (
    <div className="max-w-4xl mx-auto p-8">
      <h1 className="text-3xl font-bold text-zinc-900 dark:text-zinc-100 mb-2">Documentation</h1>
      <p className="text-zinc-500 dark:text-zinc-400 mb-8">
        The project&apos;s docs, rendered straight from the repo — setup guides, architecture
        notes, and auto-generated state machine diagrams.
      </p>

      {CATEGORIES.map((category) => (
        <section key={category} className="mb-10">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500 mb-4">
            {category}
          </h2>
          <div className="grid md:grid-cols-2 gap-6">
            {DOC_ENTRIES.filter((entry) => entry.category === category).map((entry) => (
              <Link
                key={entry.slug}
                href={`/docs/${entry.slug}`}
                className="group p-6 bg-white dark:bg-zinc-800 rounded-xl border border-zinc-200 dark:border-zinc-700 hover:border-sky-400 dark:hover:border-sky-500 transition-all hover:shadow-lg"
              >
                <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100 group-hover:text-sky-600 dark:group-hover:text-sky-400 transition-colors">
                  {entry.title}
                </h3>
                <p className="text-zinc-500 dark:text-zinc-400 text-sm mt-1">{entry.description}</p>
                <p className="text-zinc-400 dark:text-zinc-500 text-xs mt-3 font-mono">
                  {entry.file}
                </p>
              </Link>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
