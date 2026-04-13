import { query } from '@anthropic-ai/claude-agent-sdk';

const SEARCH_QUERY = 'what was the email from Solina Quinton about';

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
  
  const seenIds = new Set<string>();
  const toolUsage: { [key: string]: number } = {};
  let totalCostUSD = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let cacheReadInputTokens = 0;
  let cacheCreationInputTokens = 0;
  
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
          const msgId = assistantMessage.message.id;
          
          if (!seenIds.has(msgId)) {
            seenIds.add(msgId);
            if (assistantMessage.message.usage) {
              totalInputTokens += assistantMessage.message.usage.input_tokens || 0;
              totalOutputTokens += assistantMessage.message.usage.output_tokens || 0;
              cacheReadInputTokens += assistantMessage.message.usage.cache_read_input_tokens || 0;
              cacheCreationInputTokens += assistantMessage.message.usage.cache_creation_input_tokens || 0;
            }
          }
          
          for (const block of assistantMessage.message.content) {
            if (block.type === 'text') {
              console.log(block.text);
            } else if (block.type === 'tool_use') {
              const icon = getToolIcon(block.name);
              const action = getToolAction(block.name);
              console.log(`${icon} ${block.name}: ${action}`);
              
              toolUsage[block.name] = (toolUsage[block.name] || 0) + 1;
            }
          }
        }
      } else if (message.type === 'result') {
        totalCostUSD += message.total_cost_usd || 0;
      }
    }
    
    console.log('\n────────────────────────────────────────────────────────────');
    console.log('📊 Usage Summary:');
    console.log(`   💰 Total cost: $${totalCostUSD.toFixed(4)}`);
    console.log(`   📥 Input tokens: ${totalInputTokens.toLocaleString()}`);
    console.log(`   📤 Output tokens: ${totalOutputTokens.toLocaleString()}`);
    
    if (cacheReadInputTokens > 0) {
      console.log(`   💾 Cache read tokens: ${cacheReadInputTokens.toLocaleString()}`);
    }
    if (cacheCreationInputTokens > 0) {
      console.log(`   💾 Cache creation tokens: ${cacheCreationInputTokens.toLocaleString()}`);
    }
    
    const totalToolCalls = Object.values(toolUsage).reduce((sum, count) => sum + count, 0);
    if (totalToolCalls > 0) {
      const toolBreakdown = Object.entries(toolUsage)
        .map(([name, count]) => `${name}: ${count}`)
        .join(', ');
      console.log(`   🔧 Tool calls: ${totalToolCalls} (${toolBreakdown})`);
    }
    console.log(`   📋 Conversation steps: ${seenIds.size}`);
  } catch (error) {
    console.error('❌ Error during search:', error);
    process.exit(1);
  }
}

main();
