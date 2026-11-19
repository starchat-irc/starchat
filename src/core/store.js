/**
 * State container used by the managers. The UI passes an adapter for its reactive
 * store (see alpineStore), tests and headless use take a plain one.
 *
 * @typedef {Object} StateStore
 * @property {() => Object} get
 * @property {(value: Object) => void} set
 */

/**
 * @param {Object} [initial]
 * @return {StateStore}
 */
export function createPlainStore(initial = {}) {
    let state = initial;
    return {
        get: () => state,
        set: (value) => { state = value; },
    };
}

/**
 * Adapter for an Alpine.js store. Alpine is passed in so the core does not depend on it.
 *
 * @param {{ store: Function }} Alpine
 * @param {string} name
 * @return {StateStore}
 */
export function alpineStore(Alpine, name) {
    return {
        get: () => Alpine.store(name),
        set: (value) => Alpine.store(name, value),
    };
}
