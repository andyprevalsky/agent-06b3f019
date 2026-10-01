#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import {
  RESPONSE_SCHEMA_JSON_SCHEMA,
  ResponseSchemaSchema,
} from '../../providers/setResponseSchema';

const parsed = ResponseSchemaSchema.parse({
  reasoning: 'Return the inventory and optional count.',
  fields: [
    {
      name: 'inventory',
      type: 'list[object]',
      properties: [{ name: 'address', type: 'str' }],
    },
    { name: 'count', type: 'int', required: false },
  ],
});

assert.equal(parsed.fields[0].required, true);
assert.equal(parsed.fields[0].properties?.[0].required, true);
assert.equal(parsed.fields[1].required, false);
assert.deepEqual(RESPONSE_SCHEMA_JSON_SCHEMA.properties.fields.items.required, [
  'name',
  'type',
  'properties',
  'constraints',
  'required',
]);
assert.deepEqual(
  RESPONSE_SCHEMA_JSON_SCHEMA.properties.fields.items.properties.properties.items.required,
  ['name', 'type', 'constraints', 'required']
);
