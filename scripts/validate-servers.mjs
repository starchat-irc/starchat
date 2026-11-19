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
    if (server.discovery) {
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

if (errors.length > 0) {
    console.error(errors.join('\n'));
    process.exit(1);
}

console.log(`servers.json ok (${list.servers.length} servers)`);
