/**
 * Checks docs/openapi.yaml against the OpenAPI 3.1 schema plus the rules a schema cannot
 * express: every $ref resolves, every operation belongs to a known tag, every discovery
 * feature has a tag, and every example matches its schema.
 *
 * scripts/schemas/openapi-3.1.json is the official schema from
 * https://spec.openapis.org/oas/3.1/schema/2022-10-07 (Apache-2.0).
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { parse } from 'yaml';

const METHODS = ['get', 'put', 'post', 'delete', 'patch'];
const SPEC_ID = 'https://getstarchat.net/docs/openapi.yaml';

const readJson = (relative) => JSON.parse(readFileSync(new URL(relative, import.meta.url), 'utf8').replace(/^﻿/, ''));

/** @return {Object} The parsed spec. */
export function loadSpec(file = new URL('../docs/openapi.yaml', import.meta.url)) {
    return parse(readFileSync(file, 'utf8'));
}

/** Looks up a local reference like `#/components/schemas/Profile`. */
export function resolvePointer(spec, ref) {
    if (!ref.startsWith('#/')) {
        return undefined;
    }
    return ref.slice(2).split('/').reduce(
        (node, key) => node?.[key.replaceAll('~1', '/').replaceAll('~0', '~')],
        spec,
    );
}

function* walk(node, where) {
    if (node && typeof node === 'object') {
        yield [node, where];
        for (const [key, value] of Object.entries(node)) {
            yield* walk(value, `${where}/${key}`);
        }
    }
}

/** Local `#/…` references point into the spec, which ajv knows under SPEC_ID. */
function absoluteRefs(schema) {
    return JSON.parse(JSON.stringify(schema), (key, value) => (
        key === '$ref' && typeof value === 'string' && value.startsWith('#/') ? SPEC_ID + value : value
    ));
}

/**
 * @param {Object} spec Parsed OpenAPI document.
 * @param {string[]} features Values of `features` in the discovery schema.
 * @return {string[]} Problems, empty if the spec is fine.
 */
export function checkOpenApi(spec, features = []) {
    const errors = [];
    const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });

    // ajv mishandles $dynamicRef next to unevaluatedProperties. The schemas inside the
    // spec are compiled one by one below instead, which checks them as JSON Schema.
    const metaSchema = JSON.parse(
        JSON.stringify(readJson('./schemas/openapi-3.1.json')).replaceAll('"$dynamicRef":"#meta"', '"$ref":"#/$defs/schema"'),
    );
    const validateSpec = ajv.compile(metaSchema);
    if (!validateSpec(spec)) {
        for (const error of validateSpec.errors) {
            errors.push(`${error.instancePath || '/'} ${error.message}`);
        }
        return errors;
    }

    for (const [node, where] of walk(spec, '')) {
        if (typeof node.$ref === 'string' && resolvePointer(spec, node.$ref) === undefined) {
            errors.push(`${where}: $ref ${node.$ref} does not resolve`);
        }
    }
    if (errors.length) {
        return errors;
    }

    const tags = new Set((spec.tags ?? []).map((tag) => tag.name));
    for (const feature of features) {
        if (!tags.has(feature)) {
            errors.push(`feature ${feature} has no tag`);
        }
    }

    const operationIds = new Set();
    const usedTags = new Set();
    ajv.addSchema({ ...absoluteRefs(spec), $id: SPEC_ID });

    const compile = (schema, where) => {
        try {
            return ajv.compile(absoluteRefs(schema));
        } catch (error) {
            errors.push(`${where}: invalid schema, ${error.message}`);
            return null;
        }
    };
    const checkExample = (content, where) => {
        if (!content?.schema) {
            return;
        }
        const validate = compile(content.schema, where);
        if (validate && content.example !== undefined && !validate(content.example)) {
            errors.push(`${where}: example ${validate.errors[0].instancePath || '/'} ${validate.errors[0].message}`);
        }
    };

    for (const [path, item] of Object.entries(spec.paths ?? {})) {
        for (const method of METHODS.filter((name) => item[name])) {
            const operation = item[method];
            const where = `${method.toUpperCase()} ${path}`;
            if (operation.tags?.length !== 1 || !tags.has(operation.tags[0])) {
                errors.push(`${where}: needs exactly one of the tags`);
            }
            operation.tags?.forEach((tag) => usedTags.add(tag));
            if (operationIds.has(operation.operationId)) {
                errors.push(`${where}: operationId ${operation.operationId} is used twice`);
            }
            operationIds.add(operation.operationId);

            for (const entry of operation.parameters ?? []) {
                const parameter = entry.$ref ? resolvePointer(spec, entry.$ref) : entry;
                checkExample({ schema: parameter.schema }, `${where} parameter ${parameter.name}`);
            }
            for (const [type, content] of Object.entries(operation.requestBody?.content ?? {})) {
                checkExample(content, `${where} request ${type}`);
            }
            for (const [status, response] of Object.entries(operation.responses ?? {})) {
                for (const [type, content] of Object.entries(response.content ?? {})) {
                    checkExample(content, `${where} ${status} ${type}`);
                }
            }
        }
    }
    for (const [name, schema] of Object.entries(spec.components?.schemas ?? {})) {
        checkExample({ schema: { $ref: `#/components/schemas/${name}` }, example: schema.example }, `schema ${name}`);
    }
    for (const tag of tags) {
        if (!usedTags.has(tag)) {
            errors.push(`tag ${tag} has no operation`);
        }
    }
    return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const features = readJson('../docs/discovery.schema.json').properties.features.items.enum;
    const errors = checkOpenApi(loadSpec(), features);
    if (errors.length) {
        console.error(errors.join('\n'));
        process.exit(1);
    }
    console.log('docs/openapi.yaml is valid');
}
