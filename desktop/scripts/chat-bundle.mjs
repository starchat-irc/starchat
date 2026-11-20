/**
 * Signed chat update for installed desktop apps (see chat-bundles.js and docs/desktop.md).
 *
 *   node scripts/chat-bundle.mjs --key <private.pem> --out <folder> [--edition <folder>]
 *
 * Builds the chat page of the edition (scripts/build.mjs prepare) unless --skip-build is
 * given, then writes <folder>/<version>/... and <folder>/manifest.json. Upload the whole
 * folder so that manifest.json is reachable at chatBundles.manifestUrl of the edition.
 * The version is a hash of the files: the same chat gives the same version, so apps do not
 * download it again.
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
export const MANIFEST = 'manifest.json';

/** Files the app writes itself and that are not part of an update. */
const LOCAL_ONLY = new Set(['build.json']);

function listFiles(dir, prefix = '') {
    const entries = [];
    for (const entry of fs.readdirSync(path.join(dir, prefix), { withFileTypes: true })) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) entries.push(...listFiles(dir, relative));
        else if (entry.isFile() && !LOCAL_ONLY.has(relative)) entries.push(relative);
    }
    return entries.sort();
}

/**
 * @param {{ chatDir: string, outDir: string, privateKeyPem: string, nativeApi: number, now?: () => number }} options
 * @return {{ version: string, nativeApi: number, builtAt: number, files: { path: string, sha256: string, size: number }[] }}
 */
export function createChatBundle({ chatDir, outDir, privateKeyPem, nativeApi, now = Date.now }) {
    if (!fs.existsSync(path.join(chatDir, 'index.html'))) {
        throw new Error(`${chatDir} holds no chat page (index.html missing)`);
    }
    const key = crypto.createPrivateKey(privateKeyPem);
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
        throw new Error('The signing key must be an ECDSA P-256 private key');
    }

    const files = listFiles(chatDir).map((relative) => {
        const content = fs.readFileSync(path.join(chatDir, relative));
        return { path: relative, sha256: crypto.createHash('sha256').update(content).digest('hex'), size: content.length };
    });
    const version = crypto.createHash('sha256')
        .update(files.map(file => `${file.path}\0${file.sha256}`).join('\n'))
        .digest('hex')
        .slice(0, 12);

    fs.mkdirSync(outDir, { recursive: true });
    // Only the current version stays next to the manifest
    for (const entry of fs.readdirSync(outDir, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name !== version) fs.rmSync(path.join(outDir, entry.name), { recursive: true, force: true });
    }
    const target = path.join(outDir, version);
    fs.rmSync(target, { recursive: true, force: true });
    for (const file of files) {
        fs.mkdirSync(path.dirname(path.join(target, file.path)), { recursive: true });
        fs.copyFileSync(path.join(chatDir, file.path), path.join(target, file.path));
    }

    const manifest = { version, nativeApi, builtAt: Math.round(now()), files };
    const payload = JSON.stringify(manifest);
    // DER signature over the UTF-8 payload, the format chat-bundles.js verifies
    const signature = crypto.sign('sha256', Buffer.from(payload, 'utf8'), key).toString('base64');
    fs.writeFileSync(path.join(outDir, MANIFEST), `${JSON.stringify({ payload, signature }, null, 4)}\n`);
    return manifest;
}

function parseArgs(argv) {
    const options = { key: process.env.CHAT_BUNDLE_SIGNING_KEY_FILE || '', out: '', edition: '', skipBuild: false };
    for (let i = 0; i < argv.length; i++) {
        const [name, inline] = argv[i].split('=', 2);
        const value = () => (inline !== undefined ? inline : argv[++i]);
        if (name === '--key') options.key = value();
        else if (name === '--out') options.out = value();
        else if (name === '--edition') options.edition = value();
        else if (name === '--skip-build') options.skipBuild = true;
        else throw new Error(`Unknown option ${argv[i]}`);
    }
    if (!options.key || !options.out) throw new Error('Usage: chat-bundle.mjs --key <private.pem> --out <folder> [--edition <folder>] [--skip-build]');
    return options;
}

function main() {
    const options = parseArgs(process.argv.slice(2));
    if (!options.skipBuild) {
        const args = [path.join(desktopDir, 'scripts', 'build.mjs'), 'prepare'];
        if (options.edition) args.push('--edition', path.resolve(options.edition));
        const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
        if (result.status !== 0) process.exit(result.status ?? 1);
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(desktopDir, 'package.json'), 'utf8'));
    const manifest = createChatBundle({
        chatDir: path.join(desktopDir, 'generated', 'chat'),
        outDir: path.resolve(options.out),
        privateKeyPem: fs.readFileSync(options.key, 'utf8'),
        nativeApi: Number(pkg.starchat?.nativeApi || 1),
    });
    console.log(`Chat update ${manifest.version} (${manifest.files.length} files) written to ${path.resolve(options.out)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        main();
    } catch (error) {
        console.error(error.message);
        process.exit(1);
    }
}
