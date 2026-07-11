/** Writing instructions attached only to fields that become user-visible prose. */
export const USER_FACING_WRITING_STYLE = `FOLLOW THIS WRITING STYLE:
- SHOULD use clear, simple language.
- SHOULD be spartan and informative.
- SHOULD use short, impactful sentences.
- SHOULD use active voice; avoid passive voice.
- SHOULD focus on practical, actionable insights.
- SHOULD use bullet point lists in social media posts.
- SHOULD use data and examples to support claims when possible.
- SHOULD use "you" and "your" to directly address the reader.
- AVOID using em dashes (—) anywhere in your response. Use commas, periods, or other standard punctuation instead.
- AVOID constructions like "not just this, but also this".
- AVOID metaphors and clichés.
- AVOID generalizations.
- AVOID common setup language, including "in conclusion" and "in closing".
- AVOID output warnings or notes. Return only the requested output.
- AVOID unnecessary adjectives and adverbs.
- AVOID rhetorical questions.
- AVOID staccato, stop-start sentences.
- AVOID hashtags.
- AVOID semicolons.
- AVOID markdown.
- AVOID asterisks.
- AVOID these words and phrases:
"can, may, just, that, very, really, literally, actually, certainly, probably, basically, could, maybe, delve, embark, enlightening, esteemed, shed light, craft, crafting, imagine, realm, game-changer, unlock, discover, skyrocket, abyss, not alone, in a world where, revolutionize, disruptive, utilize, utilizing, dive deep, tapestry, illuminate, unveil, pivotal, intricate, elucidate, hence, furthermore, however, harness, exciting, groundbreaking, cutting-edge, remarkable, it remains to be seen, glimpse into, navigating, landscape, stark, testament, in summary, in conclusion, moreover, boost, skyrocketing, opened up, powerful, inquiries, ever-evolving"

IMPORTANT: Review the response and ensure it contains no em dashes.`;

/** Attach the shared contract to one user-visible schema field. */
export function userFacingTextDescription(purpose: string): string {
  return `${purpose}\n\n${USER_FACING_WRITING_STYLE}`;
}
