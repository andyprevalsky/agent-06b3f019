#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import {
  ResponseSchemaSchema,
  createAgentSchema,
  updateAgentSchema,
} from '../../domains/agents/types';

const schema = {
  fields: [
    {
      name: 'groups',
      type: 'list[object]',
      required: true,
      minItems: 1,
      properties: [
        {
          name: 'member',
          type: 'object',
          required: true,
          properties: [
            { name: 'name', type: 'str', minLength: 1, nullable: false },
            { name: 'document', type: 'file_pointer', required: false },
          ],
        },
      ],
    },
  ],
};

assert.deepEqual(ResponseSchemaSchema.parse(schema), schema);
assert.deepEqual(
  createAgentSchema.parse({ goal: 'Read directory', response_schema: schema }).response_schema,
  schema
);
assert.deepEqual(updateAgentSchema.parse({ response_schema: schema }).response_schema, schema);
for (const mutation of ['empty', 'bounds', 'unknownType'] as const) {
  const invalid = structuredClone(schema);
  if (mutation === 'empty') invalid.fields[0].properties[0].properties = [];
  if (mutation === 'bounds') invalid.fields[0].properties[0].properties[0].minLength = -1;
  if (mutation === 'unknownType') invalid.fields[0].properties[0].properties[0].type = 'invented';
  assert.equal(ResponseSchemaSchema.safeParse(invalid).success, false, mutation);
}
assert.deepEqual(ResponseSchemaSchema.parse({ fields: [] }), { fields: [] });
assert.deepEqual(
  ResponseSchemaSchema.parse({ fields: [{ name: 'note', type: 'str', required: false }] }),
  { fields: [{ name: 'note', type: 'str', required: false }] }
);
