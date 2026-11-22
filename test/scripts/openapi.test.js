import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderApiReference } from '../../scripts/build-docs.mjs';
import { fieldRows, renderOpenApi, tokenLabel, typeLabel } from '../../scripts/render-openapi.mjs';
import { checkOpenApi, loadSpec, resolvePointer } from '../../scripts/validate-openapi.mjs';

const FEATURES = JSON.parse(readFileSync(new URL('../../docs/discovery.schema.json', import.meta.url), 'utf8'))
    .properties.features.items.enum;

/** Smallest spec the checks accept: one tag with one operation. */
function minimalSpec() {
    return {
        openapi: '3.1.0',
        info: { title: 'Test', version: '1', description: 'Test API.' },
        security: [{ bearer: [] }],
        tags: [{ name: 'profiles', description: 'Profiles.' }],
        paths: {
            '/chat/profile': {
                get: {
                    tags: ['profiles'],
                    operationId: 'getOwnProfile',
                    summary: 'Own profile',
                    responses: {
                        200: {
                            description: 'The profile.',
                            content: {
                                'application/json': {
                                    schema: { $ref: '#/components/schemas/Profile' },
                                    example: { name: 'alice' },
                                },
                            },
                        },
                    },
                },
            },
        },
        components: {
            securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
            schemas: {
                Profile: {
                    type: 'object',
                    required: ['name'],
                    properties: { name: { type: 'string' }, status: { type: ['string', 'null'], maxLength: 128 } },
                },
            },
        },
    };
}

const markdown = (text) => text;

describe('docs/openapi.yaml', () => {
    it('is a valid spec with a tag for every discovery feature', () => {
        expect(checkOpenApi(loadSpec(), FEATURES)).toEqual([]);
    });

    it('documents every endpoint the client calls', () => {
        const paths = Object.keys(loadSpec().paths);
        for (const path of ['/login', '/chat/profile', '/friends', '/chat/media-upload', '/gifs/search', '/chat/reports',
            '/explore', '/chat-state', '/chat/always-on', '/chat/events', '/my-communities', '/chat/push-devices',
            '/chat/voice/token', '/chat/voice/filters', '/chat/voice/call-token', '/chat/voice/call-ring', '/spotify/current-track']) {
            expect(paths).toContain(path);
        }
    });
});

describe('checkOpenApi', () => {
    it('accepts the minimal spec', () => {
        expect(checkOpenApi(minimalSpec(), ['profiles'])).toEqual([]);
    });

    it('rejects a document that is no OpenAPI 3.1', () => {
        const spec = minimalSpec();
        spec.openapi = '3.0.3';
        expect(checkOpenApi(spec)).not.toEqual([]);
    });

    it('finds references that do not resolve', () => {
        const spec = minimalSpec();
        spec.paths['/chat/profile'].get.responses[200].content['application/json'].schema.$ref = '#/components/schemas/Missing';
        expect(checkOpenApi(spec)).toEqual([expect.stringContaining('#/components/schemas/Missing does not resolve')]);
    });

    it('finds examples that do not match their schema', () => {
        const spec = minimalSpec();
        spec.paths['/chat/profile'].get.responses[200].content['application/json'].example = { status: 'x' };
        expect(checkOpenApi(spec)[0]).toMatch(/GET \/chat\/profile 200 application\/json: example .*name/);
    });

    it('finds features without a tag and operations without a known tag', () => {
        const spec = minimalSpec();
        spec.paths['/chat/profile'].get.tags = ['other'];
        const errors = checkOpenApi(spec, ['profiles', 'friends']);
        expect(errors).toContain('feature friends has no tag');
        expect(errors).toContain('GET /chat/profile: needs exactly one of the tags');
        expect(errors).toContain('tag profiles has no operation');
    });

    it('finds invalid schemas', () => {
        const spec = minimalSpec();
        spec.components.schemas.Profile.required = 'name';
        expect(checkOpenApi(spec)[0]).toMatch(/invalid schema/);
    });

    it('resolves escaped pointers', () => {
        expect(resolvePointer({ paths: { '/a/b': 1 } }, '#/paths/~1a~1b')).toBe(1);
        expect(resolvePointer({}, 'other.yaml#/x')).toBeUndefined();
    });
});

describe('renderOpenApi', () => {
    it('describes types in words', () => {
        const spec = minimalSpec();
        expect(typeLabel(spec, { type: ['string', 'null'] })).toBe('string or <code>null</code>');
        expect(typeLabel(spec, { type: 'array', items: { type: 'string', format: 'date-time' } })).toBe('array of ISO 8601 date');
        expect(typeLabel(spec, { type: 'object', additionalProperties: { type: 'integer' } })).toBe('map of integer');
        expect(typeLabel(spec, { type: 'string', enum: ['a', 'b'] })).toBe('<code>a</code>, <code>b</code>');
        expect(typeLabel(spec, { oneOf: [{ type: 'null' }, { $ref: '#/components/schemas/Profile' }] })).toBe('<code>null</code> or object');
    });

    it('lists nested fields with dotted names and spells out a schema once', () => {
        const spec = minimalSpec();
        const schema = {
            type: 'object',
            required: ['mine'],
            properties: {
                mine: { type: 'array', items: { $ref: '#/components/schemas/Profile' } },
                theirs: { type: 'array', items: { $ref: '#/components/schemas/Profile' } },
            },
        };
        expect(fieldRows(spec, schema, markdown)).toEqual([
            { name: 'mine', type: 'array of object', required: true, description: '' },
            { name: 'mine[].name', type: 'string', required: true, description: '' },
            { name: 'mine[].status', type: 'string or <code>null</code>', required: false, description: 'Max. 128 characters.' },
            { name: 'theirs', type: 'array of object', required: false, description: 'Fields as in <code>mine[]</code>.' },
        ]);
    });

    it('says whether an endpoint needs a token', () => {
        const spec = minimalSpec();
        expect(tokenLabel(spec, {})).toBe('Needs a token.');
        expect(tokenLabel(spec, { security: [] })).toBe('No token.');
        expect(tokenLabel(spec, { security: [{ bearer: [] }, {}] })).toBe('Token optional, sent if there is one.');
    });

    it('renders one section per tag with its endpoints', () => {
        const { title, html } = renderOpenApi(minimalSpec(), markdown);
        expect(title).toBe('API reference');
        expect(html).toContain('<h2 id="profiles"><code>profiles</code></h2>');
        expect(html).toContain('<h3 id="getOwnProfile"><span class="badge text-bg-secondary me-2">GET</span><code>chat/profile</code></h3>');
        expect(html).toContain('<td><code>name</code></td><td>string</td><td>yes</td>');
        expect(html).toContain('&quot;name&quot;: &quot;alice&quot;');
    });

    it('renders the real spec with links to the other pages', () => {
        const { html } = renderApiReference(readFileSync(new URL('../../docs/openapi.yaml', import.meta.url), 'utf8'));
        expect(html).toContain('href="discovery.html"');
        expect(html).toContain('<h2 id="chatstate"><code>chatState</code></h2>');
    });
});
