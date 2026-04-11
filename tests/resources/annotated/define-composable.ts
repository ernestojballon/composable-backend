import { defineComposable } from '../../../src/models/composable';

const handler = async () => ({ ok: true });
const inputSchema = {
  parse(value: unknown) {
    return value;
  },
};
const outputSchema = {
  parse(value: unknown) {
    return value;
  },
};

export default defineComposable({
  process: 'v1.define.composable.ts',
  handler,
  inputSchema,
  outputSchema,
  instances: 3,
  visibility: 'public',
  interceptor: true,
});
