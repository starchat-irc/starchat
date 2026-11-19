/**
 * Demo page of getstarchat.net. ST-City is preselected and guests land in #starchat.
 * ?server=<domain> connects to another server of the public list instead.
 */
import 'bootstrap/dist/css/bootstrap.min.css';
import 'bootstrap-icons/font/bootstrap-icons.min.css';
import './theme.css';
import { mountChat } from '../src/index.js';

const DEMO_SERVER = 'st-city.net';
const DEMO_CHANNEL = '#starchat';

const params = new URLSearchParams(window.location.search);
const server = params.get('server') || DEMO_SERVER;
const isDemoServer = server === DEMO_SERVER;

if (!isDemoServer) {
    document.getElementById('demo-server').textContent = server;
    // Privacy and imprint links name ST-City: only shown for the ST-City demo
    document.getElementById('demo-privacy').hidden = true;
    document.getElementById('demo-imprint').hidden = true;
}

mountChat('#chat', {
    primaryServer: server,
    serverList: 'default',
    defaultChannel: isDemoServer ? DEMO_CHANNEL : '',
    ctcpVersion: 'StarChat (demo) https://getstarchat.net',
}).catch((error) => {
    const message = document.createElement('div');
    message.className = 'demo-error';
    message.textContent = `The chat could not be started: ${error.message}`;
    document.getElementById('chat').replaceChildren(message);
});
