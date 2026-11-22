/**
 * Builds the pages in docs/ into dist-docs/ for getstarchat.net/docs/. The pages use
 * the stylesheets of the website (../vendor/bootstrap.min.css, ../style.css), so the
 * output only looks right inside the site.
 *
 * Links between the Markdown files become links between the pages. Links to other
 * files of the repository point to GitHub. docs/openapi.yaml becomes the API reference
 * (api.html) and is copied along.
 */
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Marked } from 'marked';
import { parse as parseYaml } from 'yaml';
import { renderOpenApi } from './render-openapi.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_URL = 'https://github.com/starchat-irc/starchat';
const SITE_URL = 'https://getstarchat.net';

/** Order of the sidebar. Every Markdown file in docs/ has to be listed here. */
export const PAGES = [
    { file: 'index.md', title: 'Overview' },
    { file: 'features.md', title: 'Features' },
    { file: 'hosting.md', title: 'Hosting the web client' },
    { file: 'desktop.md', title: 'Desktop app' },
    { file: 'mobile.md', title: 'Mobile app' },
    { file: 'options.md', title: 'mountChat() options' },
    { file: 'embedding.md', title: 'Embedding with login' },
    { file: 'servers.md', title: 'Server list' },
    { file: 'discovery.md', title: 'Discovery file' },
    { file: 'openapi.yaml', title: 'API reference' },
    { file: 'commands.md', title: 'Commands and shortcuts' },
    { file: 'ircv3.md', title: 'IRCv3 support' },
];

/** File name of the page built from a file in docs/. */
export function pageName(file) {
    return file === 'openapi.yaml' ? 'api.html' : file.replace(/\.md$/, '.html');
}

export function escapeHtml(text) {
    return String(text)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
}

/** Anchor of a heading, the same way GitHub builds it for plain text. */
export function slugify(text) {
    return text
        .toLowerCase()
        .replace(/<[^>]+>/g, '')
        .replace(/&[a-z]+;/g, '')
        .replace(/[^\p{L}\p{N}\s-]/gu, '')
        .trim()
        .replace(/\s/g, '-');
}

/**
 * @param {string} href Link target as written in docs/<file>.
 * @return {string} Target on the website.
 */
export function rewriteHref(href) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#') || href.startsWith('//')) {
        return href;
    }
    const [target, anchor] = href.split('#');
    const hash = anchor ? `#${anchor}` : '';
    const resolved = path.posix.normalize(path.posix.join('docs', target));

    if (resolved === 'docs/openapi.yaml' || (resolved.startsWith('docs/') && resolved.endsWith('.md'))) {
        return pageName(resolved.slice('docs/'.length)) + hash;
    }
    if (resolved.startsWith('docs/') && resolved.endsWith('.json')) {
        return resolved.slice('docs/'.length);
    }
    return `${REPO_URL}/blob/main/${resolved}${hash}`;
}

function createMarkdown() {
    return new Marked({
        gfm: true,
        renderer: {
            heading({ tokens, depth }) {
                const html = this.parser.parseInline(tokens);
                return `<h${depth} id="${slugify(html)}">${html}</h${depth}>\n`;
            },
            link({ href, title, tokens }) {
                const text = this.parser.parseInline(tokens);
                const titleAttribute = title ? ` title="${escapeHtml(title)}"` : '';
                return `<a href="${escapeHtml(rewriteHref(href))}"${titleAttribute}>${text}</a>`;
            },
        },
    });
}

/** Text of the first paragraph, shortened for the meta description. */
export function describe(html, maxLength = 160) {
    const paragraph = html.match(/<p>(.*?)<\/p>/s);
    if (!paragraph) {
        return '';
    }
    const text = paragraph[1]
        .replace(/<[^>]+>/g, '')
        .replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&#39;', "'")
        .replace(/\s+/g, ' ')
        .trim()
        // A paragraph that leads into a code block ends with a colon
        .replace(/:$/, '.');
    if (text.length <= maxLength) {
        return text;
    }
    return `${text.slice(0, text.lastIndexOf(' ', maxLength - 3))}...`;
}

/** Public address of a docs page. */
export function pageUrl(file) {
    return file === 'index.md' ? `${SITE_URL}/docs/` : `${SITE_URL}/docs/${pageName(file)}`;
}

/**
 * @param {string} markdown
 * @return {{ title: string, html: string }} Title is the text of the first h1.
 */
export function renderMarkdown(markdown) {
    const html = createMarkdown()
        .parse(markdown)
        .replaceAll('<table>', '<div class="table-responsive"><table class="table">')
        .replaceAll('</table>', '</table></div>');
    const heading = html.match(/<h1[^>]*>(.*?)<\/h1>/s);
    const title = heading ? heading[1].replace(/<[^>]+>/g, '') : '';
    return { title, html };
}

/**
 * @param {string} yamlText Content of docs/openapi.yaml.
 * @return {{ title: string, html: string }}
 */
export function renderApiReference(yamlText) {
    const marked = createMarkdown();
    const markdown = (text, block = false) => (block ? renderMarkdown(text).html : marked.parseInline(text));
    return renderOpenApi(parseYaml(yamlText), markdown);
}

/** Full page in the layout of getstarchat.net. Paths are relative to /docs/. */
export function renderPage({ title, html, file }) {
    const sidebar = PAGES.map((page) => {
        const href = pageName(page.file);
        const current = page.file === file ? ' active" aria-current="page' : '';
        return `                <li class="nav-item"><a class="nav-link${current}" href="${href}">${escapeHtml(page.title)}</a></li>`;
    }).join('\n');
    const pageTitle = file === 'index.md' ? 'StarChat documentation' : `${title} | StarChat documentation`;
    const source = `${REPO_URL}/blob/main/docs/${file}`;
    const description = escapeHtml(describe(html));
    const url = pageUrl(file);

    return `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(pageTitle)}</title>
    <meta name="description" content="${description}">
    <link rel="canonical" href="${url}">
    <link rel="icon" href="../favicon.svg" type="image/svg+xml">
    <link rel="apple-touch-icon" href="../apple-touch-icon.png">
    <meta property="og:type" content="article">
    <meta property="og:site_name" content="StarChat">
    <meta property="og:title" content="${escapeHtml(pageTitle)}">
    <meta property="og:description" content="${description}">
    <meta property="og:url" content="${url}">
    <meta property="og:image" content="${SITE_URL}/img/og.png">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta name="twitter:card" content="summary_large_image">
    <script>document.documentElement.dataset.bsTheme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';</script>
    <link rel="stylesheet" href="../vendor/bootstrap.min.css">
    <link rel="stylesheet" href="../style.css">
</head>
<body>
<nav class="navbar navbar-expand border-bottom">
    <div class="container">
        <a class="navbar-brand fw-bold" href="../">StarChat</a>
        <ul class="navbar-nav ms-auto gap-2">
            <li class="nav-item"><a class="nav-link" href="../">About</a></li>
            <li class="nav-item"><a class="nav-link" href="../install.html">Install</a></li>
            <li class="nav-item"><a class="nav-link active" aria-current="page" href="./">Docs</a></li>
            <li class="nav-item"><a class="nav-link" href="${REPO_URL}">GitHub</a></li>
        </ul>
    </div>
</nav>

<div class="container py-5">
    <div class="row g-4 g-lg-5">
        <aside class="col-lg-3">
            <nav class="docs-nav sticky-lg-top">
                <ul class="nav flex-column">
${sidebar}
                </ul>
            </nav>
        </aside>
        <main class="col-lg-9">
            <div class="card doc"><div class="card-body p-4 p-lg-5">
${html}
            <p class="text-body-secondary small mt-5 mb-0"><a href="${source}">Edit this page on GitHub</a></p>
            </div></div>
        </main>
    </div>
</div>

<footer class="border-top py-4 text-body-secondary small">
    <div class="container d-flex flex-wrap gap-3">
        <span>StarChat is licensed under the <a href="${REPO_URL}/blob/main/LICENSE">MIT License</a>.</span>
        <a href="${REPO_URL}">GitHub</a>
        <a href="https://st-city.net/impressum">Imprint</a>
    </div>
</footer>
</body>
</html>
`;
}

/**
 * @param {Object} [options]
 * @param {string} [options.srcDir]
 * @param {string} [options.outDir]
 * @return {Promise<string[]>} Written file names.
 */
export async function buildDocs({ srcDir = path.join(ROOT, 'docs'), outDir = path.join(ROOT, 'dist-docs') } = {}) {
    const entries = await readdir(srcDir);
    const unlisted = entries.filter((name) => name.endsWith('.md') && !PAGES.some((page) => page.file === name));
    if (unlisted.length) {
        throw new Error(`Not in PAGES of scripts/build-docs.mjs: ${unlisted.join(', ')}`);
    }

    await rm(outDir, { recursive: true, force: true });
    await mkdir(outDir, { recursive: true });
    const written = [];

    for (const page of PAGES) {
        const source = await readFile(path.join(srcDir, page.file), 'utf8');
        const { title, html } = page.file === 'openapi.yaml' ? renderApiReference(source) : renderMarkdown(source);
        const name = pageName(page.file);
        await writeFile(path.join(outDir, name), renderPage({ title: title || page.title, html, file: page.file }));
        written.push(name);
    }
    const sitemap = PAGES.map((page) => `    <url><loc>${pageUrl(page.file)}</loc></url>`).join('\n');
    await writeFile(path.join(outDir, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemap}
</urlset>
`);
    written.push('sitemap.xml');

    for (const name of entries.filter((entry) => entry.endsWith('.json') || entry.endsWith('.yaml'))) {
        await cp(path.join(srcDir, name), path.join(outDir, name));
        written.push(name);
    }
    return written;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const written = await buildDocs();
    console.log(`dist-docs: ${written.join(', ')}`);
}
