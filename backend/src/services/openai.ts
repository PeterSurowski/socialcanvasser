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
