import { query } from '@anthropic-ai/claude-agent-sdk';

const SEARCH_QUERY = 'What was the Browserbase Birthday email about?';

const SEARCH_PROMPT = `Search through the emails in the emails/ directory and find relevant information based on this query:

"${SEARCH_QUERY}"

Please:
1. Use Glob to find all markdown files in the emails/ directory
2. Read the relevant email files
3. Use Grep to search for specific keywords if needed
4. Provide your answer as plain, conversational text without ANY formatting

IMPORTANT: Do NOT use bold text, headers, bullet points, numbered lists, code blocks, or ANY markdown formatting. Write everything in plain, readable paragraphs. Just tell me what you found in a natural, conversational way.`;

function getToolIcon(toolName: string): string {
  const iconMap: { [key: string]: string } = {
    'Glob': '🔎',
    'Read': '📖',
    'Grep': '🔍',
    'Bash': '⚙️',
    'Write': '📝',
    'Edit': '✏️'
  };
  return iconMap[toolName] || '⚙️';
}

function getToolAction(toolName: string): string {
  const actionMap: { [key: string]: string } = {
    'Glob': 'Finding email files...',
    'Read': 'Reading email content...',
    'Grep': 'Searching content...',
    'Bash': 'Executing command...',
    'Write': 'Creating file...',
    'Edit': 'Modifying file...'
  };
  return actionMap[toolName] || 'Processing...';
}

async function main() {
  console.log(`🔍 Searching emails for: "${SEARCH_QUERY}"`);
  console.log('────────────────────────────────────────────────────────────\n');
  
  try {
    for await (const message of query({
      prompt: SEARCH_PROMPT,
      options: {
        allowedTools: ['Read', 'Glob', 'Grep']
      }
    })) {
      if (message.type === 'assistant') {
        const assistantMessage = message as any;
        if (assistantMessage.message && assistantMessage.message.content) {
          for (const block of assistantMessage.message.content) {
            if (block.type === 'text') {
              console.log(block.text);
            } else if (block.type === 'tool_use') {
              const icon = getToolIcon(block.name);
              const action = getToolAction(block.name);
              console.log(`${icon} ${block.name}: ${action}`);
            }
          }
        }
      }
    }
    
    console.log('\n────────────────────────────────────────────────────────────');
  } catch (error) {
    console.error('❌ Error during search:', error);
    process.exit(1);
  }
}

main();
