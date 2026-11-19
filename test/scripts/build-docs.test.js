import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildDocs, describe as describeText, PAGES, pageUrl, renderMarkdown, rewriteHref, slugify } from '../../scripts/build-docs.mjs';

describe('rewriteHref', () => {
    it('turns links between docs into links between pages', () => {
        expect(rewriteHref('options.md')).toBe('options.html');
        expect(rewriteHref('options.md#own-commands')).toBe('options.html#own-commands');
        expect(rewriteHref('discovery.schema.json')).toBe('discovery.schema.json');
    });

    it('points other repository files to GitHub', () => {
        expect(rewriteHref('../servers/servers.json'))
            .toBe('https://github.com/starchat-irc/starchat/blob/main/servers/servers.json');
        expect(rewriteHref('../LICENSE')).toBe('https://github.com/starchat-irc/starchat/blob/main/LICENSE');
    });

    it('keeps absolute links and anchors', () => {
        expect(rewriteHref('https://ergo.chat')).toBe('https://ergo.chat');
        expect(rewriteHref('#fields')).toBe('#fields');
        expect(rewriteHref('mailto:a@example.org')).toBe('mailto:a@example.org');
    });
});

describe('renderMarkdown', () => {
    it('gives headings an anchor and returns the title', () => {
        const { title, html } = renderMarkdown('# `mountChat()` options\n\n## Own commands\n');
        expect(title).toBe('mountChat() options');
        expect(html).toContain('<h2 id="own-commands">Own commands</h2>');
        expect(slugify('<code>mountChat()</code> options')).toBe('mountchat-options');
    });

    it('wraps tables for small screens', () => {
        const { html } = renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |\n');
        expect(html).toContain('<div class="table-responsive"><table class="table">');
        expect(html).toContain('</table></div>');
    });

    it('escapes link targets', () => {
        const { html } = renderMarkdown('[x](https://example.org/?a="b")');
        expect(html).toContain('href="https://example.org/?a=&quot;b&quot;"');
    });
});

describe('page metadata', () => {
    it('takes the first paragraph as description, without markup', () => {
        const { html } = renderMarkdown('# Title\n\n`mountChat()` renders the chat & more.\n\nSecond.\n');
        expect(describeText(html)).toBe('mountChat() renders the chat & more.');
    });

    it('ends a paragraph that leads into a code block with a period', () => {
        expect(describeText('<p>The file is served at this address:</p>')).toBe('The file is served at this address.');
    });

    it('shortens long descriptions at a word', () => {
        const text = describeText(`<p>${'word '.repeat(60)}</p>`);
        expect(text.length).toBeLessThanOrEqual(160);
        expect(text.endsWith('word...')).toBe(true);
    });

    it('builds the public address of a page', () => {
        expect(pageUrl('index.md')).toBe('https://getstarchat.net/docs/');
        expect(pageUrl('options.md')).toBe('https://getstarchat.net/docs/options.html');
    });
});

describe('buildDocs', () => {
    let outDir;
    let written;

    beforeAll(async () => {
        outDir = await mkdtemp(path.join(tmpdir(), 'starchat-docs-'));
        written = await buildDocs({ outDir });
    });

    afterAll(async () => {
        await rm(outDir, { recursive: true, force: true });
    });

    it('writes one page per entry of PAGES plus the JSON files', async () => {
        for (const page of PAGES) {
            expect(written).toContain(page.file.replace('.md', '.html'));
        }
        expect(written).toContain('discovery.schema.json');
        expect(written).toContain('sitemap.xml');
        expect((await readdir(outDir)).sort()).toEqual([...written].sort());
    });

    it('lists every page in the sitemap and gives each a description', async () => {
        const sitemap = await readFile(path.join(outDir, 'sitemap.xml'), 'utf8');
        for (const page of PAGES) {
            expect(sitemap).toContain(`<loc>${pageUrl(page.file)}</loc>`);
            const html = await readFile(path.join(outDir, page.file.replace('.md', '.html')), 'utf8');
            expect(html).toMatch(/<meta name="description" content="[^"]{20,}">/);
        }
    });

    it('has no broken links between the pages', async () => {
        const pages = Object.fromEntries(await Promise.all(
            written.filter((name) => name.endsWith('.html'))
                .map(async (name) => [name, await readFile(path.join(outDir, name), 'utf8')]),
        ));
        const broken = [];

        for (const [name, html] of Object.entries(pages)) {
            for (const [, href] of html.matchAll(/href="([^"]+)"/g)) {
                if (/^(https?:|mailto:|\.\.\/|\.\/$)/.test(href)) continue;
                const [file, anchor] = href.split('#');
                const target = file || name;
                if (!written.includes(target)) {
                    broken.push(`${name}: ${href}`);
                } else if (anchor && !pages[target]?.includes(`id="${anchor}"`)) {
                    broken.push(`${name}: ${href} (anchor)`);
                }
            }
        }
        expect(broken).toEqual([]);
    });
});
