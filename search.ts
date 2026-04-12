import { query } from '@anthropic-ai/claude-agent-sdk';

const SEARCH_PROMPT = `Search through the emails in the emails/ directory and find relevant information based on this query:

"What was the email from Alex Xu about?"

Please:
1. Use Glob to find all markdown files in the emails/ directory
2. Read the relevant email files
3. Use Grep to search for specific keywords if needed
4. Provide a comprehensive summary of your findings, including:
   - Email subjects
   - Senders
   - Dates
   - Key content relevant to the query
   - Any action items or deadlines mentioned

Be thorough and provide specific details from the emails you find.`;

async function main() {
  console.log('🤖 Starting Claude Agent SDK search...\n');
  
  try {
    for await (const message of query({
      prompt: SEARCH_PROMPT,
      options: {
        allowedTools: ['Read', 'Glob', 'Grep']
      }
    })) {
      if (message.type === 'system') {
        if ('result' in message) {
          console.log(message.result);
        }
      } else if (message.type === 'user') {
        if ('message' in message) {
          console.log(`[User]: ${JSON.stringify(message.message)}`);
        }
      } else if (message.type === 'assistant') {
        const assistantMessage = message as any;
        if (assistantMessage.message && assistantMessage.message.content) {
          for (const block of assistantMessage.message.content) {
            if (block.type === 'text') {
              console.log(block.text);
            } else if (block.type === 'tool_use') {
              console.log(`[Tool: ${block.name}]`);
              console.log(JSON.stringify(block.input, null, 2));
            } else if (block.type === 'tool_result') {
              console.log(`[Tool Result]`);
              if (typeof block.content === 'string') {
                console.log(block.content);
              } else {
                console.log(JSON.stringify(block.content, null, 2));
              }
            }
          }
        }
      } else if ('result' in message) {
        console.log(message.result);
      }
    }
    
    console.log('\n✅ Search completed successfully!');
  } catch (error) {
    console.error('❌ Error during search:', error);
    process.exit(1);
  }
}

main();
