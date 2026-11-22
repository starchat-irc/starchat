/**
 * Turns docs/openapi.yaml into the HTML body of the API reference on getstarchat.net/docs.
 * One section per tag (feature), one block per endpoint with its fields as tables.
 * Schemas are shown inline, named schemas are not listed separately.
 */
import { resolvePointer } from './validate-openapi.mjs';

const METHODS = ['get', 'put', 'post', 'delete', 'patch'];
const MAX_DEPTH = 4;

const escapeHtml = (text) => String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

const code = (text) => `<code>${escapeHtml(text)}</code>`;

/** Anchor of a tag section. */
export const tagAnchor = (name) => name.toLowerCase();

function deref(spec, node) {
    let current = node;
    for (let i = 0; current?.$ref && i < 10; i++) {
        current = resolvePointer(spec, current.$ref);
    }
    return current ?? {};
}

/** Properties and required fields of a schema, with `allOf` merged. */
function objectParts(spec, schema) {
    const resolved = deref(spec, schema);
    const parts = { properties: { ...resolved.properties }, required: [...(resolved.required ?? [])] };
    for (const member of resolved.allOf ?? []) {
        const inner = objectParts(spec, member);
        Object.assign(parts.properties, inner.properties);
        parts.required.push(...inner.required);
    }
    return parts;
}

/** Variants of a `oneOf`/`anyOf` without the `null` one. */
function variants(spec, schema) {
    return (schema.oneOf ?? schema.anyOf ?? []).map((member) => deref(spec, member));
}

/**
 * @return {string} Short type of a schema as HTML, for example "string or <code>null</code>".
 */
export function typeLabel(spec, node) {
    const schema = deref(spec, node);
    if (schema.oneOf || schema.anyOf) {
        return variants(spec, schema).map((member) => typeLabel(spec, member)).join(' or ');
    }
    if (schema.enum) {
        return schema.enum.map((value) => code(value)).join(', ');
    }
    const types = [].concat(schema.type ?? (schema.properties || schema.allOf ? 'object' : []));
    const labels = types.map((type) => {
        if (type === 'null') {
            return code('null');
        }
        if (type === 'array') {
            return schema.items ? `array of ${typeLabel(spec, schema.items)}` : 'array';
        }
        if (type === 'object' && schema.additionalProperties && typeof schema.additionalProperties === 'object' && !schema.properties) {
            return `map of ${typeLabel(spec, schema.additionalProperties)}`;
        }
        if (type === 'string' && schema.format === 'date-time') {
            return 'ISO 8601 date';
        }
        if (type === 'string' && schema.format === 'uri') {
            return 'URL';
        }
        if (type === 'string' && schema.contentMediaType) {
            return 'file';
        }
        return type;
    });
    return labels.join(' or ') || 'any';
}

function limits(schema) {
    const notes = [];
    if (schema.maxLength !== undefined) notes.push(`Max. ${schema.maxLength} characters.`);
    if (schema.maxItems !== undefined) notes.push(`Max. ${schema.maxItems} entries.`);
    if (schema.minimum !== undefined && schema.maximum !== undefined) notes.push(`${schema.minimum} to ${schema.maximum}.`);
    if (schema.pattern) notes.push(`Pattern ${code(schema.pattern)}.`);
    return notes.join(' ');
}

/**
 * Rows of the field table: one per property, nested objects and objects in arrays with
 * dotted names (`user.display`, `results[].id`). A named schema used twice in one table
 * is spelled out the first time only.
 *
 * @return {{ name: string, type: string, required: boolean, description: string }[]}
 */
export function fieldRows(spec, node, markdown, prefix = '', depth = 0, seen = new Map()) {
    const schema = deref(spec, node);
    if (depth > MAX_DEPTH) {
        return [];
    }
    const types = [].concat(schema.type ?? []);
    if (types.includes('array') && schema.items) {
        return fieldRows(spec, schema.items, markdown, `${prefix}[]`, depth + 1, seen);
    }
    const objectVariant = variants(spec, schema).find((member) => member.properties || member.allOf);
    if (objectVariant) {
        return fieldRows(spec, objectVariant, markdown, prefix, depth + 1, seen);
    }

    const { properties, required } = objectParts(spec, schema);
    const rows = [];
    for (const [name, property] of Object.entries(properties)) {
        const resolved = deref(spec, property);
        const fullName = prefix ? `${prefix}.${name}` : name;
        const isArray = [].concat(resolved.type ?? []).includes('array');
        const nested = isArray ? deref(spec, resolved.items) : resolved;
        const nestedPrefix = isArray ? `${fullName}[]` : fullName;
        const ref = property.$ref ?? resolved.items?.$ref;
        const earlier = ref && seen.get(ref);
        const description = [
            resolved.description ? markdown(resolved.description.trim()) : '',
            limits(resolved),
            earlier ? `Fields as in ${code(earlier)}.` : '',
        ].filter(Boolean).join(' ');
        rows.push({ name: fullName, type: typeLabel(spec, resolved), required: required.includes(name), description });

        const objectLike = nested.properties || nested.allOf || variants(spec, nested).some((member) => member.properties || member.allOf);
        if (objectLike && !earlier) {
            if (ref) {
                seen.set(ref, nestedPrefix);
            }
            rows.push(...fieldRows(spec, nested, markdown, nestedPrefix, depth + 1, seen));
        }
    }
    return rows;
}

function fieldTable(rows) {
    const body = rows.map((row) => `<tr><td>${code(row.name)}</td><td>${row.type}</td><td>${row.required ? 'yes' : ''}</td><td>${row.description}</td></tr>`).join('\n');
    return `<div class="table-responsive"><table class="table">
<thead><tr><th>Field</th><th>Type</th><th>Required</th><th>Meaning</th></tr></thead>
<tbody>
${body}
</tbody></table></div>\n`;
}

/** Body or answer: field table (if the schema has fields), else the type, plus the example. */
function contentBlock(spec, content, markdown) {
    let html = '';
    for (const [type, media] of Object.entries(content ?? {})) {
        const rows = media.schema ? fieldRows(spec, media.schema, markdown) : [];
        const typeNote = type === 'application/json' ? '' : ` (${code(type)})`;
        if (rows.length) {
            html += typeNote ? `<p>Sent as${typeNote}.</p>\n` : '';
            html += fieldTable(rows);
        } else if (media.schema) {
            html += `<p>${typeLabel(spec, media.schema)}${typeNote}</p>\n`;
        }
        const example = media.example ?? deref(spec, media.schema).example;
        if (example !== undefined) {
            html += `<pre><code class="language-json">${escapeHtml(JSON.stringify(example, null, 2))}</code></pre>\n`;
        }
    }
    return html;
}

export function tokenLabel(spec, operation) {
    const security = operation.security ?? spec.security ?? [];
    if (!security.length) {
        return 'No token.';
    }
    return security.some((entry) => !Object.keys(entry).length) ? 'Token optional, sent if there is one.' : 'Needs a token.';
}

function renderOperation(spec, path, method, operation, markdown) {
    const id = operation.operationId;
    let html = `<h3 id="${escapeHtml(id)}"><span class="badge text-bg-secondary me-2">${method.toUpperCase()}</span><code>${escapeHtml(path.slice(1))}</code></h3>\n`;
    html += `<p><strong>${escapeHtml(operation.summary ?? '')}.</strong> ${tokenLabel(spec, operation)}</p>\n`;
    if (operation.description) {
        html += markdown(operation.description, true);
    }

    const parameters = (operation.parameters ?? []).map((entry) => deref(spec, entry));
    if (parameters.length) {
        const rows = parameters.map((parameter) => ({
            name: parameter.in === 'query' ? `?${parameter.name}` : `{${parameter.name}}`,
            type: typeLabel(spec, parameter.schema),
            required: Boolean(parameter.required),
            description: parameter.description ? markdown(parameter.description.trim()) : '',
        }));
        html += '<p>Parameters:</p>\n' + fieldTable(rows);
    }
    if (operation.requestBody) {
        html += '<p>Body:</p>\n' + contentBlock(spec, deref(spec, operation.requestBody).content, markdown);
    }

    const responses = Object.entries(operation.responses ?? {}).map(([status, entry]) => [status, deref(spec, entry)]);
    html += `<div class="table-responsive"><table class="table">
<thead><tr><th>Status</th><th>Meaning</th></tr></thead>
<tbody>
${responses.map(([status, response]) => `<tr><td>${code(status)}</td><td>${markdown(response.description.trim())}</td></tr>`).join('\n')}
</tbody></table></div>\n`;
    for (const [status, response] of responses) {
        if (response.content && status.startsWith('2')) {
            html += `<p>Answer ${code(status)}:</p>\n${contentBlock(spec, response.content, markdown)}`;
        }
    }
    return html;
}

/**
 * @param {Object} spec Parsed OpenAPI document.
 * @param {(text: string, block?: boolean) => string} markdown Renders Markdown, inline unless `block`.
 * @return {{ title: string, html: string }}
 */
export function renderOpenApi(spec, markdown) {
    const title = 'API reference';
    const operations = [];
    for (const [path, item] of Object.entries(spec.paths ?? {})) {
        for (const method of METHODS.filter((name) => item[name])) {
            operations.push({ path, method, operation: item[method] });
        }
    }

    let html = `<h1 id="api-reference">${title}</h1>\n`;
    html += markdown(spec.info.description, true);
    html += `<p>The same as OpenAPI ${escapeHtml(spec.openapi)}: <a href="openapi.yaml">openapi.yaml</a>. The features and where the API address comes from are described in <a href="discovery.html">Discovery file</a>.</p>\n`;
    html += `<ul>\n${(spec.tags ?? []).map((tag) => `<li><a href="#${tagAnchor(tag.name)}">${code(tag.name)}</a></li>`).join('\n')}\n</ul>\n`;

    for (const tag of spec.tags ?? []) {
        html += `<h2 id="${tagAnchor(tag.name)}"><code>${escapeHtml(tag.name)}</code></h2>\n`;
        if (tag.description) {
            html += markdown(tag.description, true);
        }
        for (const { path, method, operation } of operations.filter((entry) => entry.operation.tags?.[0] === tag.name)) {
            html += renderOperation(spec, path, method, operation, markdown);
        }
    }
    return { title, html };
}
