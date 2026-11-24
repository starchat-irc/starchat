// Checks servers/servers.json against the schema plus the rules a schema cannot express.
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';

// Windows editors like to save with a BOM, which JSON.parse rejects.
const read = (path) => JSON.parse(
    readFileSync(new URL(`../servers/${path}`, import.meta.url), 'utf8').replace(/^﻿/, ''),
);

const schema = read('servers.schema.json');
const list = read('servers.json');
const errors = [];

const validate = new Ajv2020({ allErrors: true }).compile(schema);
if (!validate(list)) {
    for (const error of validate.errors) {
        errors.push(`${error.instancePath || '/'} ${error.message}`);
    }
}

const isSameSite = (host, domain) => host === domain || host.endsWith(`.${domain}`);
const seenIds = new Set();
const seenDomains = new Set();

for (const server of list.servers ?? []) {
    if (seenIds.has(server.id)) {
        errors.push(`${server.id}: id is used twice`);
    }
    if (seenDomains.has(server.domain)) {
        errors.push(`${server.id}: domain ${server.domain} is used twice`);
    }
    seenIds.add(server.id);
    seenDomains.add(server.domain);

    // A list entry must not point the client to an API on a foreign host, otherwise
    // logins for that network could end up somewhere else.
    if (typeof server.discovery === 'string') {
        let host;
        try {
            host = new URL(server.discovery).hostname;
        } catch {
            errors.push(`${server.id}: discovery is not a valid URL`);
            continue;
        }
        if (!isSameSite(host, server.domain)) {
            errors.push(`${server.id}: discovery host ${host} is not on ${server.domain}`);
        }
    }
}

// Order shown to users: networks with a discovery file first, then by name.
const sortKey = (server) => [server.discovery === false ? 1 : 0, server.name.toLocaleLowerCase('en')];
const servers = list.servers ?? [];
for (let i = 1; i < servers.length; i++) {
    const [groupA, nameA] = sortKey(servers[i - 1]);
    const [groupB, nameB] = sortKey(servers[i]);
    if (groupA > groupB || (groupA === groupB && nameA.localeCompare(nameB, 'en') > 0)) {
        errors.push(`${servers[i].id}: wrong place, networks with a discovery file come first, then sorted by name (put ${servers[i].name} before ${servers[i - 1].name})`);
    }
}

if (errors.length > 0) {
    console.error(errors.join('\n'));
    process.exit(1);
}

console.log(`servers.json ok (${list.servers.length} servers)`);
