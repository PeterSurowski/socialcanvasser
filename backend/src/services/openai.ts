import OpenAI from 'openai';

interface Comment {
  username: string;
  text: string;
  relativeTime: string;
}

interface BuyingIntentResult {
  username: string;
  hasBuyingIntent: boolean;
  customizedDM?: string;
  customizedReply?: string;
}

interface UserConfig {
  aiPrompt: string;
  exampleDM: string;
  exampleComment: string;
  openaiApiKey: string;
}

/**
 * Analyze comments for buying intent and generate customized responses
 */
export async function analyzeCommentsForBuyingIntent(
  comments: Comment[],
  videoUrl: string,
  userConfig: UserConfig
): Promise<BuyingIntentResult[]> {
  
  const openai = new OpenAI({
    apiKey: userConfig.openaiApiKey
  });

  // Build the prompt
  const systemPrompt = `You are an expert at identifying buying intent in social media comments and crafting personalized outreach messages.

Your task:
1. Identify which comments express buying intent:
   - Asking where to buy or how to get started
   - Expressing desire for the product/solution
   - Asking about pricing, availability, or details
   - Showing frustration with current situation (looking for solutions)
   - Asking "how?", "where?", "can I?", "does this work?"
   
2. For EVERY comment with buying intent, you MUST create BOTH:
   - A customized DM (warm, helpful, personal - can be longer)
   - A customized comment reply (MAX 150 characters - short and engaging)

User's Business Context:
${userConfig.aiPrompt}

The following is guidance on crafting DM messages:
${userConfig.exampleDM}

The following is guidance on crafting comment replies (this must be 150 characters or less):
${userConfig.exampleComment}

CRITICAL RULES:
- If hasBuyingIntent is true, you MUST provide BOTH customizedDM and customizedReply
- If hasBuyingIntent is false, set customizedDM and customizedReply to empty strings
- Comment replies are LIMITED to 150 characters maximum - count carefully!
- Personalize based on what the commenter actually said
- Be conversational and helpful, not pushy or salesy
- Reference something specific from their comment when possible`;

  const userPrompt = `Video URL: ${videoUrl}

Comments to analyze:
${comments.map((c, i) => `${i + 1}. @${c.username} (${c.relativeTime}): "${c.text}"`).join('\n')}

For each comment, respond in this EXACT JSON format (no other text):
{
  "results": [
    {
      "username": "username1",
      "hasBuyingIntent": true,
      "customizedDM": "Hey [name]! I saw your comment about [specific thing]. I totally get it - [relate to their situation]. [Your solution/offer]. I'm happy to share my experiences, if you're interested!",
      "customizedReply": "I can help with that! 😊 Sending you a message"
    },
    {
      "username": "username2",
      "hasBuyingIntent": false,
      "customizedDM": "",
      "customizedReply": ""
    }
  ]
}

REQUIREMENTS:
- Always return a "results" array, even for one comment
- If hasBuyingIntent is true: MUST include non-empty customizedDM and customizedReply
- If hasBuyingIntent is false: set both to empty strings ""
- customizedReply must be 150 characters or less (count carefully!)
- Make messages personal by referencing the actual comment content`;

  try {
    console.log(`[OpenAI] Sending ${comments.length} comments to OpenAI for buying intent analysis...`);
    
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini', // Cost-effective for this task
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.7,
      response_format: { type: 'json_object' }
    });

    const responseText = completion.choices[0].message.content;
    if (!responseText) {
      throw new Error('Empty response from OpenAI');
    }

    console.log(`[OpenAI] Raw response:`, responseText);

    // Parse JSON response
    let parsed;
    try {
      parsed = JSON.parse(responseText);
      
      // Handle if OpenAI wrapped it in an object with a key
      if (parsed.results) {
        parsed = parsed.results;
      } else if (parsed.comments) {
        parsed = parsed.comments;
      } else if (parsed.analysis) {
        parsed = parsed.analysis;
      }
      
      // If it's a single object (not an array), wrap it in an array
      if (!Array.isArray(parsed)) {
        console.log(`[OpenAI] Response was a single object, wrapping in array`);
        parsed = [parsed];
      }
      
      // Validate it's an array
      if (!Array.isArray(parsed)) {
        console.error('[OpenAI] Response could not be converted to array:', JSON.stringify(parsed).substring(0, 200));
        throw new Error('Response is not an array');
      }
    } catch (parseError) {
      console.error('[OpenAI] Failed to parse response:', responseText);
      throw new Error('Invalid JSON response from OpenAI');
    }

    const withIntent = parsed.filter((r: any) => r.hasBuyingIntent).length;
    console.log(`[OpenAI] ✅ Analysis complete: ${withIntent}/${parsed.length} comments have buying intent`);
    parsed.forEach((r: any) => {
      if (r.hasBuyingIntent) {
        console.log(`  - @${r.username}: Intent detected`);
        console.log(`    DM: "${r.customizedDM?.substring(0, 80)}..."`);
        console.log(`    Reply: "${r.customizedReply}"`);
      }
    });

    return parsed as BuyingIntentResult[];

  } catch (error) {
    console.error('[OpenAI] Error analyzing comments:', error);
    throw error;
  }
}

/**
 * Generate a brand-voice-aligned comment for a TikTok video based on its caption and existing comments
 */
export async function generateAffiliateComment(
  caption: string,
  comments: string[],
  brandVoice: string,
  openaiApiKey: string
): Promise<string> {
  const openai = new OpenAI({ apiKey: openaiApiKey });

  const systemPrompt = `You are an expert social media content creator. Your job is to write a TikTok comment that sounds natural and human — NOT like a sales pitch or bot.

Brand Voice / Persona:
${brandVoice}

Rules:
- The comment must be genuine, conversational, and engaging
- Max 150 characters
- Do NOT mention products, pricing, or promotions explicitly
- Reference something specific from the video caption or existing comments to seem authentic
- End with something that invites a response (question, relatable observation, etc.)
- Return ONLY the comment text — no quotes, no explanation`;

  const existingCommentsText = comments.slice(0, 10).map((c, i) => `${i + 1}. "${c}"`).join('\n');

  const userPrompt = `Video Caption: "${caption}"

Top comments on this video:
${existingCommentsText || '(no comments yet)'}

Write a single, natural comment in the brand voice described above. Return only the comment text.`;

  try {
    console.log(`[OpenAI] Generating affiliate comment...`);
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.8,
      max_tokens: 100
    });

    const text = (completion.choices[0].message.content || '').trim().replace(/^"|"$/g, '');
    console.log(`[OpenAI] ✅ Generated comment: "${text}"`);
    return text;
  } catch (error) {
    console.error('[OpenAI] Error generating affiliate comment:', error);
    throw error;
  }
}

/**
 * Generate a customized affiliate DM using prospect context and prior scraped content.
 */
export async function generateAffiliateProspectDM(
  tiktokUsername: string,
  userTitle: string,
  bioText: string,
  recentCaptions: string[],
  recentComments: string[],
  dmPrompt: string,
  brandVoice: string,
  openaiApiKey: string
): Promise<string> {
  const openai = new OpenAI({ apiKey: openaiApiKey });

  const systemPrompt = `You write warm, human TikTok DMs that feel personal and natural.

Brand Voice:
${brandVoice}

Rules:
- Max 280 characters
- Sound conversational and friendly, never salesy
- Personalize based on the user's bio/title and recent content themes
- Include one light question to invite a reply
- No links, no pricing, no pressure
- Return ONLY the DM text`;

  const userPrompt = `Prospect username: @${tiktokUsername}
Prospect title: ${userTitle || '(unknown)'}
Prospect bio: ${bioText || '(none)'}

Recently scraped video captions (up to 5):
${recentCaptions.length ? recentCaptions.map((c, i) => `${i + 1}. ${c}`).join('\n') : '(none)'}

Recently scraped video comments (up to 5):
${recentComments.length ? recentComments.map((c, i) => `${i + 1}. ${c}`).join('\n') : '(none)'}

DM prompt from onboarding:
${dmPrompt}

Write one personalized DM now.`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.8,
      max_tokens: 140
    });

    return (completion.choices[0].message.content || '').trim().replace(/^"|"$/g, '');
  } catch (error) {
    console.error('[OpenAI] Error generating affiliate prospect DM:', error);
    throw error;
  }
}

interface StatusUnknownClassificationInput {
  username: string;
  userTitle: string;
  bioText: string;
  firstVideoCaption: string;
  firstVideoComments: string[];
  externalHtml: string;
  openaiApiKey: string;
}

interface StatusUnknownClassificationResult {
  qualifiesAsAffiliate: boolean;
  reasoning: string;
}

export async function classifyStatusUnknownProspect(
  input: StatusUnknownClassificationInput
): Promise<StatusUnknownClassificationResult> {
  const openai = new OpenAI({ apiKey: input.openaiApiKey });

  const systemPrompt = `You classify TikTok users for an affiliate outreach system.

Classify as qualifiesAsAffiliate=true when ANY are true:
- They sell peptides directly
- They sell products peptides complement (beauty, health, fitness)
- They create beauty, health, or fitness content consistently

If none apply, qualifiesAsAffiliate=false.

Return strict JSON only with keys:
- qualifiesAsAffiliate (boolean)
- reasoning (short string)`;

  const userPrompt = `Username: @${input.username}
User title: ${input.userTitle || '(none)'}
Bio text: ${input.bioText || '(none)'}

First video caption:
${input.firstVideoCaption || '(none)'}

First video comments:
${(input.firstVideoComments || []).slice(0, 10).map((c, i) => `${i + 1}. ${c}`).join('\n') || '(none)'}

External page HTML (truncated to <=25,000 chars):
${(input.externalHtml || '').slice(0, 25000) || '(none)'}

Answer in JSON only.`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0.2,
    response_format: { type: 'json_object' }
  });

  const raw = completion.choices[0].message.content || '{}';
  try {
    const parsed = JSON.parse(raw);
    return {
      qualifiesAsAffiliate: Boolean(parsed?.qualifiesAsAffiliate),
      reasoning: String(parsed?.reasoning || '')
    };
  } catch {
    return {
      qualifiesAsAffiliate: false,
      reasoning: 'Unable to parse model output'
    };
  }
}
