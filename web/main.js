/**
 * Hostable web page: reads config.json from its own folder and starts the chat.
 * Built with `npm run build:web`, released as starchat-web-*.zip. See docs/hosting.md.
 */
import 'bootstrap/dist/css/bootstrap.min.css';
import 'bootstrap-icons/font/bootstrap-icons.min.css';
import '../src/ui/theme.css';
import { defaultModules, mountChat } from '../src/index.js';
import { pushWorkerUrl, readWebConfig } from './config.js';

function showError(message) {
    const box = document.createElement('div');
    box.className = 'page-error';
    box.textContent = message;
    document.getElementById('chat').replaceChildren(box);
}

function showNotice({ notice, links }) {
    if (!notice && !links.length) return;
    const bar = document.getElementById('notice');
    const textElement = document.createElement('span');
    textElement.textContent = notice;
    const linkList = document.createElement('span');
    linkList.className = 'page-notice-links';
    links.forEach(({ label, url }) => {
        const link = document.createElement('a');
        link.href = url;
        link.textContent = label;
        link.target = '_blank';
        link.rel = 'noopener';
        linkList.append(link);
    });
    bar.replaceChildren(textElement, linkList);
    bar.hidden = false;
}

async function loadConfig() {
    const response = await fetch('./config.json', { cache: 'no-cache' });
    if (!response.ok) throw new Error(`config.json: HTTP ${response.status}`);
    return response.json();
}

try {
    const config = readWebConfig(await loadConfig(), window.location.search);
    if (!config.options.primaryServer) {
        throw new Error('set "primaryServer" in config.json to the domain of your IRC network.');
    }
    document.title = config.title;
    showNotice(config);

    const modules = config.modules ? defaultModules.filter(module => config.modules.includes(module.name)) : defaultModules;
    const pushWorker = config.push && 'serviceWorker' in navigator
        ? pushWorkerUrl(config.options, window.location.pathname)
        : undefined;

    await mountChat('#chat', { ...config.options, modules, pushWorker });
} catch (error) {
    console.error(error);
    showError(`The chat could not be started: ${error.message}`);
}
