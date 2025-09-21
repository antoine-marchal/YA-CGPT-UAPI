const registry = {};

/**
 * Register a function/tool by name
 * @param {string} name
 * @param {Function} fn
 */
export function registerFunction(name, fn) {
  registry[name] = fn;
}

/**
 * Execute a registered function
 * @param {string} name
 * @param {any} args
 * @returns {Promise<any>}
 */
export async function executeFunction(name, args) {
  const fn = registry[name];
  if (!fn) {
    throw new Error(`Function not registered: ${name}`);
  }
  return await fn(args);
}

/**
 * List registered functions
 */
export function listFunctions() {
  return Object.keys(registry);
}