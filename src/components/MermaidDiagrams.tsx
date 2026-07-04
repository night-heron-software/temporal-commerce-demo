'use client';

import { useEffect } from 'react';

/**
 * Renders every `<pre class="mermaid">` block on the page into an SVG diagram.
 * Mount once per page that contains server-rendered mermaid source (see
 * renderDocHtml in src/lib/docs.ts). Mermaid is imported lazily so the ~2 MB
 * library never lands in pages without diagrams.
 */
export function MermaidDiagrams() {
  useEffect(() => {
    let cancelled = false;

    async function render() {
      if (document.querySelectorAll('pre.mermaid').length === 0) return;
      const mermaid = (await import('mermaid')).default;
      if (cancelled) return;
      mermaid.initialize({
        startOnLoad: false,
        theme: window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'neutral',
      });
      await mermaid.run({ querySelector: 'pre.mermaid' });
    }

    render().catch((err) => console.error('Mermaid rendering failed:', err));
    return () => {
      cancelled = true;
    };
  }, []);

  return null;
}
