/**
 * Demo page of getstarchat.net. ST-City is preselected with #starchat as start channel,
 * the login dialog offers the other servers of the public list.
 * ?server=<domain> preselects another server.
 */
import 'bootstrap/dist/css/bootstrap.min.css';
import 'bootstrap-icons/font/bootstrap-icons.min.css';
import './theme.css';
import { mountChat } from '../src/index.js';

const params = new URLSearchParams(window.location.search);

mountChat('#chat', {
    primaryServer: params.get('server') || 'st-city.net',
    serverList: 'default',
    defaultChannel: '#starchat',
    ctcpVersion: 'StarChat (demo) https://getstarchat.net',
}).catch((error) => {
    const message = document.createElement('div');
    message.className = 'demo-error';
    message.textContent = `The chat could not be started: ${error.message}`;
    document.getElementById('chat').replaceChildren(message);
});
