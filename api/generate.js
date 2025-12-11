import { query } from '@anthropic-ai/claude-agent-sdk';

// System prompt for the app generator agent
const SYSTEM_PROMPT = `You are Dreamware, an expert app generator that creates beautiful, functional web applications.

When given an app description, you will:
1. First, briefly analyze what the user wants (1-2 sentences)
2. Then generate a complete, working HTML file with embedded CSS and JavaScript

IMPORTANT OUTPUT FORMAT:
- Start your code output with exactly: \`\`\`html
- End your code output with exactly: \`\`\`
- The code block must contain a complete, self-contained HTML file
- Include all CSS in a <style> tag
- Include all JavaScript in a <script> tag

DESIGN PRINCIPLES:
- Modern, clean UI with glassmorphism effects
- Smooth animations and transitions
- Mobile-responsive design
- Beautiful gradients and shadows
- Professional typography
- Dark mode friendly color schemes

TECHNICAL REQUIREMENTS:
- Pure HTML/CSS/JavaScript (no external dependencies)
- Self-contained in a single file
- Functional interactions where applicable
- Accessible and semantic HTML

Be creative and make the app visually stunning while being fully functional.`;

// Process messages from the agent and extract relevant content
function parseAgentMessage(message) {
  if (message.type === 'assistant' && message.message?.content) {
    const content = message.message.content;
    let text = '';

    for (const block of content) {
      if (block.type === 'text') {
        text += block.text;
      }
    }
    return text;
  }
  return null;
}

export const config = {
  maxDuration: 60, // Allow up to 60 seconds for generation
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { prompt } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: 'Prompt is required' });
  }

  // Set up SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Helper to send SSE events
  const sendEvent = (type, data) => {
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  };

  try {
    let fullResponse = '';
    let codeStarted = false;
    let codeContent = '';
    let lastAnalysisSent = '';

    sendEvent('status', { phase: 'connecting', message: 'Dreamware is waking up...' });

    // Start the agent query with streaming
    const agentQuery = query({
      prompt: `Create an app: ${prompt}`,
      options: {
        systemPrompt: SYSTEM_PROMPT,
        model: 'claude-sonnet-4-20250514',
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        maxTurns: 1,
        tools: [],
        includePartialMessages: true,
      }
    });

    sendEvent('status', { phase: 'thinking', message: 'Dreamware is dreaming...' });

    // Process streaming messages
    for await (const message of agentQuery) {
      // Handle streaming partial messages (real-time token streaming)
      if (message.type === 'stream_event') {
        const event = message.event;

        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          const newText = event.delta.text;
          fullResponse += newText;

          // Check if we've hit the code block
          if (fullResponse.includes('```html')) {
            if (!codeStarted) {
              codeStarted = true;
              sendEvent('code_start', {});
            }

            // Extract code content
            const codeMatch = fullResponse.match(/```html\n?([\s\S]*?)(?:```|$)/);
            if (codeMatch) {
              codeContent = codeMatch[1];
              sendEvent('code', { content: codeContent });
            }
          } else {
            // Still in analysis phase - send the text as it streams
            const currentAnalysis = fullResponse.trim();
            if (currentAnalysis !== lastAnalysisSent) {
              sendEvent('analysis', { content: currentAnalysis });
              lastAnalysisSent = currentAnalysis;
            }
          }
        }
      }
      // Handle complete assistant messages (fallback)
      else if (message.type === 'assistant') {
        const text = parseAgentMessage(message);
        if (text) {
          fullResponse = text;

          // Check for code block
          const codeMatch = fullResponse.match(/```html\n?([\s\S]*?)```/);
          if (codeMatch) {
            codeContent = codeMatch[1];
            if (!codeStarted) {
              codeStarted = true;
              sendEvent('code_start', {});
            }
            sendEvent('code', { content: codeContent });
          }

          // Send analysis text (before code block)
          const analysisMatch = fullResponse.match(/^([\s\S]*?)```html/);
          if (analysisMatch && analysisMatch[1].trim()) {
            sendEvent('analysis', { content: analysisMatch[1].trim() });
          }
        }
      }
      // Handle system init message
      else if (message.type === 'system' && message.subtype === 'init') {
        sendEvent('status', { phase: 'generating', message: 'Dreamware is imagining your app...' });
      }
      // Handle result
      else if (message.type === 'result') {
        sendEvent('complete', {
          code: codeContent,
          usage: message.usage,
          cost: message.total_cost_usd
        });
      }
    }

    res.end();
  } catch (error) {
    console.error('Generation error:', error);
    sendEvent('error', { message: error.message });
    res.end();
  }
}
