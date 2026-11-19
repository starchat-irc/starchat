/**
 * Demo page of getstarchat.net. ST-City is preselected with #starchat as start channel,
 * the login dialog offers the other servers of the public list.
 * ?server=<domain> preselects another server, ?lang=de|en and ?theme=dark|light|auto
 * override the browser settings.
 */
import 'bootstrap/dist/css/bootstrap.min.css';
import 'bootstrap-icons/font/bootstrap-icons.min.css';
import '../src/ui/theme.css';
import { mountChat } from '../src/index.js';

const params = new URLSearchParams(window.location.search);

mountChat('#chat', {
    primaryServer: params.get('server') || 'st-city.net',
    serverList: 'default',
    defaultChannel: '#starchat',
    locale: params.get('lang') || undefined,
    theme: params.get('theme') || 'auto',
    ctcpVersion: 'StarChat (demo) https://getstarchat.net',
}).catch((error) => {
    const message = document.createElement('div');
    message.className = 'demo-error';
    message.textContent = `The chat could not be started: ${error.message}`;
    document.getElementById('chat').replaceChildren(message);
});
