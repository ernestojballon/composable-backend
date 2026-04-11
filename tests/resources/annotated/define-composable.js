import { defineComposable } from '../../../dist/models/composable.js';

const handler = async () => ({ ok: true });

export default defineComposable({
    process: 'v1.define.composable.js',
    handler,
    instances: 4,
    visibility: 'public',
    interceptor: true,
});
