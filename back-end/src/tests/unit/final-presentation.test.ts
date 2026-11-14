import assert from 'node:assert/strict';
import {
  ResponseSchemaSchema,
  createAgentSchema,
  updateAgentSchema,
} from '../../domains/agents/types';
const fields = [{ name: 'day', type: 'int', required: true }];
const presentation = { version: 1, mode: 'value', field: 'day', encoding: 'text' };
const schema = { fields, presentation };
assert.deepEqual(ResponseSchemaSchema.parse(schema), schema);
assert.deepEqual(
  createAgentSchema.parse({ goal: 'Only the day', response_schema: schema }).response_schema,
  schema
);
assert.deepEqual(updateAgentSchema.parse({ response_schema: schema }).response_schema, schema);
assert.deepEqual(ResponseSchemaSchema.parse({ fields }), { fields });
for (const invalid of [
  { ...schema, presentation: { ...presentation, field: 'missing' } },
  { ...schema, fields: [{ ...fields[0], nullable: true }] },
  { ...schema, fields: [...fields, { name: 'notice', type: 'str', required: true }] },
  { ...schema, fields: [{ ...fields[0], type: 'file_pointer' }] },
  { ...schema, presentation: { ...presentation, version: 2 } },
  { ...schema, presentation: { ...presentation, secret: 'hidden' } },
])
  assert.equal(ResponseSchemaSchema.safeParse(invalid).success, false);
process.stdout.write('final presentation API contracts PASS\n');
