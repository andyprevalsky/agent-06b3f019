import {
  BASE_URL,
  apiKeyHeaders,
  request,
  assertStatus,
  assert,
  createAnonymousSession,
  createTestAgent,
  deleteTestAgent,
  test,
  prisma,
  randomUUID,
} from './agents-blackbox-harness';

test('GET /:id/explore-tool-evidence keeps late research sections and source URL', async () => {
  const session = await createAnonymousSession('explore-evidence-sections');
  const agentId = await createTestAgent(session.user.id, 'Explore evidence sections');
  const taskId = randomUUID();
  const url = 'https://bungalow.com/articles/best-neighborhoods-in-denver-co';
  const result = [
    'Title: The 11 Best Neighborhoods to Live in Denver',
    '',
    `The article compares amenities. ${'Background details. '.repeat(40)}`,
    '',
    `- Urban/nightlife: Capitol Hill, Golden Triangle, Five Points. ${'Restaurants and arts. '.repeat(35)} Tradeoff: high rent.`,
    '',
    `- Walkable/culture: Golden Triangle and Five Points. ${'Museums and music. '.repeat(35)} Tradeoff: noise.`,
    '',
    `- Families/parks: South Park Hill and Washington Park. ${'Schools and parks. '.repeat(35)} Tradeoff: high prices.`,
    '',
    `- Value/affordable: University and Lincoln Park. ${'Lower rent. '.repeat(35)} Tradeoff: limited space.`,
    '',
    `Further notes cite ${url}`,
  ].join('\n');
  await prisma.message.create({
    data: {
      agentId,
      role: 'TOOL',
      text: `**Params Passed:**\n- **url**: ${url}\n\n**Result:**\n${result}`,
      metadata: { taskId, toolName: 'web_fetch', toolStatus: 'FINISHED', toolCallId: randomUUID() },
    },
  });
  const recovered = await request(
    `${BASE_URL}/api/agents/${agentId}/explore-tool-evidence?taskId=${taskId}`,
    { headers: apiKeyHeaders(session.user.id) }
  );
  assertStatus(recovered.status, 200, recovered.data);
  const excerpt = (recovered.data as { results: string[] }).results[0];
  assert(excerpt.length <= 1212, 'recovery item must keep its existing bound');
  for (const fact of [url, 'Capitol Hill', 'South Park Hill', 'Washington Park', 'University']) {
    assert(excerpt.includes(fact), `recovered evidence lost ${fact}`);
  }
  await deleteTestAgent(agentId);
});
