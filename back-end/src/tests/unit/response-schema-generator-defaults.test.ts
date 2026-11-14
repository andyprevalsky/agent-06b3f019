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
const nullMetadata = ResponseSchemaSchema.parse({
  reasoning: 'A count and a list.',
  fields: [
    { name: 'count', type: 'int', required: null, constraints: null, properties: null },
    {
      name: 'items',
      type: 'list[object]',
      required: null,
      constraints: null,
      properties: [{ name: 'label', type: 'str', required: null, constraints: null }],
    },
  ],
});
assert.equal(nullMetadata.fields[0].required, true);
assert.equal(nullMetadata.fields[0].constraints, undefined);
assert.equal(nullMetadata.fields[0].properties, undefined);
assert.equal(nullMetadata.fields[1].required, true);
assert.equal(nullMetadata.fields[1].properties?.[0].required, true);
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
assert.deepEqual(RESPONSE_SCHEMA_JSON_SCHEMA.required, ['reasoning', 'fields', 'presentation']);
const valuePresentation = RESPONSE_SCHEMA_JSON_SCHEMA.properties.presentation.anyOf[2];
assert.equal(valuePresentation.properties?.field.minLength, 1);
